import {
  AdditiveAnimationBlendMode,
  AnimationClip,
  AnimationUtils,
  Box3,
  InterpolateSmooth,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  Euler,
} from "three";

/**
 * Model-facing configuration and clip preparation.
 *
 * Everything here is written against a Mixamo-style rig (bones named
 * `mixamorig:*`) so that swapping public/models/player.glb for a real Mixamo
 * export needs no code change. See public/models/SOURCE.md.
 */

/** Speed thresholds, metres/second, from the brief. */
export const GAIT_IDLE_MAX = 0.5;
export const GAIT_JOG_MAX = 4;

/** Crossfade length between gaits, seconds. */
export const CROSSFADE_SECONDS = 0.2;

/**
 * Roughly how fast each locomotion clip looks "natural" at timeScale 1.
 * Clip playback is scaled by speed / reference so the feet do not skate.
 * These depend on the model and are the first thing to retune after a swap.
 */
export const JOG_REFERENCE_SPEED = 2.2;
export const RUN_REFERENCE_SPEED = 5.4;
export const TIME_SCALE_MIN = 0.55;
export const TIME_SCALE_MAX = 1.9;

/** Below this the player holds its previous facing rather than spinning. */
export const FACING_MIN_SPEED = 0.5;
/** Time for the yaw to close half the gap to its target, seconds. */
export const YAW_HALF_LIFE = 0.085;

/** Every rig is scaled so it stands this tall, whatever units the model uses. */
export const TARGET_HEIGHT_METRES = 1.8;

/**
 * Yaw added after atan2(vx, vz) to account for which way the model faces in
 * its bind pose. Mixamo characters face +Z, which atan2(x, z) already targets.
 */
export const MODEL_YAW_OFFSET = 0;

/** Clip names to look for, in order. Covers the stand-in and Mixamo naming. */
export const CLIP_CANDIDATES = {
  idle: ["idle", "breathing idle", "standing idle"],
  jog: ["jogging", "jog forward", "jog", "walking", "walk"],
  run: ["running", "run forward", "fast run", "run"],
  kick: ["soccer pass", "soccerpass", "pass", "kick", "shoot", "soccer"],
} as const;

export type GaitName = "idle" | "jog" | "run";

/** Case-insensitive, longest-match-first lookup so "run" does not eat "running". */
export function resolveClip(
  clips: readonly AnimationClip[],
  candidates: readonly string[],
): AnimationClip | null {
  for (const candidate of candidates) {
    const exact = clips.find((c) => c.name.toLowerCase() === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const partial = clips.find((c) => c.name.toLowerCase().includes(candidate));
    if (partial) return partial;
  }
  return null;
}

/**
 * Strip horizontal root motion so the clip animates on the spot.
 *
 * Positions come from the tracking data, so any translation baked into the
 * clip would fight it and make the player drift. The vertical component is
 * kept: that is the gait's bob, not travel.
 */
export function makeInPlace(clip: AnimationClip): AnimationClip {
  const out = clip.clone();
  for (const track of out.tracks) {
    if (!track.name.endsWith(".position")) continue;
    if (!/hips|root|armature/i.test(track.name)) continue;
    const values = track.values as Float32Array;
    if (values.length < 3) continue;
    const x = values[0]!;
    const z = values[2]!;
    for (let i = 0; i < values.length; i += 3) {
      values[i] = x;
      values[i + 2] = z;
    }
  }
  return out;
}

/**
 * Bones the procedural kick drives, as normalised name suffixes.
 *
 * Not literal names: GLTFLoader runs node names through
 * PropertyBinding.sanitizeNodeName, which strips `[ ] . : /`, so Mixamo's
 * `mixamorig:RightUpLeg` arrives as `mixamorigRightUpLeg`. Matching on a
 * normalised suffix also survives the `mixamorig1:` prefix some exports use.
 */
const KICK_BONE_SUFFIXES = {
  upLeg: "rightupleg",
  lowLeg: "rightleg",
  spine: "spine",
} as const;

const normaliseBoneName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Find a bone whose normalised name ends with `suffix` (so "spine" != "spine1"). */
export function findBone(root: Object3D, suffix: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((child: Object3D) => {
    if (found === null && child.name && normaliseBoneName(child.name).endsWith(suffix)) {
      found = child;
    }
  });
  return found;
}

function quaternionTrack(
  boneName: string,
  times: readonly number[],
  eulers: readonly Euler[],
): QuaternionKeyframeTrack {
  const values = new Float32Array(times.length * 4);
  const q = new Quaternion();
  eulers.forEach((euler, i) => {
    q.setFromEuler(euler);
    values[i * 4] = q.x;
    values[i * 4 + 1] = q.y;
    values[i * 4 + 2] = q.z;
    values[i * 4 + 3] = q.w;
  });
  return new QuaternionKeyframeTrack(
    `${boneName}.quaternion`,
    Array.from(times),
    Array.from(values),
    InterpolateSmooth,
  );
}

/**
 * Build a short kick as an ADDITIVE clip: back swing, strike, follow through.
 *
 * Used only when the model has no Soccer Pass clip of its own. Authoring it
 * additively means it layers on top of whatever gait is playing instead of
 * replacing the whole body, which a partial-bone absolute clip cannot do.
 * Every keyframe is a delta from identity at t=0, so makeClipAdditive leaves
 * the values alone and simply marks the blend mode.
 */
export function buildProceduralKickClip(rootScene: Object3D): AnimationClip | null {
  const upLeg = findBone(rootScene, KICK_BONE_SUFFIXES.upLeg);
  const lowLeg = findBone(rootScene, KICK_BONE_SUFFIXES.lowLeg);
  const spine = findBone(rootScene, KICK_BONE_SUFFIXES.spine);

  if (upLeg === null || lowLeg === null) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[playerModel] no right-leg bones found, so no kick animation. " +
          "Expected a Mixamo-style rig; supply a model with a Soccer Pass clip instead.",
      );
    }
    return null;
  }

  const e = (x: number, y: number, z: number): Euler => new Euler(x, y, z, "XYZ");

  const times = [0, 0.16, 0.3, 0.42, 0.62];
  const tracks = [
    // Hip: cock the leg back, drive it through, settle.
    quaternionTrack(upLeg.name, times, [
      e(0, 0, 0),
      e(-0.55, 0, 0),
      e(0.75, 0, 0),
      e(0.45, 0, 0),
      e(0, 0, 0),
    ]),
    // Knee: bend on the backswing, extend through contact.
    quaternionTrack(lowLeg.name, times, [
      e(0, 0, 0),
      e(0.85, 0, 0),
      e(0.1, 0, 0),
      e(0.3, 0, 0),
      e(0, 0, 0),
    ]),
  ];

  // Torso counter-rotation so it does not look like only a leg moved.
  if (spine !== null) {
    tracks.push(
      quaternionTrack(spine.name, times, [
        e(0, 0, 0),
        e(0.1, -0.12, 0),
        e(-0.08, 0.1, 0),
        e(-0.04, 0.05, 0),
        e(0, 0, 0),
      ]),
    );
  }

  const clip = new AnimationClip("ProceduralKick", 0.62, tracks);
  AnimationUtils.makeClipAdditive(clip);
  clip.blendMode = AdditiveAnimationBlendMode;
  return clip;
}

