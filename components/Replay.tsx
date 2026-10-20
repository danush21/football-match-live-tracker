"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Vector3 } from "three";
import type { AnimationClip, Mesh, PerspectiveCamera } from "three";
import {
  CLIP_CANDIDATES,
  DEFAULT_JOG_SPEED,
  DEFAULT_RUN_SPEED,
  DEFAULT_KICK_CONTACT_FRACTION,
  buildProceduralKickClip,
  detectForwardSign,
  fitScale,
  measureClipGroundSpeed,
  measureKickContact,
  makeInPlace,
  resolveClip,
} from "@/lib/playerModel";
import {
  createPlayerRig,
  PlayerMaterials,
  disposePlayerRig,
  fireKick,
  updatePlayerRig,
  type PlayerRig,
  type RigClips,
} from "@/lib/playerRig";
import { BALL_RADIUS, ballScaleForDistance } from "@/lib/ball";
import { appearanceFor, detectGoalkeepers } from "@/lib/kit";
import { applyCameraPreset, followBall, type CameraMode, type OrbitLike } from "@/lib/cameraPresets";
import { FrameSampler } from "@/lib/sampler";
import { usePlayback } from "@/lib/store";
import type { MatchData } from "@/lib/types";

export const MODEL_URL = "/models/player.glb";


/** Longest step the clock will take in one render frame (tab-switch guard). */
const MAX_DELTA = 0.1;
/** How often the render clock is mirrored into React state, seconds. */
const DISPLAY_INTERVAL = 0.1;
/**
 * If the frame index advances by more than this in one render frame it was a
 * seek, not playback, so pending kicks are skipped rather than all fired at once.
 */
const MAX_FIRE_SPAN = 60;

/** Event types that should trigger the kick animation. */
const KICK_TYPES = new Set(["PASS", "SHOT"]);

/** Shortest ball travel that counts as a direction rather than a wobble. */
const MIN_KICK_TRAVEL_METRES = 1;

interface KickCue {
  /**
   * Blob index at which to start the animation. Earlier than the event itself
   * by the clip's run-up, so the foot meets the ball on the event frame.
   */
  readonly fireAt: number;
  /** Position of the acting player in the rig array. */
  readonly rig: number;
  /** World-space direction the ball is about to travel; (0, 0) when unknown. */
  readonly dirX: number;
  readonly dirZ: number;
}

