/** Ball presentation: real size, and how big it has to look to be findable. */

/** Radius of a real football, metres. The ball's resting height, too. */
export const BALL_RADIUS = 0.11;

/**
 * Smallest the ball is allowed to appear, as a diameter in CSS pixels.
 *
 * At a broadcast camera roughly 85 m out, a true-size ball is under two pixels
 * across and effectively invisible against the turf. Televised tracking
 * graphics have the same problem and solve it the same way.
 *
 * Kept as low as legibility allows, because every pixel here is a pixel the
 * ball looks too big by: at 7 px it read 2.7x oversized against the players
 * and the whole scene looked wrong. White on green with a ground shadow is
 * findable at 5.
 */
export const BALL_MIN_SCREEN_PIXELS = 5;

/** Never inflate it past this, however far the camera pulls back. */
export const BALL_MAX_SCALE = 8;

/**
 * Scale to draw the ball at so it stays at least BALL_MIN_SCREEN_PIXELS across.
 *
 * Returns 1 whenever the ball is already big enough, which is everything
 * inside about 30 m, so close-up shots show a real-sized football and only
 * wide shots exaggerate. The growth is continuous in distance, so there is no
 * visible step as the camera pulls out.
 */
export function ballScaleForDistance(
  distance: number,
  verticalFovDegrees: number,
  viewportHeightPixels: number,
  minPixels: number = BALL_MIN_SCREEN_PIXELS,
): number {
  if (!(distance > 0) || !(viewportHeightPixels > 0) || !(verticalFovDegrees > 0)) {
    return 1;
  }
  const halfFov = (verticalFovDegrees * Math.PI) / 360;
  const metresPerPixel = (2 * distance * Math.tan(halfFov)) / viewportHeightPixels;
  const wantedRadius = (minPixels * metresPerPixel) / 2;
  const scale = wantedRadius / BALL_RADIUS;
  return Math.min(BALL_MAX_SCALE, Math.max(1, scale));
}
