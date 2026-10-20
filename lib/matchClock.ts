import type { MatchMeta, PeriodMeta } from "./types.ts";

/**
 * The match clock, which counts within a period rather than across the match.
 *
 * The replay's own time axis runs continuously from the first frame, but a
 * football clock does not: each half is counted separately, so the period has
 * to be named alongside the time for the reading to mean anything.
 */

export interface ClockReading {
  readonly period: number;
  /** Seconds elapsed within the period. */
  readonly elapsed: number;
  /** "12:34" */
  readonly time: string;
  /** "H1" */
  readonly periodLabel: string;
}

export function formatMinutesSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Period containing a given time, clamped to the first or last. */
export function periodAt(meta: MatchMeta, seconds: number): PeriodMeta {
  const frame = meta.frames.startFrame + Math.round(seconds * meta.frameRate);
  for (const period of meta.periods) {
    if (frame <= period.endFrame) return period;
  }
  return meta.periods[meta.periods.length - 1]!;
}

/** Start of a period, in seconds on the replay's own time axis. */
export function periodStartSeconds(meta: MatchMeta, period: PeriodMeta): number {
  return (period.startFrame - meta.frames.startFrame) / meta.frameRate;
}

export function clockAt(meta: MatchMeta, seconds: number): ClockReading {
  const period = periodAt(meta, seconds);
  const elapsed = Math.max(0, seconds - periodStartSeconds(meta, period));
  return {
    period: period.period,
    elapsed,
    time: formatMinutesSeconds(elapsed),
    periodLabel: `H${period.period}`,
  };
}

/** Where each period sits on a 0..1 scrub bar. */
export function periodBounds(
  meta: MatchMeta,
  durationSeconds: number,
): ReadonlyArray<{ readonly period: number; readonly from: number; readonly to: number }> {
  if (!(durationSeconds > 0)) return [];
  return meta.periods.map((p) => ({
    period: p.period,
    from: (p.startFrame - meta.frames.startFrame) / meta.frameRate / durationSeconds,
    to: (p.endFrame - meta.frames.startFrame) / meta.frameRate / durationSeconds,
  }));
}

/** Replay time, in seconds, for a source frame number. */
export function secondsForFrame(meta: MatchMeta, frame: number): number {
  return (frame - meta.frames.startFrame) / meta.frameRate;
}
