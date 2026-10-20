import type { MatchData, TeamSide } from "./types.ts";

/**
 * Kit colours and per-player appearance.
 *
 * The character is modelled as separate meshes per garment -- shirt, shorts,
 * socks, shoes, body, hair -- so dressing a player is just a matter of giving
 * each mesh its own material. No shader work or UV masking is needed, and it
 * costs nothing: those meshes were already separate draw calls.
 */

export interface Kit {
  readonly shirt: string;
  readonly shorts: string;
  readonly socks: string;
}

/** Outfield kits. Chosen to stay apart from each other and from the turf. */
export const TEAM_KITS: Readonly<Record<TeamSide, Kit>> = {
  home: { shirt: "#eef1f5", shorts: "#1b2a4a", socks: "#eef1f5" },
  away: { shirt: "#cf3b2f", shorts: "#8f2219", socks: "#cf3b2f" },
};

/** Keepers wear something distinct from both outfield kits, as in the laws. */
export const KEEPER_KITS: Readonly<Record<TeamSide, Kit>> = {
  home: { shirt: "#edc43c", shorts: "#2a2d33", socks: "#edc43c" },
  away: { shirt: "#3fb9a6", shorts: "#2a2d33", socks: "#3fb9a6" },
};

export const BOOT_COLOUR = "#15161a";

/**
 * Multiplied over the character's own skin texture, so these darken rather
 * than replace. One authored skin tone cannot be turned into any other by
 * tinting, but it does break up 22 identical twins.
 */
export const SKIN_TINTS: readonly string[] = [
  "#ffffff",
  "#f0d9c2",
  "#d9ab86",
  "#b07d58",
  "#8a5a3c",
  "#5f3d29",
];

export const HAIR_COLOURS: readonly string[] = [
  "#120d0a",
  "#2e1d12",
  "#5a3a1e",
  "#8a6233",
  "#c8a35c",
  "#8d8d92",
];

export type PlayerPart = "shirt" | "shorts" | "socks" | "boots" | "skin" | "hair";

/**
 * Which garment a mesh is, from its name.
 *
 * Checked longest-first so "shorts" is never mistaken for "shirt" and the
 * other way round. Anything unrecognised is treated as skin, which is the
 * safe default: an unknown mesh is far more likely to be part of the body
 * than a garment, and it keeps a strange model from rendering in kit colours.
 */
export function classifyPart(meshName: string): PlayerPart {
  const name = meshName.toLowerCase();
  if (name.includes("shorts")) return "shorts";
  if (name.includes("short")) return "shorts";
  if (name.includes("shirt") || name.includes("jersey") || name.includes("top")) return "shirt";
  if (name.includes("sock")) return "socks";
  if (name.includes("shoe") || name.includes("boot") || name.includes("cleat")) return "boots";
  if (name.includes("hair") || name.includes("eyelash") || name.includes("brow")) return "hair";
  return "skin";
}

export interface PlayerAppearance {
  readonly kit: Kit;
  readonly skin: string;
  readonly hair: string;
  readonly isKeeper: boolean;
}

/** Stable small hash so a player looks the same on every reload. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function appearanceFor(
  playerId: string,
  team: TeamSide,
  isKeeper: boolean,
): PlayerAppearance {
  const seed = hash(playerId);
  return {
    kit: isKeeper ? KEEPER_KITS[team] : TEAM_KITS[team],
    skin: SKIN_TINTS[seed % SKIN_TINTS.length]!,
    hair: HAIR_COLOURS[(seed >>> 8) % HAIR_COLOURS.length]!,
    isKeeper,
  };
}

/**
 * Work out which player is each team's goalkeeper.
 *
 * The source data gives no positions, so this is derived from where players
 * spend their time: a keeper lives within a few metres of a goal line while
 * outfielders average a third of the pitch away. Distance is taken to the
 * *nearer* goal, which sidesteps having to know which end a team is defending
 * and therefore survives the half time swap without special handling.
 */
export function detectGoalkeepers(match: MatchData): ReadonlySet<string> {
  const { meta, frames, entityIndex } = match;
  const { stride, absent, scale, frameCount } = meta.frames;
  const length = meta.pitch.length;

  const best = new Map<TeamSide, { id: string; mean: number }>();

  for (const player of meta.players) {
    const slot = entityIndex.get(player.id);
    if (slot === undefined) continue;

    let sum = 0;
    let seen = 0;
    // Every 25th frame, i.e. once a second. Plenty for a positional average.
    for (let i = 0; i < frameCount; i += 25) {
      const x = frames[i * stride + slot * 2]!;
      if (x === absent) continue;
      const metres = x / scale;
      sum += Math.min(Math.abs(metres), Math.abs(length - metres));
      seen += 1;
    }
    if (seen === 0) continue;

    const mean = sum / seen;
    const current = best.get(player.team);
    if (current === undefined || mean < current.mean) {
      best.set(player.team, { id: player.id, mean });
    }
  }

  return new Set([...best.values()].map((entry) => entry.id));
}
