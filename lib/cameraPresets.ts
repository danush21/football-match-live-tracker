import type { PerspectiveCamera, Vector3 } from "three";
import type { PitchDimensions } from "./types.ts";

/**
 * The three camera positions the viewer can jump between.
 *
 * Presets only place the camera; OrbitControls still owns it afterwards, so
 * any preset can be nudged by hand without being fought for control. Ball
 * follow is the exception, and even there the viewer's orbit is preserved --
 * only the point being looked at moves.
 */
export type CameraMode = "broadcast" | "tactical" | "ball" | "player";

export const CAMERA_MODES: readonly CameraMode[] = ["broadcast", "tactical", "ball"];
/** Only offered once a player has been clicked. */
export const PLAYER_CAMERA: CameraMode = "player";

export const CAMERA_LABELS: Readonly<Record<CameraMode, string>> = {
  broadcast: "Broadcast",
  tactical: "Overhead",
  ball: "Follow ball",
  player: "Follow player",
};

/** Minimal shape of the controls; avoids depending on drei's types here. */
export interface OrbitLike {
  readonly target: Vector3;
  update: () => void;
}

/** How quickly ball-follow closes on the ball. Seconds to halve the gap. */
const FOLLOW_HALF_LIFE = 0.25;

/**
 * Distance needed to frame a span of `metres` across, given the camera's
 * vertical field of view and the viewport's shape. Without accounting for
 * aspect the overhead view cuts the pitch off on a narrow window.
 */
function distanceToFit(camera: PerspectiveCamera, metres: number, horizontal: boolean): number {
  const halfFov = (camera.fov * Math.PI) / 360;
  const effective = horizontal ? Math.tan(halfFov) * camera.aspect : Math.tan(halfFov);
  if (effective <= 1e-6) return metres;
  return metres / (2 * effective);
}

/** Place the camera for a preset. Called once, when the mode changes. */
export function applyCameraPreset(
  mode: CameraMode,
  camera: PerspectiveCamera,
  controls: OrbitLike,
  pitch: PitchDimensions,
  ball: Vector3 | null,
): void {
  switch (mode) {
    case "broadcast": {
      const back = Math.max(62, distanceToFit(camera, pitch.length * 0.92, true));
      camera.position.set(0, back * 0.52, back);
      controls.target.set(0, 0, 0);
      break;
    }
    case "tactical": {
      const height = Math.max(
        distanceToFit(camera, pitch.length + 8, true),
        distanceToFit(camera, pitch.width + 8, false),
      );
      // A hair off true vertical: looking exactly down the Y axis leaves
      // OrbitControls with no stable idea of which way is up.
      camera.position.set(0, height, 0.01);
      controls.target.set(0, 0, 0);
      break;
    }
    case "ball":
    case "player": {
      const centre = ball ?? controls.target;
      controls.target.copy(centre);
      camera.position.set(centre.x, centre.y + 13, centre.z + 21);
      break;
    }
  }
  camera.updateProjectionMatrix();
  controls.update();
}

/**
 * Keep the camera on the ball, preserving whatever orbit the viewer has set.
 *
 * The offset between camera and target is held constant and only the target
 * moves, so dragging to look from a different angle survives the ball moving.
 * `scratch` is supplied by the caller: this runs every frame.
 */
export function followTarget(
  camera: PerspectiveCamera,
  controls: OrbitLike,
  ball: Vector3,
  dt: number,
  scratch: Vector3,
): void {
  scratch.copy(camera.position).sub(controls.target);
  const k = dt <= 0 ? 1 : 1 - Math.pow(0.5, dt / FOLLOW_HALF_LIFE);
  controls.target.lerp(ball, Math.min(1, k));
  camera.position.copy(controls.target).add(scratch);
}
