/** Inferred ball height: arcs must be ballistic, bounded, and evidence-led. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { BALL_RADIUS, computeBallHeights } from "../lib/ballHeight.ts";
import { buildMatchData } from "../lib/loadMatch.ts";
import type { MatchData } from "../lib/types.ts";

const DATA = path.join(import.meta.dirname, "..", "public", "data");

async function loadFromDisk(): Promise<MatchData> {
  const metaJson: unknown = JSON.parse(await readFile(path.join(DATA, "match-meta.json"), "utf8"));
  const buf = await readFile(path.join(DATA, "frames.bin"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return buildMatchData(metaJson, ab);
}

const match = await loadFromDisk();
const meta = match.meta;
const heights = computeBallHeights(meta);
const GRAVITY = 9.81;

test("one height per frame, never underground, never absurd", () => {
  assert.equal(heights.length, meta.frames.frameCount);
  let airborne = 0;
  let peak = 0;
  for (const h of heights) {
    assert.ok(Number.isFinite(h), "height must be finite");
    assert.ok(h >= BALL_RADIUS - 1e-6, `ball sank to ${h}`);
    assert.ok(h < 30, `ball reached ${h} m`);
    if (h > BALL_RADIUS + 1e-6) airborne += 1;
    peak = Math.max(peak, h);
  }
  const pct = (100 * airborne) / heights.length;
  console.log(`    airborne on ${airborne} frames (${pct.toFixed(1)}%), peak ${peak.toFixed(1)} m`);
  // Most of a football match is played on the floor; if this were a majority
  // the inference would be inventing flight it has no evidence for.
  assert.ok(pct > 0.5, "no flight at all was reconstructed");
  assert.ok(pct < 25, `${pct.toFixed(1)}% airborne is far too much`);
});

test("ground passes are left flat", () => {
  // A plain PASS with no subtype has no evidence of flight and must stay down.
  const plain = meta.events.filter(
    (e) => e.type === "PASS" && e.subtype === null && e.endFrame !== null,
  );
  assert.ok(plain.length > 100, "expected many plain passes");

  let flat = 0;
  for (const e of plain) {
    const a = e.frame - meta.frames.startFrame;
    const b = e.endFrame! - meta.frames.startFrame;
    let lifted = false;
    for (let i = a; i <= b && i < heights.length; i += 1) {
      if (heights[i]! > BALL_RADIUS + 1e-6) lifted = true;
    }
    if (!lifted) flat += 1;
  }
  // Some overlap an adjacent aerial segment, which legitimately lifts them.
  const pct = (100 * flat) / plain.length;
  console.log(`    ${flat}/${plain.length} unsubtyped passes stay on the ground (${pct.toFixed(0)}%)`);
  assert.ok(pct > 80, `only ${pct.toFixed(0)}% of plain passes stayed flat`);
});

test("a header's arc arrives at head height", () => {
  const headers = meta.events.filter((e) => e.subtype !== null && /\bHEAD\b/.test(e.subtype));
  assert.ok(headers.length > 10, "expected headers in this match");

  let checked = 0;
  for (const header of headers) {
    const at = header.frame - meta.frames.startFrame;
    if (at < 0 || at >= heights.length) continue;
    // The ball should be off the deck as it reaches the header.
    if (heights[at]! > BALL_RADIUS + 1e-6) checked += 1;
  }
  console.log(`    ${checked}/${headers.length} headers meet a ball that is off the ground`);
  assert.ok(checked > headers.length * 0.5, "headers should mostly meet an airborne ball");
});

test("arcs follow gravity rather than a fitted curve", () => {
  // For any airborne run, the bulge above the straight line between its
  // endpoints must equal gT^2/8 unless it hit the clamp.
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i < heights.length; i += 1) {
    const up = heights[i]! > BALL_RADIUS + 1e-6;
    if (up && start < 0) start = i;
    if (!up && start >= 0) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  assert.ok(runs.length > 20, `expected many arcs, found ${runs.length}`);

  let ballistic = 0;
  let clamped = 0;
  for (const run of runs) {
    const span = run.end - run.start;
    if (span < 8) continue;
    const seconds = span / meta.frameRate;
    const expected = (GRAVITY * seconds * seconds) / 8;
    // Peak above the chord between the run's own endpoints.
    const z0 = heights[run.start]!;
    const z1 = heights[run.end]!;
    let maxBulge = 0;
    for (let i = run.start; i <= run.end; i += 1) {
      const s = (i - run.start) / span;
      maxBulge = Math.max(maxBulge, heights[i]! - (z0 + (z1 - z0) * s));
    }
    if (expected > 12) { clamped += 1; continue; }
    // Endpoints are pinned at BALL_RADIUS by the run detection, so allow slack.
    if (Math.abs(maxBulge - expected) < Math.max(0.35, expected * 0.3)) ballistic += 1;
  }
  console.log(`    ${ballistic} arcs match gT^2/8, ${clamped} hit the height clamp`);
  assert.ok(ballistic > 10, `only ${ballistic} arcs were ballistic`);
});

test("no arc is drawn across the half time end swap", () => {
  for (const period of meta.periods.slice(0, -1)) {
    const last = period.endFrame - meta.frames.startFrame;
    assert.ok(
      Math.abs(heights[last]! - BALL_RADIUS) < 1e-6,
      "ball should be on the ground at the end of a period",
    );
    assert.ok(Math.abs(heights[last + 1]! - BALL_RADIUS) < 1e-6);
  }
});
