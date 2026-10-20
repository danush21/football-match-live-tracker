/** The match clock counts per period, not across the match. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildMatchData } from "../lib/loadMatch.ts";
import {
  clockAt,
  formatMinutesSeconds,
  periodAt,
  periodBounds,
  periodStartSeconds,
  secondsForFrame,
} from "../lib/matchClock.ts";
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

test("mm:ss formatting", () => {
  assert.equal(formatMinutesSeconds(0), "00:00");
  assert.equal(formatMinutesSeconds(59.9), "00:59");
  assert.equal(formatMinutesSeconds(60), "01:00");
  assert.equal(formatMinutesSeconds(2850.72), "47:30");
  assert.equal(formatMinutesSeconds(-5), "00:00", "never shows a negative clock");
});

test("the clock restarts at the second half", () => {
  const boundary = periodStartSeconds(meta, meta.periods[1]!);

  const endOfFirst = clockAt(meta, boundary - 0.04);
  assert.equal(endOfFirst.period, 1);
  assert.equal(endOfFirst.periodLabel, "H1");
  assert.equal(endOfFirst.time, "47:30");

  const startOfSecond = clockAt(meta, boundary);
  assert.equal(startOfSecond.period, 2);
  assert.equal(startOfSecond.periodLabel, "H2");
  assert.equal(startOfSecond.time, "00:00", "the second half starts from zero");

  // The replay's own axis keeps running; only the displayed clock resets.
  assert.ok(boundary > 2850, "precondition: the halves are continuous in replay time");
});

test("every period is identified correctly across its whole span", () => {
  for (const period of meta.periods) {
    const from = secondsForFrame(meta, period.startFrame);
    const to = secondsForFrame(meta, period.endFrame);
    for (const t of [from, (from + to) / 2, to]) {
      assert.equal(periodAt(meta, t).period, period.period, `t=${t} landed in the wrong period`);
    }
  }
});

test("times outside the match clamp to the end periods", () => {
  assert.equal(periodAt(meta, -100).period, 1);
  assert.equal(periodAt(meta, 1e9).period, meta.periods[meta.periods.length - 1]!.period);
});

test("scrub bar period bands cover the bar without overlapping", () => {
  const bounds = periodBounds(meta, match.durationSeconds);
  assert.equal(bounds.length, meta.periods.length);
  assert.ok(Math.abs(bounds[0]!.from) < 1e-9, "first period starts at the left edge");
  assert.ok(Math.abs(bounds[bounds.length - 1]!.to - 1) < 1e-9, "last period ends at the right");
  for (let i = 1; i < bounds.length; i += 1) {
    assert.ok(bounds[i]!.from >= bounds[i - 1]!.to - 1e-9, "periods must not overlap");
  }
  for (const b of bounds) {
    assert.ok(b.from >= 0 && b.to <= 1 && b.to > b.from, `band ${b.period} is out of range`);
  }
});

test("seeking to an event lands inside the period the event belongs to", () => {
  for (const event of meta.events) {
    const seconds = secondsForFrame(meta, event.frame);
    assert.equal(
      periodAt(meta, seconds).period,
      event.period,
      `event ${event.id} seeks into the wrong period`,
    );
  }
});
