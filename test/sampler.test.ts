/**
 * Exercises FrameSampler against the real converted match.
 * Run with: npm test   (node's built-in test runner + type stripping)
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildMatchData } from "../lib/loadMatch.ts";
import { FrameSampler } from "../lib/sampler.ts";
import type { MatchData } from "../lib/types.ts";

const DATA = path.join(import.meta.dirname, "..", "public", "data");

async function loadFromDisk(): Promise<MatchData> {
  const metaJson: unknown = JSON.parse(await readFile(path.join(DATA, "match-meta.json"), "utf8"));
  const buf = await readFile(path.join(DATA, "frames.bin"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return buildMatchData(metaJson, ab);
}

const match = await loadFromDisk();
const sampler = new FrameSampler(match);
const { frames, entityIndex, meta } = match;
const { stride, absent, scale, startFrame } = meta.frames;
const fps = meta.frameRate;

/** Raw stored position, or null when absent. */
function raw(index: number, slot: number): readonly [number, number] | null {
  const o = index * stride + slot * 2;
  const x = frames[o]!;
  if (x === absent) return null;
  return [x / scale, frames[o + 1]! / scale];
}

test("exact frame times reproduce the stored positions", () => {
  const slot = entityIndex.get("home_11")!;
  for (const index of [0, 1, 1000, 50_000, 144_999]) {
    sampler.sample(index / fps);
    const expected = raw(index, slot)!;
    assert.equal(sampler.present[slot], 1);
    assert.ok(Math.abs(sampler.positions[slot * 2]! - expected[0]) < 1e-4);
    assert.ok(Math.abs(sampler.positions[slot * 2 + 1]! - expected[1]) < 1e-4);
  }
});

test("half way between two frames gives the midpoint", () => {
  const slot = entityIndex.get("home_9")!;
  const index = 30_000;
  const a = raw(index, slot)!;
  const b = raw(index + 1, slot)!;
  sampler.sample((index + 0.5) / fps);
  assert.ok(Math.abs(sampler.positions[slot * 2]! - (a[0] + b[0]) / 2) < 1e-4);
  assert.ok(Math.abs(sampler.positions[slot * 2 + 1]! - (a[1] + b[1]) / 2) < 1e-4);
});

test("a player substituted off is hidden, never lerped toward the origin", () => {
  // home_1 is replaced by home_12 at source frame 46706.
  const off = meta.players.find((p) => p.id === "home_1")!;
  const slot = entityIndex.get(off.id)!;
  const lastIndex = off.lastFrame - startFrame;

  assert.notEqual(raw(lastIndex, slot), null, "precondition: present on its last frame");
  assert.equal(raw(lastIndex + 1, slot), null, "precondition: gone the frame after");

  for (const alpha of [0, 0.25, 0.5, 0.99]) {
    sampler.sample((lastIndex + alpha) / fps);
    assert.equal(sampler.present[slot], 0, `should be hidden at alpha ${alpha}`);
  }
  // Still visible on the frame before, and near the pitch rather than the corner.
  sampler.sample((lastIndex - 1) / fps);
  assert.equal(sampler.present[slot], 1);
});

test("a player substituted on pops in at the arrival position", () => {
  const on = meta.players.find((p) => p.id === "home_13")!;
  const slot = entityIndex.get(on.id)!;
  const firstIndex = on.firstFrame - startFrame;
  const arrival = raw(firstIndex, slot)!;

  assert.equal(raw(firstIndex - 1, slot), null, "precondition: absent the frame before");

  for (const alpha of [0.01, 0.5, 0.99]) {
    sampler.sample((firstIndex - 1 + alpha) / fps);
    assert.equal(sampler.present[slot], 1);
    assert.ok(
      Math.abs(sampler.positions[slot * 2]! - arrival[0]) < 1e-4,
      "must sit exactly at the arrival position, not slide in",
    );
    assert.ok(Math.abs(sampler.positions[slot * 2 + 1]! - arrival[1]) < 1e-4);
  }
});

test("nothing interpolates across the half time end swap", () => {
  const endIndex = meta.periods[0]!.endFrame - startFrame;
  const slot = entityIndex.get("home_11")!;
  const last = raw(endIndex, slot)!;
  const firstOfP2 = raw(endIndex + 1, slot)!;

  // The keeper really does jump the length of the pitch between these frames.
  assert.ok(Math.abs(last[0] - firstOfP2[0]) > 50, "precondition: ends are swapped");

  for (const alpha of [0, 0.5, 0.999]) {
    sampler.sample((endIndex + alpha) / fps);
    assert.ok(
      Math.abs(sampler.positions[slot * 2]! - last[0]) < 1e-4,
      `alpha ${alpha} must hold the last frame of period 1`,
    );
  }
  // The very next frame index is period 2, at the far end.
  sampler.sample((endIndex + 1) / fps);
  assert.ok(Math.abs(sampler.positions[slot * 2]! - firstOfP2[0]) < 1e-4);
});

test("clamps outside the match instead of producing NaN", () => {
  for (const t of [-10, -0.0001, sampler.duration + 5, Number.NaN, Number.POSITIVE_INFINITY]) {
    sampler.sample(t);
    for (let e = 0; e < sampler.entityCount; e += 1) {
      if (sampler.present[e] === 1) {
        assert.ok(Number.isFinite(sampler.positions[e * 2]!), `NaN position at t=${t}`);
        assert.ok(Number.isFinite(sampler.positions[e * 2 + 1]!));
      }
    }
  }
});

