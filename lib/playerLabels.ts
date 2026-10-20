import { CanvasTexture, LinearFilter, SRGBColorSpace, type Texture } from "three";

/**
 * Jersey number labels, drawn to small canvases and shown as sprites.
 *
 * Sprites rather than DOM overlays: 22 absolutely-positioned HTML elements
 * would have to be moved every frame, where a sprite is just another object in
 * the scene. With sizeAttenuation off they also hold a constant size on screen,
 * so a number stays readable from the halfway line and does not swell into the
 * shot when the camera drops to pitch level.
 */

const WIDTH = 128;
const HEIGHT = 72;

/** Height of a label as a fraction of the viewport, via the sprite's scale. */
export const LABEL_SCALE = 0.019;
/** Metres above the ground the label floats, clear of a 2 m player's head. */
export const LABEL_HEIGHT = 2.42;

export interface LabelColours {
  readonly background: string;
  readonly text: string;
}

export const LABEL_DEFAULT: LabelColours = { background: "rgba(10,14,18,0.74)", text: "#f0f4f8" };
export const LABEL_SELECTED: LabelColours = { background: "#5aa9f0", text: "#08121c" };

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function createLabelTexture(jersey: number, colours: LabelColours): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("could not acquire a 2d context for a player label");

  const text = String(jersey);
  const padding = 10;
  ctx.font = "600 44px ui-sans-serif, system-ui, -apple-system, sans-serif";
  const width = Math.min(WIDTH - 4, ctx.measureText(text).width + padding * 2);
  const x = (WIDTH - width) / 2;

  ctx.fillStyle = colours.background;
  roundedRect(ctx, x, 8, width, HEIGHT - 16, (HEIGHT - 16) / 2);
  ctx.fill();

  ctx.fillStyle = colours.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 44px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText(text, WIDTH / 2, HEIGHT / 2 + 1);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/** Aspect of the label, so the sprite is not stretched. */
export const LABEL_ASPECT = WIDTH / HEIGHT;
