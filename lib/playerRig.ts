import {
  AnimationMixer,
  Color,
  DoubleSide,
  Group,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
  type AnimationAction,
  type AnimationClip,
  type Material,
} from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { BOOT_COLOUR } from "./kit.ts";
import {
  CROSSFADE_SECONDS,
  FACING_MIN_SPEED,
  blendYaw,
  gaitForSpeed,
  stepYaw,
  timeScaleForGait,
  yawForVelocity,
  type ForwardSign,
  type GaitName,
} from "./playerModel.ts";
import { classifyPart, type PlayerAppearance, type PlayerPart } from "./kit.ts";

const GAITS: readonly GaitName[] = ["idle", "jog", "run"];

/** How quickly the kick layer fades in and back out, seconds. */
const KICK_FADE_IN = 0.08;
const KICK_FADE_OUT = 0.18;

export interface RigClips {
  readonly idle: AnimationClip;
  readonly jog: AnimationClip;
  readonly run: AnimationClip;
  /** Null when the model has no kick and none could be generated. */
  readonly kick: AnimationClip | null;
  /**
   * True when the kick layers on top of the gait instead of replacing it.
   * Procedural kicks are additive; a real full-body Soccer Pass clip is not.
   */
  readonly kickIsAdditive: boolean;
}

export interface PlayerRig {
  /** Added to the scene; we drive its position and rotation.y directly. */
  readonly root: Group;
  readonly mixer: AnimationMixer;
  readonly actions: Readonly<Record<GaitName, AnimationAction>>;
  readonly kickAction: AnimationAction | null;
  readonly kickIsAdditive: boolean;
  readonly kickDuration: number;
  /** Which local axis this model calls forward; see detectForwardSign. */
  readonly forward: ForwardSign;
  /** Ground speed each locomotion clip depicts, metres per second. */
  readonly gaitSpeeds: Readonly<Record<GaitName, number>>;
  /** Gait currently selected, so the thresholds can carry hysteresis. */
  gait: GaitName;

  /** Current blend weights, parallel to GAITS. Mutated in place each frame. */
  readonly weights: Float32Array;
  yaw: number;
  yawInitialised: boolean;
  /** Seconds of kick still to play; drives the kick layer's weight. */
  kickRemaining: number;
  kickWeight: number;
  /** Yaw to face while striking, when the kick's direction is known. */
  kickYaw: number;
  kickYawValid: boolean;
  wasVisible: boolean;
}

/**
 * Build one rig from the shared GLTF scene.
 *
 * SkeletonUtils.clone gives each instance its own skeleton (needed for
 * independent poses) while keeping the geometry shared by reference. The
 * material is replaced with the caller's per-team instance, so 22 players cost
 * one geometry and two materials.
 */
export function createPlayerRig(
  source: Object3D,
  clips: RigClips,
  materialFor: (part: PlayerPart) => Material,
  scale: number,
  forward: ForwardSign,
  gaitSpeeds: Readonly<Record<GaitName, number>>,
): PlayerRig {
  const model = cloneSkeleton(source);
  model.scale.setScalar(scale);

  model.traverse((child: Object3D) => {
    if ((child as Mesh).isMesh || (child as SkinnedMesh).isSkinnedMesh) {
      const mesh = child as Mesh;
      // The character is modelled as one mesh per garment, so dressing it is
      // just a case of handing each mesh the right material.
      mesh.material = materialFor(classifyPart(mesh.name));
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // Skinned bounds are computed from the bind pose and go stale as the
      // player animates; culling per instance is not worth the popping.
      mesh.frustumCulled = false;
    }
  });

  const root = new Group();
  root.add(model);
  root.visible = false;

  const mixer = new AnimationMixer(model);

  const actions = {
    idle: mixer.clipAction(clips.idle),
    jog: mixer.clipAction(clips.jog),
    run: mixer.clipAction(clips.run),
  } as const;

  for (const gait of GAITS) {
    const action = actions[gait];
    action.enabled = true;
    action.setEffectiveWeight(gait === "idle" ? 1 : 0);
    action.play();
  }

  let kickAction: AnimationAction | null = null;
  let kickDuration = 0;
  if (clips.kick !== null) {
    kickAction = mixer.clipAction(clips.kick);
    kickAction.setLoop(LoopOnce, 1);
    kickAction.clampWhenFinished = true;
    kickAction.enabled = true;
    kickAction.setEffectiveWeight(0);
    kickDuration = clips.kick.duration;
  }

  const weights = new Float32Array(GAITS.length);
  weights[0] = 1;

  return {
    root,
    mixer,
    actions,
    kickAction,
    kickIsAdditive: clips.kickIsAdditive,
    kickDuration,
    forward,
    gaitSpeeds,
    gait: "idle",
    weights,
    yaw: 0,
    yawInitialised: false,
    kickRemaining: 0,
    kickWeight: 0,
    kickYaw: 0,
    kickYawValid: false,
    wasVisible: false,
  };
}

