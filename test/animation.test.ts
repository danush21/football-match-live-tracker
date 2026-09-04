/** Pure animation maths: gait selection, foot-skate compensation, facing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GAIT_IDLE_MAX,
  GAIT_JOG_MAX,
  JOG_REFERENCE_SPEED,
  RUN_REFERENCE_SPEED,
  TIME_SCALE_MAX,
  TIME_SCALE_MIN,
  YAW_HALF_LIFE,
  blendYaw,
  gaitForSpeed,
  stepYaw,
  timeScaleForGait,
  yawForVelocity,
} from "../lib/playerModel.ts";

const TAU = Math.PI * 2;
/** Signed shortest angle from a to b. */
const arc = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));

test("gait thresholds match the brief", () => {
  assert.equal(gaitForSpeed(0), "idle");
  assert.equal(gaitForSpeed(0.49), "idle");
  assert.equal(gaitForSpeed(GAIT_IDLE_MAX), "jog", "0.5 m/s is the start of jogging");
  assert.equal(gaitForSpeed(2), "jog");
  assert.equal(gaitForSpeed(GAIT_JOG_MAX), "jog", "4 m/s is still jogging");
  assert.equal(gaitForSpeed(4.01), "run");
  assert.equal(gaitForSpeed(9), "run");
});

test("timeScale tracks speed so stride length stays honest", () => {
  assert.equal(timeScaleForGait("idle", 0), 1, "idle never speeds up");
  assert.equal(timeScaleForGait("idle", 9), 1);

  // At the clip's reference speed the clip plays at its authored rate.
  assert.ok(Math.abs(timeScaleForGait("jog", JOG_REFERENCE_SPEED) - 1) < 1e-9);
  assert.ok(Math.abs(timeScaleForGait("run", RUN_REFERENCE_SPEED) - 1) < 1e-9);

  // Faster ground speed -> faster playback, monotonically.
  let previous = 0;
  for (let speed = 0.5; speed <= 4; speed += 0.25) {
    const scale = timeScaleForGait("jog", speed);
    assert.ok(scale >= previous, "jog timeScale must not go backwards");
    previous = scale;
  }

  // Always clamped, so a tracking glitch cannot produce a blur or a freeze.
  for (const speed of [0, 0.001, 1e6, 40]) {
    for (const gait of ["jog", "run"] as const) {
      const scale = timeScaleForGait(gait, speed);
      assert.ok(scale >= TIME_SCALE_MIN && scale <= TIME_SCALE_MAX, `${gait} @ ${speed}`);
    }
  }
});

test("facing points along the direction of travel, for either model axis", () => {
  // Assert what actually matters: after rotating by the yaw, the model's own
  // forward axis lines up with the velocity. Asserting the raw angle instead
  // is what let a 180 degree error ship -- every player ran backwards.
  for (const forward of [1, -1] as const) {
    for (const [vx, vz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
      [0.6, -0.8],
      [-3, -4],
    ] as const) {
      const yaw = yawForVelocity(vx, vz, forward);
      // Rotating local (0, 0, forward) by yaw about Y.
      const wx = forward * Math.sin(yaw);
      const wz = forward * Math.cos(yaw);
      const length = Math.hypot(vx, vz);
      assert.ok(
        Math.abs(wx - vx / length) < 1e-9 && Math.abs(wz - vz / length) < 1e-9,
        `forward ${forward}, velocity (${vx}, ${vz}): faced (${wx}, ${wz})`,
      );
    }
  }
});

test("a -Z model is turned a half circle from a +Z one", () => {
  for (const [vx, vz] of [[1, 2], [-1, 0.5], [0, -1]] as const) {
    const gap = Math.abs(arc(yawForVelocity(vx, vz, 1), yawForVelocity(vx, vz, -1)));
    assert.ok(Math.abs(gap - Math.PI) < 1e-9, `expected a half turn, got ${gap}`);
  }
});