/**
 * Uniform scale that makes the model stand TARGET_HEIGHT_METRES tall.
 *
 * Measure the loader's scene, once, not a fresh clone. Box3.setFromObject
 * multiplies each mesh's geometry bounding box by its matrixWorld, but a
 * SkinnedMesh's geometry box is in bind space, so on a detached clone whose
 * world matrices have not settled the rig transform gets counted twice and the
 * rotation not at all -- the stand-in measured 0.0044 m instead of 1.83 m.
 * Updating the matrices first and measuring the posed source avoids that.
 */
export function fitScale(object: Object3D): number {
  object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const height = size.y;

  // A human-ish model is between a few centimetres and a few hundred units
  // tall depending on units. Anything outside that means the measurement is
  // not trustworthy, so leave the model at its authored size.
  if (!Number.isFinite(height) || height < 0.05 || height > 1000) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        `[playerModel] implausible model height ${height}; leaving scale at 1. ` +
          `Check that public/models/player.glb is a single rigged character.`,
      );
    }
    return 1;
  }
  return TARGET_HEIGHT_METRES / height;
}

/**
 * Advance a yaw toward its target along the shortest arc.
 *
 * Framerate independent: `dt / YAW_HALF_LIFE` half-lives are closed each call,
 * so the turn looks the same at 30fps and 144fps. Wrapping is handled by
 * re-normalising the delta through atan2 rather than branching on it, so a
 * player turning 10 degrees never spins 350 the other way.
 */
export function stepYaw(current: number, target: number, dt: number): number {
  const delta = target - current;
  const shortest = Math.atan2(Math.sin(delta), Math.cos(delta));
  if (dt <= 0) return current;
  const k = 1 - Math.pow(0.5, dt / YAW_HALF_LIFE);
  return current + shortest * k;
}

/** Yaw that points the model's forward axis along a world-space velocity. */
export function yawForVelocity(vx: number, vz: number): number {
  return Math.atan2(vx, vz) + MODEL_YAW_OFFSET;
}

/** Which gait a speed maps to. */
export function gaitForSpeed(speed: number): GaitName {
  if (speed < GAIT_IDLE_MAX) return "idle";
  if (speed <= GAIT_JOG_MAX) return "jog";
  return "run";
}

/** Playback rate for a gait so stride length tracks ground speed. */
export function timeScaleForGait(gait: GaitName, speed: number): number {
  if (gait === "idle") return 1;
  const reference = gait === "jog" ? JOG_REFERENCE_SPEED : RUN_REFERENCE_SPEED;
  const raw = speed / reference;
  return Math.min(TIME_SCALE_MAX, Math.max(TIME_SCALE_MIN, raw));
}