/** First cue that should not have fired by `index`. */
function cueUpperBound(cues: readonly KickCue[], index: number): number {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.fireAt <= index) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function Replay({ match }: { match: MatchData }): React.JSX.Element {
  const sampler = useMemo(() => new FrameSampler(match), [match]);
  const { scene, animations } = useGLTF(MODEL_URL);

  // --- clips ------------------------------------------------------------
  const clips: RigClips = useMemo(() => {
    const pick = (key: keyof typeof CLIP_CANDIDATES): AnimationClip | null =>
      resolveClip(animations, CLIP_CANDIDATES[key]);

    const idle = pick("idle");
    const jog = pick("jog");
    const run = pick("run");
    if (idle === null || jog === null || run === null) {
      const missing = [
        idle === null ? "idle" : null,
        jog === null ? "jog" : null,
        run === null ? "run" : null,
      ].filter(Boolean);
      throw new Error(
        `${MODEL_URL} has no clip for ${missing.join(", ")}. ` +
          `Available: ${animations.map((a) => a.name).join(", ") || "(none)"}`,
      );
    }

    const realKick = pick("kick");
    const kick = realKick !== null ? makeInPlace(realKick) : buildProceduralKickClip(scene);

    return {
      idle: makeInPlace(idle),
      jog: makeInPlace(jog),
      run: makeInPlace(run),
      kick,
      kickIsAdditive: realKick === null,
    };
  }, [animations, scene]);

  // --- rigs -------------------------------------------------------------
  /** Derived from where players stand; the source data has no positions. */
  const keepers = useMemo(() => detectGoalkeepers(match), [match]);

  const materials = useMemo(() => new PlayerMaterials(scene), [scene]);
  useEffect(() => () => materials.dispose(), [materials]);

  const rigs: readonly PlayerRig[] = useMemo(() => {
    // All measured once on the loader's scene, which is still in its bind
    // pose; see fitScale for why this cannot be done per clone.
    const scale = fitScale(scene);
    const forward = detectForwardSign(scene);

    // Read the ground speed each clip depicts rather than guessing it, so
    // playback rate can be matched to the tracked speed and the feet stay put.
    const gaitSpeeds = {
      idle: 1,
      jog: measureClipGroundSpeed(scene, clips.jog, scale) ?? DEFAULT_JOG_SPEED,
      run: measureClipGroundSpeed(scene, clips.run, scale) ?? DEFAULT_RUN_SPEED,
    } as const;

    return match.meta.players.map((p) =>
      createPlayerRig(
        scene,
        clips,
        materials.resolver(appearanceFor(p.id, p.team, keepers.has(p.id))),
        scale,
        forward,
        gaitSpeeds,
      ),
    );
  }, [scene, clips, match, materials, keepers]);

  useEffect(() => {
    return () => {
      for (const rig of rigs) disposePlayerRig(rig);
    };
  }, [rigs]);

  /** Entity slot for each player, parallel to `rigs`. */
  const slots = useMemo(
    () => match.meta.players.map((p) => match.entityIndex.get(p.id) ?? -1),
    [match],
  );

  // --- kick cues --------------------------------------------------------
  const cues: readonly KickCue[] = useMemo(() => {
    const { frames: index, players, events, frameRate } = match.meta;
    const { startFrame, stride, absent, scale, frameCount } = index;
    const blob = match.frames;

    /** Pitch-space position of an entity, or null when it has none. */
    const at = (frame: number, slot: number): readonly [number, number] | null => {
      if (frame < 0 || frame >= frameCount) return null;
      const o = frame * stride + slot * 2;
      const x = blob[o]!;
      return x === absent ? null : [x / scale, blob[o + 1]! / scale];
    };

    const rigOf = new Map<string, number>();
    players.forEach((p, i) => rigOf.set(p.id, i));

    // Fire the one-shot this far early so the strike lands on the event frame
    // rather than a beat after it. Read off the clip; see measureKickContact.
    const kick = clips.kick;
    const contact =
      kick === null
        ? DEFAULT_KICK_CONTACT_FRACTION
        : (measureKickContact(scene, kick, fitScale(scene)) ?? DEFAULT_KICK_CONTACT_FRACTION);
    const lead = Math.round((kick?.duration ?? 0) * contact * frameRate);

    const out: KickCue[] = [];
    for (const event of events) {
      if (!KICK_TYPES.has(event.type) || event.from === null) continue;
      const rig = rigOf.get(event.from);
      if (rig === undefined) continue;

      const start = event.frame - startFrame;
      let dirX = 0;
      let dirZ = 0;

      // Preferred: where the ball actually went. Covers 819 of the 823 kicks.
      const ballStart = at(start, 0);
      const ballEnd = event.endFrame === null ? null : at(event.endFrame - startFrame, 0);
      if (ballStart !== null && ballEnd !== null) {
        const dx = ballEnd[0] - ballStart[0];
        const dz = ballEnd[1] - ballStart[1];
        if (Math.hypot(dx, dz) >= MIN_KICK_TRAVEL_METRES) {
          dirX = dx;
          dirZ = dz;
        }
      }

      // Fallback: aim at the intended receiver.
      if (dirX === 0 && dirZ === 0 && event.to !== null) {
        const actorSlot = match.entityIndex.get(event.from);
        const targetSlot = match.entityIndex.get(event.to);
        const actor = actorSlot === undefined ? null : at(start, actorSlot);
        const receiver = targetSlot === undefined ? null : at(start, targetSlot);
        if (actor !== null && receiver !== null) {
          const dx = receiver[0] - actor[0];
          const dz = receiver[1] - actor[1];
          if (Math.hypot(dx, dz) >= MIN_KICK_TRAVEL_METRES) {
            dirX = dx;
            dirZ = dz;
          }
        }
      }

      out.push({ fireAt: Math.max(0, start - lead), rig, dirX, dirZ });
    }
    out.sort((a, b) => a.fireAt - b.fireAt);
    return out;
  }, [match, clips, scene]);

  // Development-only handle for inspecting rigs and the sampler from the console.
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    (window as unknown as { __rigs?: unknown }).__rigs = {
      rigs, sampler, cues, clips, animations, scene,
      measure: (name: "jog" | "run") =>
        measureClipGroundSpeed(scene, clips[name], fitScale(scene)),
    };
  }

  const ballMesh = useRef<Mesh | null>(null);
  const appliedCameraMode = useRef<CameraMode | null>(null);
  /** Reused every frame; nothing may be allocated in the render loop. */
  const scratch = useMemo(() => new Vector3(), []);
  const clock = useRef(0);
  const sinceDisplayPush = useRef(0);
  const cueCursor = useRef(0);
  const lastFrameIndex = useRef(-1);

  const halfLength = match.meta.pitch.length / 2;
  const halfWidth = match.meta.pitch.width / 2;

  useFrame((state, rawDelta) => {
    const store = usePlayback.getState();
    const delta = Math.min(rawDelta, MAX_DELTA);

    const seek = store.consumeSeek();
    const seeked = seek !== null;
    if (seeked) {
      clock.current = Math.min(Math.max(seek, 0), sampler.duration);
      // Facing is meaningless across a jump; let each rig snap on re-entry.
      for (const rig of rigs) rig.yawInitialised = false;
    } else if (store.playing) {
      clock.current += delta * store.speed;
      if (clock.current >= sampler.duration) {
        clock.current = sampler.duration;
        store.pause();
      }
    }

    sampler.sample(clock.current);
    const { positions, velocities, present } = sampler;

    // --- fire kicks that playback has just passed -----------------------
    const frameIndex = sampler.frameIndex;
    const previous = lastFrameIndex.current;
    if (seeked || previous < 0 || frameIndex < previous || frameIndex - previous > MAX_FIRE_SPAN) {
      cueCursor.current = cueUpperBound(cues, frameIndex);
    } else {
      while (cueCursor.current < cues.length && cues[cueCursor.current]!.fireAt <= frameIndex) {
        const cue = cues[cueCursor.current]!;
        const rig = rigs[cue.rig];
        if (rig !== undefined && rig.wasVisible) fireKick(rig, cue.dirX, cue.dirZ);
        cueCursor.current += 1;
      }
    }
    lastFrameIndex.current = frameIndex;

    // --- players --------------------------------------------------------
    const animating = store.playing || seeked;
    const animDelta = animating ? delta : 0;
    for (let n = 0; n < rigs.length; n += 1) {
      const rig = rigs[n]!;
      const slot = slots[n]!;
      const o = slot * 2;
      const visible = present[slot] === 1;
      updatePlayerRig(
        rig,
        delta,
        animDelta,
        visible,
        positions[o]! - halfLength,
        positions[o + 1]! - halfWidth,
        velocities[o]!,
        velocities[o + 1]!,
        store.speed,
      );
    }

    // --- ball -----------------------------------------------------------
    const ball = ballMesh.current;
    if (ball) {
      if (present[0] === 1) {
        // Height is inferred from the event data, not measured; see ballHeight.ts.
        ball.position.set(
          positions[0]! - halfLength,
          sampler.ballHeight,
          positions[1]! - halfWidth,
        );
        // A real-sized ball is under two pixels across at a broadcast camera,
        // so hold it to a minimum apparent size. True size up close.
        const camera = state.camera as PerspectiveCamera;
        if (camera.isPerspectiveCamera === true) {
          ball.scale.setScalar(
            ballScaleForDistance(
              camera.position.distanceTo(ball.position),
              camera.fov,
              state.size.height,
            ),
          );
        }
        ball.visible = true;
      } else {
        ball.visible = false;
      }
    }

    // --- camera ---------------------------------------------------------
    const controls = state.controls as unknown as OrbitLike | null;
    const perspective = state.camera as PerspectiveCamera;
    if (controls !== null && perspective.isPerspectiveCamera === true) {
      const mode = store.cameraMode;
      const ballVisible = ball !== null && ball.visible;
      if (appliedCameraMode.current !== mode) {
        applyCameraPreset(
          mode,
          perspective,
          controls,
          match.meta.pitch,
          ballVisible && ball !== null ? ball.position : null,
        );
        appliedCameraMode.current = mode;
      } else if (mode === "ball" && ballVisible && ball !== null) {
        followBall(perspective, controls, ball.position, delta, scratch);
      }
    }

    sinceDisplayPush.current += rawDelta;
    if (sinceDisplayPush.current >= DISPLAY_INTERVAL) {
      sinceDisplayPush.current = 0;
      if (store.displayTime !== clock.current) store.setDisplayTime(clock.current);
    }
  });

  return (
    <group>
      {rigs.map((rig, n) => (
        <primitive key={match.meta.players[n]!.id} object={rig.root} />
      ))}
      <mesh ref={ballMesh} visible={false} castShadow>
        <sphereGeometry args={[BALL_RADIUS, 16, 12]} />
        <meshStandardMaterial color="#fdfdfd" roughness={0.4} />
      </mesh>
    </group>
  );
}

useGLTF.preload(MODEL_URL);
