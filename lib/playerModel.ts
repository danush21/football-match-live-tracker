import {
  AdditiveAnimationBlendMode,
  AnimationClip,
  AnimationMixer,
  AnimationUtils,
  Box3,
  InterpolateSmooth,
  Matrix4,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  Euler,
} from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

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
 * Fallback ground speeds for the locomotion clips, metres per second.
 *
 * Only used when measureClipGroundSpeed cannot read the real figure off the
 * clip. Guessing these is what caused visible foot skating: the stand-in's
 * clips actually depict 1.65 and 2.76 m/s, not the 2.2 and 5.4 assumed here
 * before, so the run cycle was playing at roughly half the rate the ground
 * speed demanded.
 */
export const DEFAULT_JOG_SPEED = 2.2;
export const DEFAULT_RUN_SPEED = 5.4;

/**
 * Playback rate limits. Deliberately wide: locking the feet to the ground
 * matters more than keeping leg turnover pretty, and the bands each clip has
 * to cover are wide (0.5 to 4 m/s for a jog). A slow walk really should play
 * in slow motion, because the player really is moving that slowly.
 */
export const TIME_SCALE_MIN = 0.25;
export const TIME_SCALE_MAX = 3;

/**
 * Fallback for where in the kick clip the foot meets the ball, as a fraction
 * of its length. Only used when measureKickContact cannot read it off the rig.
 * The one-shot is fired this far ahead of the event so the strike lands on the
 * frame the pass actually happens rather than a beat after it.
 */
export const DEFAULT_KICK_CONTACT_FRACTION = 0.45;

/** Below this the player holds its previous facing rather than spinning. */
export const FACING_MIN_SPEED = 0.5;
/** Time for the yaw to close half the gap to its target, seconds. */
export const YAW_HALF_LIFE = 0.085;

/** Every rig is scaled so it stands this tall, whatever units the model uses. */
export const TARGET_HEIGHT_METRES = 1.8;

/**
 * Which local axis the model treats as forward: +1 for +Z, -1 for -Z.
 *
 * Mixamo characters come through glTF facing -Z, so this is the usual answer,
 * but it is measured per model by detectForwardSign rather than assumed --
 * getting it wrong rotates every player 180 degrees and they all run backwards.
 */
export type ForwardSign = 1 | -1;
export const DEFAULT_FORWARD_SIGN: ForwardSign = -1;

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
 * Remove root travel so the clip animates on the spot, keeping everything else.
 *
 * Positions come from the tracking data, so travel baked into a clip would
 * fight it. But only the *drift* is removed, never the per-stride sway and
 * bounce -- an earlier version zeroed two fixed axes and flattened the hips'
 * vertical bob, which made every stride glide.
 *
 * The vertical axis is detected rather than assumed: this rig is authored
 * Z-up, so its hip height lives in the Z channel, not Y. Whichever channel
 * carries the large constant offset (hip height above the floor) is up, and
 * the other two are horizontal. A clip already exported in place has no net
 * drift and is left completely untouched.
 */
export function makeInPlace(clip: AnimationClip): AnimationClip {
  const out = clip.clone();
  for (const track of out.tracks) {
    if (!track.name.endsWith(".position")) continue;
    if (!/hips|root|armature/i.test(track.name)) continue;

    const values = track.values as Float32Array;
    const times = track.times as Float32Array;
    const count = Math.floor(values.length / 3);
    if (count < 2 || times.length < 2) continue;

    // Vertical axis = the one with the largest mean magnitude (hip height).
    let up = 0;
    let upMean = -1;
    for (let axis = 0; axis < 3; axis += 1) {
      let sum = 0;
      for (let i = 0; i < count; i += 1) sum += Math.abs(values[i * 3 + axis]!);
      const mean = sum / count;
      if (mean > upMean) {
        upMean = mean;
        up = axis;
      }
    }

    const span = times[times.length - 1]! - times[0]!;
    if (span <= 0) continue;

    for (let axis = 0; axis < 3; axis += 1) {
      if (axis === up) continue;
      const first = values[axis]!;
      const net = values[(count - 1) * 3 + axis]! - first;
      // Already in place on this axis: leave its sway alone.
      if (Math.abs(net) < 1e-3 * Math.max(1, upMean)) continue;
      // Subtract only the linear drift, keyed on time so uneven spacing is fine.
      for (let i = 0; i < count; i += 1) {
        const progress = (times[i]! - times[0]!) / span;
        values[i * 3 + axis] = values[i * 3 + axis]! - net * progress;
      }
    }
  }
  return out;
}

