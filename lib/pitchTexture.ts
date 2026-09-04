import { CanvasTexture, LinearFilter, SRGBColorSpace, type Texture } from "three";

/**
 * Draws regulation pitch markings to an offscreen canvas and returns it as a
 * texture. Generated rather than shipped as an image so the markings stay
 * correct if the pitch dimensions in match-meta.json ever change.
 *
 * Canvas space maps 1:1 onto pitch space (x along the length, y across the
 * width, corner origin), so every constant below is in metres.
 */

const LINE_WIDTH = 0.12;
const CENTRE_CIRCLE_RADIUS = 9.15;
const PENALTY_AREA_DEPTH = 16.5;
const PENALTY_AREA_HALF_WIDTH = 20.16;
const GOAL_AREA_DEPTH = 5.5;
const GOAL_AREA_HALF_WIDTH = 9.16;
const PENALTY_SPOT_DISTANCE = 11;
const CORNER_ARC_RADIUS = 1;
const SPOT_RADIUS = 0.16;

const TURF_DARK = "#2c6b3f";
const TURF_LIGHT = "#31753f";
const LINE_COLOUR = "rgba(255,255,255,0.82)";

/** Texture pixels per metre. 40 keeps a 12cm line ~5px wide. */
const PIXELS_PER_METRE = 40;

export function createPitchTexture(length: number, width: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(length * PIXELS_PER_METRE);
  canvas.height = Math.round(width * PIXELS_PER_METRE);

  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("could not acquire a 2d context for the pitch texture");

  ctx.scale(PIXELS_PER_METRE, PIXELS_PER_METRE);

  // Mown stripes, purely to give the eye something to judge motion against.
  const stripes = 12;
  const stripeWidth = length / stripes;
  for (let i = 0; i < stripes; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? TURF_DARK : TURF_LIGHT;
    ctx.fillRect(i * stripeWidth, 0, stripeWidth, width);
  }

  ctx.strokeStyle = LINE_COLOUR;
  ctx.fillStyle = LINE_COLOUR;
  ctx.lineWidth = LINE_WIDTH;

  const halfWidth = width / 2;
  const halfLength = length / 2;

  // Touchlines and goal lines. Inset by half a line width so the line sits
  // inside the field of play, as the laws require.
  const h = LINE_WIDTH / 2;
  ctx.strokeRect(h, h, length - LINE_WIDTH, width - LINE_WIDTH);

  // Halfway line and centre circle.
  ctx.beginPath();
  ctx.moveTo(halfLength, 0);
  ctx.lineTo(halfLength, width);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(halfLength, halfWidth, CENTRE_CIRCLE_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(halfLength, halfWidth, SPOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // Both ends: penalty area, goal area, penalty spot, and the D.
  for (const side of [0, 1] as const) {
    const goalLine = side === 0 ? 0 : length;
    const inward = side === 0 ? 1 : -1;

    ctx.strokeRect(
      goalLine,
      halfWidth - PENALTY_AREA_HALF_WIDTH,
      PENALTY_AREA_DEPTH * inward,
      PENALTY_AREA_HALF_WIDTH * 2,
    );
    ctx.strokeRect(
      goalLine,
      halfWidth - GOAL_AREA_HALF_WIDTH,
      GOAL_AREA_DEPTH * inward,
      GOAL_AREA_HALF_WIDTH * 2,
    );

    const spotX = goalLine + PENALTY_SPOT_DISTANCE * inward;
    ctx.beginPath();
    ctx.arc(spotX, halfWidth, SPOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // The D is the part of the penalty arc outside the penalty area.
    const reach = PENALTY_AREA_DEPTH - PENALTY_SPOT_DISTANCE;
    const half = Math.acos(reach / CENTRE_CIRCLE_RADIUS);
    const centre = side === 0 ? 0 : Math.PI;
    ctx.beginPath();
    ctx.arc(spotX, halfWidth, CENTRE_CIRCLE_RADIUS, centre - half, centre + half);
    ctx.stroke();
  }

  // Corner arcs, one quadrant each.
  const corners = [
    { x: 0, y: 0, start: 0 },
    { x: length, y: 0, start: Math.PI / 2 },
    { x: length, y: width, start: Math.PI },
    { x: 0, y: width, start: -Math.PI / 2 },
  ] as const;
  for (const c of corners) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, CORNER_ARC_RADIUS, c.start, c.start + Math.PI / 2);
    ctx.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  return texture;
}
