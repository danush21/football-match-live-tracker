import { BALL_RADIUS } from "./ball.ts";
import type { MatchEvent, MatchMeta } from "./types.ts";

/**
 * Reconstruct a plausible ball height for each frame.
 *
 * IMPORTANT: the Metrica source is two dimensional. It records where the ball
 * is on the pitch and nothing about how high it is, and the 2D motion carries
 * no usable signal either -- rolling and flying segments show the same
 * deceleration. So this is INFERRED, not measured, and is deliberately
 * conservative: the ball is left on the ground unless the event data says
 * otherwise, which is also the truth for most passes in a football match.
 *
 * The evidence used is the event subtypes, which do name flight:
 *   - HEAD / AERIAL   the ball was at head height at that moment
 *   - THROW IN        released from above head height
 *   - CROSS, GOAL KICK, CLEARANCE, CORNER KICK, LOB, CHIP, DEEP BALL
 *                     struck into the air
 *
 * Where a segment is airborne, the arc between its known endpoints is the
 * genuine ballistic solution: over a flight of T seconds gravity alone fixes
 * the bulge above the straight line at gT^2/8, and both endpoint heights are
 * pinned by the events. Nothing here is fitted or tuned.
 */

const GRAVITY = 9.81;

/** Where a header or aerial duel meets the ball. */
const HEAD_HEIGHT = 1.85;
/** Where a throw-in leaves the hands. */
const THROW_RELEASE_HEIGHT = 1.95;

/**
 * Ceiling on the bulge of an arc, metres. A long segment may include a bounce,
 * which a single parabola would turn into one implausibly tall lob; clamping
 * keeps those readable. Goal kicks genuinely reach this sort of height.
 */
const MAX_ARC_BULGE = 12;

/** Subtypes meaning the ball was at head height at that instant. */
const AT_HEAD_HEIGHT = /\b(HEAD|AERIAL)\b/;
/** Subtypes meaning the ball left the ground during this segment. */
const STRUCK_INTO_AIR = /\b(CROSS|GOAL KICK|CLEARANCE|CORNER KICK|LOB|CHIP|DEEP BALL)\b/;
const THROWN = /\bTHROW IN\b/;

function startHeight(event: MatchEvent): number {
  const subtype = event.subtype;
  if (subtype === null) return BALL_RADIUS;
  if (THROWN.test(subtype)) return THROW_RELEASE_HEIGHT;
  if (AT_HEAD_HEIGHT.test(subtype)) return HEAD_HEIGHT;
  return BALL_RADIUS;
}

function endHeight(next: MatchEvent | undefined): number {
  if (next === undefined || next.subtype === null) return BALL_RADIUS;
  return AT_HEAD_HEIGHT.test(next.subtype) ? HEAD_HEIGHT : BALL_RADIUS;
}

/** True when the event data says the ball was off the ground in this segment. */
function isAirborne(event: MatchEvent, z0: number, z1: number): boolean {
  if (z0 > BALL_RADIUS || z1 > BALL_RADIUS) return true;
  return event.subtype !== null && STRUCK_INTO_AIR.test(event.subtype);
}

/**
 * Height of the ball's centre for every frame, in metres.
 *
 * Frames not covered by an airborne segment sit at BALL_RADIUS, i.e. resting
 * on the turf. Overlapping arcs take the higher of the two so one segment
 * cannot flatten another.
 */
export function computeBallHeights(meta: MatchMeta): Float32Array {
  const { frameCount, startFrame } = meta.frames;
  const heights = new Float32Array(frameCount).fill(BALL_RADIUS);

  // Period boundaries in blob indices, so no arc is drawn across the end swap.
  const periodEnd = meta.periods.map((p) => p.endFrame - startFrame);
  const endOfPeriod = (index: number): number => {
    for (const end of periodEnd) if (index <= end) return end;
    return frameCount - 1;
  };

  const events = [...meta.events].sort((a, b) => a.frame - b.frame);

  for (let n = 0; n < events.length; n += 1) {
    const event = events[n]!;
    if (event.endFrame === null) continue;

    const start = event.frame - startFrame;
    const end = event.endFrame - startFrame;
    if (start < 0 || end >= frameCount || end <= start) continue;
    if (end > endOfPeriod(start)) continue;

    const z0 = startHeight(event);
    const z1 = endHeight(events[n + 1]);
    if (!isAirborne(event, z0, z1)) continue;

    const span = end - start;
    const seconds = span / meta.frameRate;
    // Ballistic: gravity alone fixes the bulge above the chord at gT^2/8.
    const bulge = Math.min((GRAVITY * seconds * seconds) / 8, MAX_ARC_BULGE);

    for (let i = start; i <= end; i += 1) {
      const s = (i - start) / span;
      const z = z0 + (z1 - z0) * s + 4 * bulge * s * (1 - s);
      const clamped = Math.max(z, BALL_RADIUS);
      if (clamped > heights[i]!) heights[i] = clamped;
    }
  }

  return heights;
}