/**
 * Measure the ground speed a locomotion clip actually depicts, in metres per
 * second, so playback can be scaled to match the tracked speed.
 *
 * These clips carry no root motion, so there is no travel to read off. Instead
 * this uses the fact that in an in-place clip the planted foot slides backwards
 * at exactly the speed the character is meant to be moving. Sample the cycle,
 * take the foot that is currently lowest as the planted one, and take the
 * median of its horizontal speed over the stance phase -- median rather than
 * mean so heel strike and toe off do not skew it.
 *
 * Returns null if the rig has no recognisable feet or the reading is
 * implausible, in which case the caller keeps its default.
 */
export function measureClipGroundSpeed(
  scene: Object3D,
  clip: AnimationClip,
  scale: number,
): number | null {
  const model = cloneSkeleton(scene);
  model.scale.setScalar(scale);

  const feet = [findBone(model, "leftfoot"), findBone(model, "rightfoot")];
  if (feet[0] === null || feet[1] === null) return null;

  const mixer = new AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.setEffectiveWeight(1);
  action.play();

  const SAMPLES = 96;
  const dt = clip.duration / SAMPLES;
  if (!(dt > 0)) return null;

  const x: number[][] = [[], []];
  const y: number[][] = [[], []];
  const z: number[][] = [[], []];

  for (let i = 0; i <= SAMPLES; i += 1) {
    mixer.update(i === 0 ? 0 : dt);
    model.updateMatrixWorld(true);
    for (let f = 0; f < 2; f += 1) {
      const e = feet[f]!.matrixWorld.elements;
      x[f]!.push(e[12]!);
      y[f]!.push(e[13]!);
      z[f]!.push(e[14]!);
    }
  }

  const stanceSpeeds: number[] = [];
  for (let f = 0; f < 2; f += 1) {
    const heights = y[f]!;
    const low = Math.min(...heights);
    const high = Math.max(...heights);
    // The bottom third of the foot's travel counts as planted.
    const threshold = low + (high - low) * 0.33;
    for (let i = 1; i < heights.length; i += 1) {
      if (heights[i]! > threshold) continue;
      const dx = x[f]![i]! - x[f]![i - 1]!;
      const dz = z[f]![i]! - z[f]![i - 1]!;
      stanceSpeeds.push(Math.hypot(dx, dz) / dt);
    }
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(model);

  if (stanceSpeeds.length < 4) return null;
  stanceSpeeds.sort((a, b) => a - b);
  const median = stanceSpeeds[Math.floor(stanceSpeeds.length / 2)]!;

  // A human locomotion clip lives between a shuffle and a sprint.
  if (!Number.isFinite(median) || median < 0.2 || median > 12) return null;
  return median;
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

/**
 * Yaw that points the model's forward axis along a world-space velocity.
 *
 * Rotating by yaw about Y maps local +Z to (sin yaw, cos yaw). For a model
 * whose forward is +Z that means yaw = atan2(vx, vz); for one facing -Z the
 * forward maps to (-sin yaw, -cos yaw), so yaw picks up a half turn.
 */
export function yawForVelocity(vx: number, vz: number, forward: ForwardSign): number {
  const yaw = Math.atan2(vx, vz);
  return forward === 1 ? yaw : yaw + Math.PI;
}

/** Move a fraction `t` along the shortest arc from `from` to `to`. */
export function blendYaw(from: number, to: number, t: number): number {
  const delta = to - from;
  const shortest = Math.atan2(Math.sin(delta), Math.cos(delta));
  return from + shortest * t;
}

/**
 * Find where in a kick clip the foot actually meets the ball, as a fraction of
 * the clip's length.
 *
 * Contact is the instant the kicking foot is travelling forward fastest. Note
 * *forward*, not fastest overall: the quickest the foot ever moves is usually
 * the recovery swing back down afterwards, so taking raw speed puts contact at
 * the end of the clip and every kick lands late. The foot's motion is projected
 * onto the body's own forward axis, taken from the shoulders because they stay
 * put through a stride while the feet do not.
 *
 * Returns null if the rig is unrecognisable or the clip has no clear forward
 * swing, in which case the caller keeps its default.
 */
export function measureKickContact(
  scene: Object3D,
  clip: AnimationClip,
  scale: number,
): number | null {
  const model = cloneSkeleton(scene);
  model.scale.setScalar(scale);

  const hips = findBone(model, "hips");
  const leftArm = findBone(model, "leftarm");
  const rightArm = findBone(model, "rightarm");
  const feet = [findBone(model, "leftfoot"), findBone(model, "rightfoot")];
  if (hips === null || leftArm === null || rightArm === null) return null;
  if (feet[0] === null || feet[1] === null) return null;

  const mixer = new AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.setEffectiveWeight(1);
  action.play();

  const SAMPLES = 72;
  const dt = clip.duration / SAMPLES;
  if (!(dt > 0)) return null;

  const forwardOffset = [new Float64Array(SAMPLES + 1), new Float64Array(SAMPLES + 1)];

  for (let i = 0; i <= SAMPLES; i += 1) {
    mixer.update(i === 0 ? 0 : dt);
    model.updateMatrixWorld(true);

    const h = hips.matrixWorld.elements;
    const la = leftArm.matrixWorld.elements;
    const ra = rightArm.matrixWorld.elements;
    // Body forward = left x up, with left running from the right arm to the left.
    const leftX = la[12]! - ra[12]!;
    const leftZ = la[14]! - ra[14]!;
    const fx = -leftZ;
    const fz = leftX;
    const flen = Math.hypot(fx, fz);
    if (flen < 1e-6) continue;

    for (let f = 0; f < 2; f += 1) {
      const e = feet[f]!.matrixWorld.elements;
      forwardOffset[f]![i] = ((e[12]! - h[12]!) * fx + (e[14]! - h[14]!) * fz) / flen;
    }
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(model);

  let bestVelocity = 0;
  let bestIndex = -1;
  for (let f = 0; f < 2; f += 1) {
    const track = forwardOffset[f]!;
    for (let i = 1; i <= SAMPLES; i += 1) {
      const velocity = (track[i]! - track[i - 1]!) / dt;
      if (velocity > bestVelocity) {
        bestVelocity = velocity;
        bestIndex = i;
      }
    }
  }

  // A real strike swings the foot forward hard; anything slower is not a kick.
  if (bestIndex < 0 || bestVelocity < 1.5) return null;
  const fraction = bestIndex / SAMPLES;
  if (fraction <= 0.02 || fraction >= 0.98) return null;
  return fraction;
}

/**
 * Work out which way a rigged humanoid faces by measuring heel to toe.
 *
 * Called once on the loader's scene, which is still in its bind pose, so the
 * feet point straight ahead. Falls back to the Mixamo norm if the rig is not
 * recognisable, and the result is logged in development so a model swap that
 * measures oddly is visible rather than silently backwards.
 */
export function detectForwardSign(root: Object3D): ForwardSign {
  const foot = findBone(root, "leftfoot");
  const toe = findBone(root, "lefttoeend") ?? findBone(root, "lefttoebase");
  if (foot === null || toe === null) return DEFAULT_FORWARD_SIGN;

  root.updateMatrixWorld(true);
  const toLocal = new Matrix4().copy(root.matrixWorld).invert();
  const a = new Vector3().setFromMatrixPosition(foot.matrixWorld).applyMatrix4(toLocal);
  const b = new Vector3().setFromMatrixPosition(toe.matrixWorld).applyMatrix4(toLocal);
  const dz = b.z - a.z;

  // A near-zero reading means the feet are not pointing along Z at all; trust
  // the default rather than a coin flip.
  if (Math.abs(dz) < 1e-4) return DEFAULT_FORWARD_SIGN;
  return dz > 0 ? 1 : -1;
}

/** Which gait a speed maps to. */
export function gaitForSpeed(speed: number): GaitName {
  if (speed < GAIT_IDLE_MAX) return "idle";
  if (speed <= GAIT_JOG_MAX) return "jog";
  return "run";
}

/**
 * Playback rate for a gait so stride length tracks ground speed.
 *
 * `referenceSpeed` is the ground speed the clip itself depicts, measured by
 * measureClipGroundSpeed. Playing it at speed / reference makes one stride
 * cover exactly the distance the player travels, which is what stops the feet
 * sliding.
 */
export function timeScaleForGait(
  gait: GaitName,
  speed: number,
  referenceSpeed: number,
): number {
  if (gait === "idle") return 1;
  if (!(referenceSpeed > 0)) return 1;
  const raw = speed / referenceSpeed;
  return Math.min(TIME_SCALE_MAX, Math.max(TIME_SCALE_MIN, raw));
}
