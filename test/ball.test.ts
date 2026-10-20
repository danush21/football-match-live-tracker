/** The ball must stay findable when zoomed out and honest when zoomed in. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BALL_MAX_SCALE,
  BALL_MIN_SCREEN_PIXELS,
  BALL_RADIUS,
  ballScaleForDistance,
} from "../lib/ball.ts";

/** How many CSS pixels across the ball actually appears. */
function apparentPixels(distance: number, fov: number, height: number): number {
  const scale = ballScaleForDistance(distance, fov, height);
  const metresPerPixel = (2 * distance * Math.tan((fov * Math.PI) / 360)) / height;
  return (2 * BALL_RADIUS * scale) / metresPerPixel;
}

const FOV = 42;
const HEIGHT = 768;

test("a real-sized ball really is invisible at a broadcast camera", () => {
  // The reason this exists at all: no scaling, 85 m out.
  const metresPerPixel = (2 * 85 * Math.tan((FOV * Math.PI) / 360)) / HEIGHT;
  const trueSize = (2 * BALL_RADIUS) / metresPerPixel;
  console.log(`    unscaled ball at 85 m: ${trueSize.toFixed(1)} px across`);
  assert.ok(trueSize < 3, "premise failed: a true-size ball would already be visible");
});

test("close up the ball is left at its real size", () => {
  for (const d of [1, 5, 15, 25]) {
    assert.equal(ballScaleForDistance(d, FOV, HEIGHT), 1, `scaled at only ${d} m away`);
  }
});

test("it never drops below the legibility floor until the clamp bites", () => {
  for (const d of [30, 50, 85, 120, 200]) {
    const px = apparentPixels(d, FOV, HEIGHT);
    const scale = ballScaleForDistance(d, FOV, HEIGHT);
    if (scale >= BALL_MAX_SCALE) continue; // clamped, allowed to shrink
    assert.ok(
      px >= BALL_MIN_SCREEN_PIXELS - 1e-6,
      `${px.toFixed(1)} px at ${d} m is below the ${BALL_MIN_SCREEN_PIXELS} px floor`,
    );
  }
  console.log(
    `    apparent size: ` +
      [30, 85, 200].map((d) => `${d}m ${apparentPixels(d, FOV, HEIGHT).toFixed(1)}px`).join(", "),
  );
});

test("scale only ever grows with distance, and stays bounded", () => {
  let previous = 0;
  for (let d = 1; d <= 400; d += 1) {
    const scale = ballScaleForDistance(d, FOV, HEIGHT);
    assert.ok(scale >= 1, `scale ${scale} shrank the ball below real size`);
    assert.ok(scale <= BALL_MAX_SCALE, `scale ${scale} exceeded the clamp`);
    assert.ok(scale >= previous - 1e-9, "scale must not go backwards as you pull out");
    previous = scale;
  }
});

test("a taller viewport needs less exaggeration", () => {
  // More pixels for the same field of view means the ball is already bigger.
  const small = ballScaleForDistance(85, FOV, 480);
  const large = ballScaleForDistance(85, FOV, 1440);
  assert.ok(small > large, "a short viewport should scale up more, not less");
});

test("degenerate inputs leave the ball alone", () => {
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0, FOV, HEIGHT],
    [-5, FOV, HEIGHT],
    [85, 0, HEIGHT],
    [85, FOV, 0],
    [Number.NaN, FOV, HEIGHT],
    [85, Number.NaN, HEIGHT],
    [85, FOV, Number.NaN],
  ];
  for (const [distance, fov, height] of cases) {
    assert.equal(
      ballScaleForDistance(distance, fov, height),
      1,
      `bad input ${JSON.stringify([distance, fov, height])}`,
    );
  }
});