/**
 * The Metrica source contains genuine position discontinuities: the ball is
 * relocated for restarts without an intervening NaN, and two players are
 * dragged onto the pitch over a few frames at the start of period 2. Those are
 * data, not renderer bugs. What must hold is that the interpolator never
 * *invents* motion -- every fast movement on screen traces back to a jump that
 * is already present between two source frames.
 */
const JUMP_METRES_PER_FRAME = 1.2; // 30 m/s at 25fps

function sourceJumpKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  const { stride: st, absent: ab, scale: sc } = meta.frames;
  for (let i = 0; i < sampler.frameCount - 1; i += 1) {
    for (let e = 0; e < sampler.entityCount; e += 1) {
      const a = i * st + e * 2;
      const b = (i + 1) * st + e * 2;
      if (frames[a] === ab || frames[b] === ab) continue;
      const dx = (frames[b]! - frames[a]!) / sc;
      const dy = (frames[b + 1]! - frames[a + 1]!) / sc;
      if (Math.hypot(dx, dy) > JUMP_METRES_PER_FRAME) keys.add(`${e}@${i}`);
    }
  }
  return keys;
}

test("interpolation invents no motion that is not already in the source", () => {
  const jumps = sourceJumpKeys();
  const step = 1 / 60;
  const prevX = new Float32Array(sampler.entityCount);
  const prevY = new Float32Array(sampler.entityCount);
  const prevSeen = new Uint8Array(sampler.entityCount);
  const periodEnds = new Set(meta.periods.slice(0, -1).map((p) => p.endFrame - startFrame));

  let worstClean = 0;
  let worstCleanAt = "";
  let flagged = 0;
  let checks = 0;

  const steps = Math.floor(sampler.duration / step);
  for (let k = 0; k <= steps; k += 1) {
    const t = k * step; // computed, not accumulated, to avoid drift
    sampler.sample(t);
    const i = sampler.frameIndex;

    for (let e = 0; e < sampler.entityCount; e += 1) {
      if (sampler.present[e] !== 1) {
        prevSeen[e] = 0;
        continue;
      }
      const x = sampler.positions[e * 2]!;
      const y = sampler.positions[e * 2 + 1]!;
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `non-finite at t=${t.toFixed(2)}`);
      assert.ok(x > -12 && x < 117 && y > -12 && y < 80, `off-world at t=${t.toFixed(2)}`);

      if (prevSeen[e] === 1) {
        checks += 1;
        const speed = Math.hypot(x - prevX[e]!, y - prevY[e]!) / step;
        if (speed > 30) {
          // Must be explained by a source jump, or by the half time end swap.
          const explained =
            jumps.has(`${e}@${i}`) ||
            jumps.has(`${e}@${i - 1}`) ||
            periodEnds.has(i) ||
            periodEnds.has(i - 1);
          assert.ok(
            explained,
            `unexplained ${speed.toFixed(0)} m/s for ${meta.frames.entities[e]} at ` +
              `t=${t.toFixed(2)}s (frame index ${i})`,
          );
          flagged += 1;
        } else if (speed > worstClean) {
          worstClean = speed;
          worstCleanAt = `${meta.frames.entities[e]} at t=${t.toFixed(1)}s`;
        }
      }
      prevX[e] = x;
      prevY[e] = y;
      prevSeen[e] = 1;
    }
  }

  console.log(
    `    swept ${checks.toLocaleString()} steps; ${flagged} attributable to source ` +
      `discontinuities; fastest clean motion ${worstClean.toFixed(1)} m/s (${worstCleanAt})`,
  );
});

test("eleven a side is on the pitch throughout, bar the substitution overlap", () => {
  const teamSlots = { home: [] as number[], away: [] as number[] };
  for (const p of meta.players) teamSlots[p.team].push(entityIndex.get(p.id)!);
  assert.equal(teamSlots.home.length, 14);
  assert.equal(teamSlots.away.length, 14);

  const counts = new Map<string, number>();
  const step = 1 / 25; // every source frame
  const steps = Math.round(sampler.duration / step);
  const offending: string[] = [];

  for (let k = 0; k <= steps; k += 1) {
    sampler.sample(k * step);
    for (const team of ["home", "away"] as const) {
      let n = 0;
      for (const slot of teamSlots[team]) n += sampler.present[slot]!;
      counts.set(`${team}:${n}`, (counts.get(`${team}:${n}`) ?? 0) + 1);
      if (n !== 11 && n !== 12) offending.push(`${team} had ${n} at frame ${k}`);
    }
  }

  console.log(`    on-pitch counts: ${[...counts].sort().map(([k, v]) => `${k} x${v}`).join(", ")}`);
  assert.deepEqual(offending, [], "team size left the 11-12 range");

  // The 12s are the single-frame overlap where a sub is on before the other is off.
  const twelves = (counts.get("home:12") ?? 0) + (counts.get("away:12") ?? 0);
  assert.ok(twelves <= 6, `too many overlap frames: ${twelves}`);
});