/**
 * Start the one-shot kick on this rig, restarting it if one is already running.
 *
 * `dirX`/`dirZ` is the world-space direction the ball is about to travel. When
 * it is known the player turns to face it for the duration of the strike, which
 * is what makes a pass read as deliberate rather than as a leg twitch while
 * running somewhere else. Pass (0, 0) to leave facing on the velocity.
 */
export function fireKick(rig: PlayerRig, dirX: number, dirZ: number): void {
  if (rig.kickAction === null) return;
  rig.kickAction.reset();
  rig.kickAction.setLoop(LoopOnce, 1);
  rig.kickAction.clampWhenFinished = true;
  rig.kickAction.play();
  rig.kickRemaining = rig.kickDuration;

  if (Math.hypot(dirX, dirZ) > 1e-6) {
    rig.kickYaw = yawForVelocity(dirX, dirZ, rig.forward);
    rig.kickYawValid = true;
  } else {
    rig.kickYawValid = false;
  }
}

/**
 * Advance one rig. Called 22 times per render frame, so it allocates nothing
 * and touches no Vector3/Quaternion temporaries.
 *
 * `dt` is the real render delta and smooths facing and gait blending, so those
 * keep settling while the replay is paused. `animDt` is zero when paused, which
 * freezes the mixer and the kick countdown instead of letting a stopped player
 * keep running on the spot.
 *
 * `vx`/`vz` are world-space velocity in metres per second; `speedScale` is the
 * playback rate so that animation keeps pace when the replay is not at 1x.
 */
export function updatePlayerRig(
  rig: PlayerRig,
  dt: number,
  animDt: number,
  visible: boolean,
  x: number,
  z: number,
  vx: number,
  vz: number,
  speedScale: number,
): void {
  if (!visible) {
    if (rig.wasVisible) {
      rig.root.visible = false;
      rig.wasVisible = false;
      // Forget the facing so a re-entry does not swing round from a stale yaw.
      rig.yawInitialised = false;
    }
    return;
  }

  rig.root.position.set(x, 0, z);
  rig.root.visible = true;
  rig.wasVisible = true;

  const speed = Math.hypot(vx, vz);

  // --- kick envelope --------------------------------------------------
  // Updated before facing, which reads kickWeight to decide where to look.
  if (rig.kickRemaining > 0) {
    rig.kickRemaining -= animDt;
  }
  const kickTarget = rig.kickRemaining > 0 ? 1 : 0;
  const kickRate = kickTarget > rig.kickWeight ? KICK_FADE_IN : KICK_FADE_OUT;
  rig.kickWeight += (kickTarget - rig.kickWeight) * (dt <= 0 ? 1 : Math.min(1, dt / kickRate));

  // --- facing ---------------------------------------------------------
  const moving = speed > FACING_MIN_SPEED;
  const travelYaw = moving ? yawForVelocity(vx, vz, rig.forward) : rig.yaw;

  // While striking, turn toward where the ball is going, fading back to the
  // direction of travel as the kick finishes. A stationary player still turns:
  // the speed threshold only governs the travel-derived facing.
  let target: number | null = moving ? travelYaw : null;
  if (rig.kickYawValid && rig.kickWeight > 0.005) {
    target = blendYaw(travelYaw, rig.kickYaw, rig.kickWeight);
  }

  if (target !== null) {
    if (!rig.yawInitialised) {
      rig.yaw = target;
      rig.yawInitialised = true;
    } else {
      rig.yaw = stepYaw(rig.yaw, target, dt);
    }
  } else if (!rig.yawInitialised) {
    // Standing still and never seen moving: pick something rather than 0 drift.
    rig.yawInitialised = true;
  }
  rig.root.rotation.y = rig.yaw;

  // --- gait blend -----------------------------------------------------
  const gait = gaitForSpeed(speed, rig.gait);
  rig.gait = gait;
  const blend = dt <= 0 ? 1 : Math.min(1, dt / CROSSFADE_SECONDS);
  let total = 0;
  for (let i = 0; i < GAITS.length; i += 1) {
    const wanted = GAITS[i] === gait ? 1 : 0;
    let next = rig.weights[i]! + (wanted - rig.weights[i]!) * blend;
    // The lerp only approaches its target, so without this a settled player
    // keeps a sliver of the other clip mixed in for ever and never stops
    // sliding. Snap once the remainder is below what the eye could see.
    if (Math.abs(next - wanted) < 0.02) next = wanted;
    rig.weights[i] = next;
    total += next;
  }

  // A full-body kick replaces the gait; an additive one rides on top of it.
  const gaitScale = rig.kickIsAdditive ? 1 : 1 - rig.kickWeight;
  const normalise = total > 1e-5 ? gaitScale / total : 0;

  // Each clip plays at the rate that makes its own stride cover the ground
  // being tracked, which is what keeps a planted foot still.
  //
  // Two clips cannot both do that and stay in step, because their strides are
  // different lengths, so a crossfade always slides somewhat. Driving them
  // from a shared stride phase was tried and measured no better than this, so
  // it is not worth the machinery; spending less time blended, via the
  // hysteresis in gaitForSpeed, is what actually helps.
  for (let i = 0; i < GAITS.length; i += 1) {
    const name = GAITS[i]!;
    const action = rig.actions[name];
    action.setEffectiveWeight(rig.weights[i]! * normalise);
    action.setEffectiveTimeScale(
      timeScaleForGait(name, speed, rig.gaitSpeeds[name]) * speedScale,
    );
  }

  if (rig.kickAction !== null) {
    rig.kickAction.setEffectiveWeight(rig.kickWeight);
    rig.kickAction.setEffectiveTimeScale(speedScale);
  }

  rig.mixer.update(animDt);
}

