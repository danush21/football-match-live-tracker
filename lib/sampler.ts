import type { MatchData } from "./types.ts";

/**
 * Samples entity positions at an arbitrary time, interpolating between the
 * 25fps source frames so playback is smooth at any render rate.
 *
 * Results land in preallocated arrays indexed by entity slot (slot 0 is the
 * ball). Nothing is allocated per call -- sample() runs every render frame.
 */
export class FrameSampler {
  /** metres, corner origin: [x0, y0, x1, y1, ...] indexed by entity slot. */
  readonly positions: Float32Array;
  /** metres/second, same indexing. Zero whenever a position is not interpolated. */
  readonly velocities: Float32Array;
  /** 1 when the entity has a position this instant, 0 when it does not. */
  readonly present: Uint8Array;
  /** Height of the ball's centre this instant, metres. Inferred, not measured. */
  ballHeight: number;

  readonly entityCount: number;
  readonly frameCount: number;
  readonly frameRate: number;
  /** Seconds from the first frame to the last. */
  readonly duration: number;

  private readonly frames: Int16Array;
  private readonly heights: Float32Array;
  private readonly stride: number;
  private readonly absent: number;
  private readonly invScale: number;
  /** Last blob index of each period, ascending. */
  private readonly periodEnds: readonly number[];

  /** Blob index of the pair most recently sampled, for callers that need it. */
  private lastIndex = 0;
  private lastAlpha = 0;

  constructor(match: MatchData) {
    const { meta, frames } = match;
    const index = meta.frames;

    this.frames = frames;
    this.heights = match.ballHeights;
    this.stride = index.stride;
    this.absent = index.absent;
    this.invScale = 1 / index.scale;
    this.entityCount = index.entities.length;
    this.frameCount = index.frameCount;
    this.frameRate = meta.frameRate;
    this.duration = (index.frameCount - 1) / meta.frameRate;

    this.positions = new Float32Array(this.entityCount * 2);
    this.velocities = new Float32Array(this.entityCount * 2);
    this.present = new Uint8Array(this.entityCount);
    this.ballHeight = 0;

    // Periods are stored as source frame numbers; convert once to blob indices.
    this.periodEnds = meta.periods
      .map((p) => p.endFrame - index.startFrame)
      .sort((a, b) => a - b);
  }

  /** Last blob index belonging to the same period as `i`. */
  private periodEndFor(i: number): number {
    for (const end of this.periodEnds) {
      if (i <= end) return end;
    }
    return this.frameCount - 1;
  }

  get frameIndex(): number {
    return this.lastIndex;
  }

  get frameAlpha(): number {
    return this.lastAlpha;
  }

  /** Blob index the given time falls on, clamped to the match. */
  indexAtTime(seconds: number): number {
    const exact = seconds * this.frameRate;
    if (!(exact > 0)) return 0; // also catches NaN
    if (exact >= this.frameCount - 1) return this.frameCount - 1;
    return Math.floor(exact);
  }

  /**
   * Fill positions/velocities/present for `seconds` after the first frame.
   *
   * Interpolation rules, all of which matter:
   *  - Both endpoints present -> lerp. This is the normal case.
   *  - Present at i, gone by i+1 (substituted off) -> hidden, never lerped
   *    toward the origin.
   *  - Absent at i, present at i+1 (substituted on) -> pops in at the i+1
   *    position rather than sliding in from wherever it last was.
   *  - i is the final frame of a period -> the pair collapses to (i, i) so
   *    nothing interpolates across the end swap at half time.
   */
  sample(seconds: number): void {
    const exact = Number.isFinite(seconds) ? seconds * this.frameRate : 0;
    const maxIndex = this.frameCount - 1;

    let i: number;
    let alpha: number;
    if (exact <= 0) {
      i = 0;
      alpha = 0;
    } else if (exact >= maxIndex) {
      i = maxIndex;
      alpha = 0;
    } else {
      i = Math.floor(exact);
      alpha = exact - i;
    }

    // Never interpolate across a period boundary: the teams swap ends there.
    let j = i + 1;
    if (j > this.periodEndFor(i) || j > maxIndex) {
      j = i;
      alpha = 0;
    }

    this.lastIndex = i;
    this.lastAlpha = alpha;

    // Height rides on the same pair, so it never blends across the end swap.
    this.ballHeight = this.heights[i]! + (this.heights[j]! - this.heights[i]!) * alpha;

    const { frames, stride, absent, invScale, positions, velocities, present } = this;
    const baseI = i * stride;
    const baseJ = j * stride;
    const dt = this.frameRate; // (pos_j - pos_i) * frameRate == metres/second

    for (let e = 0; e < this.entityCount; e += 1) {
      const oi = baseI + e * 2;
      const oj = baseJ + e * 2;
      const xi = frames[oi]!;
      const xj = frames[oj]!;
      const o = e * 2;

      if (xi !== absent && xj !== absent) {
        const yi = frames[oi + 1]!;
        const yj = frames[oj + 1]!;
        const mxi = xi * invScale;
        const myi = yi * invScale;
        const mxj = xj * invScale;
        const myj = yj * invScale;
        positions[o] = mxi + (mxj - mxi) * alpha;
        positions[o + 1] = myi + (myj - myi) * alpha;
        velocities[o] = (mxj - mxi) * dt;
        velocities[o + 1] = (myj - myi) * dt;
        present[e] = 1;
      } else if (xi === absent && xj !== absent) {
        // Substituted on between i and i+1: appear at the arrival position.
        positions[o] = xj * invScale;
        positions[o + 1] = frames[oj + 1]! * invScale;
        velocities[o] = 0;
        velocities[o + 1] = 0;
        present[e] = 1;
      } else {
        // Absent at i+1 (substituted off) or absent at both: draw nothing.
        velocities[o] = 0;
        velocities[o + 1] = 0;
        present[e] = 0;
      }
    }
  }
}
