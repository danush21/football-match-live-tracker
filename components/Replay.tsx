"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Sprite, SpriteMaterial, Vector3 } from "three";
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
import { applyCameraPreset, followTarget, type CameraMode, type OrbitLike } from "@/lib/cameraPresets";
import {
  LABEL_ASPECT,
  LABEL_DEFAULT,
  LABEL_HEIGHT,
  LABEL_SCALE,
  LABEL_SELECTED,
  createLabelTexture,
} from "@/lib/playerLabels";
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

  /**
   * One sprite per player carrying their jersey number. Two textures each --
   * normal and selected -- so picking a player can light their label up
   * without rebuilding a canvas mid-frame.
   */
  const labels = useMemo(() => {
    return match.meta.players.map((player) => {
      const normal = createLabelTexture(player.jersey, LABEL_DEFAULT);
      const selected = createLabelTexture(player.jersey, LABEL_SELECTED);
      const material = new SpriteMaterial({
        map: normal,
        transparent: true,
        depthTest: false,
        sizeAttenuation: false,
      });
      const sprite = new Sprite(material);
      sprite.scale.set(LABEL_SCALE * LABEL_ASPECT, LABEL_SCALE, 1);
      sprite.visible = false;
      // Drawn after the players so a number is never buried in a shoulder.
      sprite.renderOrder = 10;
      return { sprite, material, normal, selected };
    });
  }, [match]);

  useEffect(
    () => () => {
      for (const label of labels) {
        label.normal.dispose();
        label.selected.dispose();
        label.material.dispose();
      }
    },
    [labels],
  );

  const ballMesh = useRef<Mesh | null>(null);
  const selectionRing = useRef<Mesh | null>(null);
  const appliedCameraMode = useRef<CameraMode | null>(null);
  /** Reused every frame; nothing may be allocated in the render loop. */
  const scratch = useMemo(() => new Vector3(), []);
  const pickScratch = useMemo(() => new Vector3(), []);
  const followScratch = useMemo(() => new Vector3(), []);
  const clock = useRef(0);
  const sinceDisplayPush = useRef(0);
  const cueCursor = useRef(0);
  const lastFrameIndex = useRef(-1);

  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);

  /**
   * Pick a player by clicking near them.
   *
   * Projecting each player to the screen and taking the nearest, rather than
   * raycasting: a ray has to be tested against 154 skinned meshes whose bounds
   * go stale as they animate, where this is 22 cheap projections and lets a
   * click land anywhere near a player rather than exactly on a limb.
   */
  useEffect(() => {
    const element = gl.domElement;
    let downAt: { x: number; y: number } | null = null;

    const onDown = (event: PointerEvent): void => {
      downAt = { x: event.clientX, y: event.clientY };
    };

    const onUp = (event: PointerEvent): void => {
      const start = downAt;
      downAt = null;
      // A drag is an orbit, not a click.
      if (start === null) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      let bestId: string | null = null;
      let bestDistance = 44; // pixels; generous, so limbs are not required

      for (let n = 0; n < rigs.length; n += 1) {
        const rig = rigs[n]!;
        if (!rig.wasVisible) continue;
        pickScratch.set(rig.root.position.x, 1.1, rig.root.position.z);
        pickScratch.project(camera);
        const x = rect.left + ((pickScratch.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - pickScratch.y) / 2) * rect.height;
        const d = Math.hypot(event.clientX - x, event.clientY - y);
        if (d < bestDistance) {
          bestDistance = d;
          bestId = match.meta.players[n]!.id;
        }
      }

      usePlayback.getState().selectPlayer(bestId);
    };

    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointerup", onUp);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointerup", onUp);
    };
  }, [gl, camera, rigs, match, pickScratch]);

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

    // --- number labels and selection ------------------------------------
    const selectedId = store.selectedPlayer;
    const showNumbers = store.showNumbers;
    let selectedIndex = -1;

    for (let n = 0; n < rigs.length; n += 1) {
      const rig = rigs[n]!;
      const label = labels[n]!;
      const isSelected = match.meta.players[n]!.id === selectedId;
      if (isSelected) selectedIndex = n;

      // A selected player keeps their number whether or not the rest are shown.
      const wanted = rig.wasVisible && (showNumbers || isSelected);
      label.sprite.visible = wanted;
      if (!wanted) continue;

      label.sprite.position.set(rig.root.position.x, LABEL_HEIGHT, rig.root.position.z);
      const texture = isSelected ? label.selected : label.normal;
      if (label.material.map !== texture) {
        label.material.map = texture;
        label.material.needsUpdate = true;
      }
    }

    const ring = selectionRing.current;
    if (ring) {
      if (selectedIndex >= 0 && rigs[selectedIndex]!.wasVisible) {
        const root = rigs[selectedIndex]!.root;
        ring.position.set(root.position.x, 0.04, root.position.z);
        ring.visible = true;
      } else {
        ring.visible = false;
      }
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
        let focus: Vector3 | null = null;
        if (mode === "player" && selectedIndex >= 0 && rigs[selectedIndex]!.wasVisible) {
          const root = rigs[selectedIndex]!.root;
          followScratch.set(root.position.x, 1, root.position.z);
          focus = followScratch;
        } else if (ballVisible && ball !== null) {
          focus = ball.position;
        }
        applyCameraPreset(mode, perspective, controls, match.meta.pitch, focus);
        appliedCameraMode.current = mode;
      } else if (mode === "ball" && ballVisible && ball !== null) {
        followTarget(perspective, controls, ball.position, delta, scratch);
      } else if (mode === "player" && selectedIndex >= 0) {
        const root = rigs[selectedIndex]!.root;
        if (rigs[selectedIndex]!.wasVisible) {
          followScratch.set(root.position.x, 1, root.position.z);
          followTarget(perspective, controls, followScratch, delta, scratch);
        }
      }
    }

    sinceDisplayPush.current += rawDelta;
    if (sinceDisplayPush.current >= DISPLAY_INTERVAL) {
      sinceDisplayPush.current = 0;
      if (store.displayTime !== clock.current) store.setDisplayTime(clock.current);
      if (selectedIndex >= 0) {
        const slot = slots[selectedIndex]!;
        const o = slot * 2;
        store.setSelectedSpeed(
          present[slot] === 1 ? Math.hypot(velocities[o]!, velocities[o + 1]!) : 0,
        );
      }
    }
  });

  return (
    <group>
      {rigs.map((rig, n) => (
        <primitive key={match.meta.players[n]!.id} object={rig.root} />
      ))}
      {labels.map((label, n) => (
        <primitive key={`label-${match.meta.players[n]!.id}`} object={label.sprite} />
      ))}

      <mesh ref={selectionRing} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.62, 0.82, 36]} />
        <meshBasicMaterial color="#5aa9f0" transparent opacity={0.9} depthWrite={false} />
      </mesh>

      <mesh ref={ballMesh} visible={false} castShadow>
        <sphereGeometry args={[BALL_RADIUS, 16, 12]} />
        <meshStandardMaterial color="#fdfdfd" roughness={0.4} />
      </mesh>
    </group>
  );
}

useGLTF.preload(MODEL_URL);