test("yaw takes the short way round, never the long way", () => {
  // 10 degrees across the +/-pi wrap must not become 350 the other way.
  const from = Math.PI - 0.087; // ~175 deg
  const to = -Math.PI + 0.087; // ~-175 deg, 10 deg away across the seam
  const next = stepYaw(from, to, 0.016);
  const moved = arc(from, next);
  assert.ok(moved > 0, `should rotate positively through the seam, got ${moved}`);
  assert.ok(Math.abs(moved) < 0.1, `should move a fraction of 10 deg, got ${moved}`);
});

test("yaw closes half the gap in one half-life, at any frame rate", () => {
  const target = 1.2;
  for (const dt of [YAW_HALF_LIFE]) {
    const next = stepYaw(0, target, dt);
    assert.ok(Math.abs(next - target / 2) < 1e-6, `expected half of ${target}, got ${next}`);
  }

  // Same elapsed time must give the same result whether taken in one step or many.
  const elapsed = 0.25;
  const oneStep = stepYaw(0, target, elapsed);
  let many = 0;
  const steps = 50;
  for (let i = 0; i < steps; i += 1) many = stepYaw(many, target, elapsed / steps);
  assert.ok(
    Math.abs(oneStep - many) < 1e-6,
    `frame-rate dependent: ${oneStep} vs ${many}`,
  );
});

test("yaw converges and never overshoots", () => {
  for (const target of [0.3, -2.9, 3.0, -0.05]) {
    let yaw = 0;
    let previousGap = Math.abs(arc(yaw, target));
    for (let i = 0; i < 400; i += 1) {
      yaw = stepYaw(yaw, target, 1 / 60);
      const gap = Math.abs(arc(yaw, target));
      assert.ok(gap <= previousGap + 1e-9, "gap must shrink monotonically");
      previousGap = gap;
    }
    assert.ok(previousGap < 1e-6, `did not converge on ${target}: gap ${previousGap}`);
    assert.ok(Number.isFinite(yaw) && Math.abs(yaw) < TAU * 2, "yaw must stay bounded");
  }
});

test("a stationary player holds its yaw rather than spinning", () => {
  // stepYaw is only called above FACING_MIN_SPEED, but dt<=0 must be inert too.
  assert.equal(stepYaw(0.7, -2.4, 0), 0.7);
  assert.equal(stepYaw(0.7, -2.4, -1), 0.7);
});

test("blendYaw moves along the shortest arc and honours its endpoints", () => {
  const a = 0.4;
  const b = -2.8;
  assert.ok(Math.abs(arc(blendYaw(a, b, 0), a)) < 1e-9, "t=0 stays put");
  assert.ok(Math.abs(arc(blendYaw(a, b, 1), b)) < 1e-9, "t=1 arrives");

  // Halfway must be halfway along the SHORT arc, not the long one.
  const half = blendYaw(a, b, 0.5);
  const shortGap = Math.abs(arc(a, b));
  assert.ok(Math.abs(Math.abs(arc(a, half)) - shortGap / 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(arc(half, b)) - shortGap / 2) < 1e-9);

  // Across the wrap: 175 deg to -175 deg is 10 deg, so the midpoint is at the seam.
  const mid = blendYaw(Math.PI - 0.087, -Math.PI + 0.087, 0.5);
  assert.ok(Math.abs(Math.abs(arc(mid, Math.PI))) < 1e-6, `midpoint should sit at pi, got ${mid}`);
});

test("a kick's facing overrides travel only while the strike is live", () => {
  // The blend weight is the kick envelope: 0 leaves facing on the travel
  // direction, 1 commits fully to the ball's direction.
  const travel = 1.0;
  const kick = -2.0;
  assert.ok(Math.abs(arc(blendYaw(travel, kick, 0), travel)) < 1e-9);
  assert.ok(Math.abs(arc(blendYaw(travel, kick, 1), kick)) < 1e-9);
  // Monotonic in between, so the turn in and the settle back are both smooth.
  let previous = 0;
  for (let w = 0; w <= 1; w += 0.05) {
    const moved = Math.abs(arc(travel, blendYaw(travel, kick, w)));
    assert.ok(moved >= previous - 1e-9, "turn must not reverse as the kick ramps");
    previous = moved;
  }
});