/**
 * Builds and shares the materials that dress a player.
 *
 * Materials are cached by part and colour, so the 22 players on the pitch are
 * covered by about twenty materials rather than 154. This costs no extra draw
 * calls either way: the garments are already separate meshes, and so were
 * already separate draws.
 */
export class PlayerMaterials {
  private readonly cache = new Map<string, Material>();
  private readonly skinBase: MeshStandardMaterial;
  private readonly hairBase: MeshStandardMaterial;

  constructor(source: Object3D) {
    let skin: MeshStandardMaterial | null = null;
    let hair: MeshStandardMaterial | null = null;

    source.traverse((child: Object3D) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!(material instanceof MeshStandardMaterial)) return;
      const part = classifyPart(mesh.name);
      if (part === "skin" && skin === null) skin = material;
      if (part === "hair" && hair === null) hair = material;
    });

    this.skinBase = skin ?? new MeshStandardMaterial();
    this.hairBase = hair ?? this.skinBase;
  }

  /** Material resolver for one player's look. */
  resolver(appearance: PlayerAppearance): (part: PlayerPart) => Material {
    return (part) => this.get(part, appearance);
  }

  private get(part: PlayerPart, appearance: PlayerAppearance): Material {
    const colour = this.colourFor(part, appearance);
    const key = `${part}:${colour}`;
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;

    const material = this.build(part, colour);
    this.cache.set(key, material);
    return material;
  }

  private colourFor(part: PlayerPart, appearance: PlayerAppearance): string {
    switch (part) {
      case "shirt":
        return appearance.kit.shirt;
      case "shorts":
        return appearance.kit.shorts;
      case "socks":
        return appearance.kit.socks;
      case "boots":
        return BOOT_COLOUR;
      case "hair":
        return appearance.hair;
      case "skin":
        return appearance.skin;
    }
  }

  private build(part: PlayerPart, colour: string): Material {
    if (part === "hair") {
      const material = this.hairBase.clone();
      material.color = new Color(colour);
      // The hair is built from overlapping cards cut out by the map's alpha.
      // Alpha testing rather than blending keeps 22 heads from needing to be
      // depth sorted against each other every frame.
      material.transparent = false;
      material.alphaTest = 0.5;
      material.depthWrite = true;
      material.side = DoubleSide;
      material.roughness = 0.85;
      material.metalness = 0;
      return material;
    }

    const material = this.skinBase.clone();
    material.color = new Color(colour);
    material.metalness = 0;

    if (part === "skin") {
      // Keep the body atlas: it carries the face. The tint multiplies it.
      material.roughness = 0.8;
      return material;
    }

    // Garments are flat colour. Their half of the atlas is the character's own
    // clothing design, which has nothing to do with a football kit.
    material.map = null;
    material.roughness = part === "boots" ? 0.45 : 0.78;
    return material;
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
  }
}

export function disposePlayerRig(rig: PlayerRig): void {
  rig.mixer.stopAllAction();
  rig.mixer.uncacheRoot(rig.mixer.getRoot() as Object3D);
  rig.root.clear();
}
