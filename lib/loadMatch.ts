import { computeBallHeights } from "./ballHeight.ts";
import type {
  FramesIndex,
  MatchData,
  MatchEvent,
  MatchMeta,
  PeriodMeta,
  PlayerMeta,
  TeamSide,
} from "./types.ts";

/**
 * Parse-time validation for the static match assets.
 *
 * Everything the renderer relies on is checked here and nowhere else: if the
 * data is malformed, loadMatch() throws with a specific message rather than
 * letting a NaN or an off-by-one reach the render loop.
 */

class MatchDataError extends Error {
  constructor(message: string) {
    super(`match data: ${message}`);
    this.name = "MatchDataError";
  }
}

function fail(message: string): never {
  throw new MatchDataError(message);
}

function isRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

function asFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${where} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function asInt(value: unknown, where: string): number {
  const n = asFiniteNumber(value, where);
  if (!Number.isInteger(n)) fail(`${where} must be an integer, got ${n}`);
  return n;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${where} must be a non-empty string`);
  }
  return value;
}

function asNullableString(value: unknown, where: string): string | null {
  if (value === null) return null;
  return asString(value, where);
}

function asTeam(value: unknown, where: string): TeamSide {
  if (value !== "home" && value !== "away") {
    fail(`${where} must be "home" or "away", got ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePeriods(value: unknown): PeriodMeta[] {
  const raw = isArray(value, "periods");
  if (raw.length === 0) fail("periods must not be empty");
  const periods = raw.map((entry, i) => {
    const o = isRecord(entry, `periods[${i}]`);
    const period: PeriodMeta = {
      period: asInt(o["period"], `periods[${i}].period`),
      startFrame: asInt(o["startFrame"], `periods[${i}].startFrame`),
      endFrame: asInt(o["endFrame"], `periods[${i}].endFrame`),
    };
    if (period.endFrame < period.startFrame) {
      fail(`periods[${i}] ends (${period.endFrame}) before it starts (${period.startFrame})`);
    }
    return period;
  });
  for (let i = 1; i < periods.length; i += 1) {
    const prev = periods[i - 1]!;
    const cur = periods[i]!;
    if (cur.startFrame <= prev.endFrame) {
      fail(`periods[${i}] overlaps the previous period`);
    }
  }
  return periods;
}

function parsePlayers(value: unknown): PlayerMeta[] {
  const raw = isArray(value, "players");
  if (raw.length === 0) fail("players must not be empty");
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const o = isRecord(entry, `players[${i}]`);
    const player: PlayerMeta = {
      id: asString(o["id"], `players[${i}].id`),
      team: asTeam(o["team"], `players[${i}].team`),
      jersey: asInt(o["jersey"], `players[${i}].jersey`),
      firstFrame: asInt(o["firstFrame"], `players[${i}].firstFrame`),
      lastFrame: asInt(o["lastFrame"], `players[${i}].lastFrame`),
    };
    if (seen.has(player.id)) fail(`duplicate player id ${player.id}`);
    seen.add(player.id);
    if (player.lastFrame < player.firstFrame) {
      fail(`${player.id} leaves (${player.lastFrame}) before arriving (${player.firstFrame})`);
    }
    return player;
  });
}

function parseEvents(value: unknown, playerIds: ReadonlySet<string>): MatchEvent[] {
  const raw = isArray(value, "events");
  return raw.map((entry, i) => {
    const o = isRecord(entry, `events[${i}]`);
    const from = asNullableString(o["from"], `events[${i}].from`);
    const to = asNullableString(o["to"], `events[${i}].to`);
    for (const [key, id] of [["from", from], ["to", to]] as const) {
      if (id !== null && !playerIds.has(id)) {
        fail(`events[${i}].${key} references unknown player ${id}`);
      }
    }
    const endFrameRaw = o["endFrame"];
    return {
      id: asInt(o["id"], `events[${i}].id`),
      period: asInt(o["period"], `events[${i}].period`),
      frame: asInt(o["frame"], `events[${i}].frame`),
      time: asFiniteNumber(o["time"], `events[${i}].time`),
      endFrame: endFrameRaw === null ? null : asInt(endFrameRaw, `events[${i}].endFrame`),
      team: asTeam(o["team"], `events[${i}].team`),
      type: asString(o["type"], `events[${i}].type`),
      subtype: asNullableString(o["subtype"], `events[${i}].subtype`),
      from,
      to,
    } satisfies MatchEvent;
  });
}

function parseFramesIndex(value: unknown, players: readonly PlayerMeta[]): FramesIndex {
  const o = isRecord(value, "frames");
  const format = asString(o["format"], "frames.format");
  if (format !== "int16-le") fail(`unsupported frames.format ${format}`);

  const entitiesRaw = isArray(o["entities"], "frames.entities");
  const entities = entitiesRaw.map((e, i) => asString(e, `frames.entities[${i}]`));
  if (entities[0] !== "ball") fail('frames.entities[0] must be "ball"');

  const known = new Set(players.map((p) => p.id));
  for (let i = 1; i < entities.length; i += 1) {
    if (!known.has(entities[i]!)) fail(`frames.entities[${i}] is not a known player`);
  }
  if (new Set(entities).size !== entities.length) fail("frames.entities contains duplicates");
  if (entities.length !== players.length + 1) {
    fail(`frames.entities has ${entities.length} slots for ${players.length} players + ball`);
  }

  const index: FramesIndex = {
    file: asString(o["file"], "frames.file"),
    format: "int16-le",
    startFrame: asInt(o["startFrame"], "frames.startFrame"),
    frameCount: asInt(o["frameCount"], "frames.frameCount"),
    stride: asInt(o["stride"], "frames.stride"),
    scale: asFiniteNumber(o["scale"], "frames.scale"),
    absent: asInt(o["absent"], "frames.absent"),
    entities,
  };
  if (index.frameCount <= 0) fail("frames.frameCount must be positive");
  if (index.scale <= 0) fail("frames.scale must be positive");
  if (index.stride !== entities.length * 2) {
    fail(`frames.stride ${index.stride} != 2 * ${entities.length} entities`);
  }
  if (index.absent < -32768 || index.absent > 32767) {
    fail("frames.absent is not representable as int16");
  }
  return index;
}

function parseMeta(value: unknown): MatchMeta {
  const o = isRecord(value, "match-meta.json");
  const frameRate = asFiniteNumber(o["frameRate"], "frameRate");
  if (frameRate <= 0) fail("frameRate must be positive");

  const pitchRaw = isRecord(o["pitch"], "pitch");
  const pitch = {
    length: asFiniteNumber(pitchRaw["length"], "pitch.length"),
    width: asFiniteNumber(pitchRaw["width"], "pitch.width"),
  };
  if (pitch.length <= 0 || pitch.width <= 0) fail("pitch dimensions must be positive");

  const periods = parsePeriods(o["periods"]);
  const players = parsePlayers(o["players"]);
  const frames = parseFramesIndex(o["frames"], players);
  const events = parseEvents(o["events"], new Set(players.map((p) => p.id)));

  const lastFrame = frames.startFrame + frames.frameCount - 1;
  for (const p of periods) {
    if (p.startFrame < frames.startFrame || p.endFrame > lastFrame) {
      fail(`period ${p.period} (${p.startFrame}-${p.endFrame}) falls outside the frame blob`);
    }
  }
  for (const p of players) {
    if (p.firstFrame < frames.startFrame || p.lastFrame > lastFrame) {
      fail(`${p.id} (${p.firstFrame}-${p.lastFrame}) falls outside the frame blob`);
    }
  }
  for (const e of events) {
    if (e.frame < frames.startFrame || e.frame > lastFrame) {
      fail(`event ${e.id} at frame ${e.frame} falls outside the frame blob`);
    }
  }

  return { frameRate, pitch, periods, players, frames, events };
}

/** Little-endian int16 decode that is correct on a big-endian host too. */
function decodeInt16LE(buffer: ArrayBuffer, expectedLength: number): Int16Array {
  if (buffer.byteLength !== expectedLength * 2) {
    fail(
      `frames blob is ${buffer.byteLength} bytes, expected ${expectedLength * 2} ` +
        `(frameCount * stride * 2)`,
    );
  }
  const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (littleEndianHost) return new Int16Array(buffer);

  const view = new DataView(buffer);
  const out = new Int16Array(expectedLength);
  for (let i = 0; i < expectedLength; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Assemble validated match data from an already-fetched meta object and blob. */
export function buildMatchData(metaJson: unknown, buffer: ArrayBuffer): MatchData {
  const meta = parseMeta(metaJson);
  const frames = decodeInt16LE(buffer, meta.frames.frameCount * meta.frames.stride);

  const entityIndex = new Map<string, number>();
  meta.frames.entities.forEach((id, i) => entityIndex.set(id, i));

  return {
    meta,
    frames,
    entityIndex,
    durationSeconds: (meta.frames.frameCount - 1) / meta.frameRate,
    ballHeights: computeBallHeights(meta),
  };
}

export async function loadMatch(basePath = "/data", signal?: AbortSignal): Promise<MatchData> {
  const metaUrl = `${basePath}/match-meta.json`;
  const metaResponse = await fetch(metaUrl, signal ? { signal } : {});
  if (!metaResponse.ok) {
    fail(`GET ${metaUrl} returned ${metaResponse.status} ${metaResponse.statusText}`);
  }
  const metaJson = (await metaResponse.json()) as unknown;

  // Parse the index first so we know which blob to ask for.
  const framesFile = parseMeta(metaJson).frames.file;
  const framesUrl = `${basePath}/${framesFile}`;
  const framesResponse = await fetch(framesUrl, signal ? { signal } : {});
  if (!framesResponse.ok) {
    fail(`GET ${framesUrl} returned ${framesResponse.status} ${framesResponse.statusText}`);
  }
  const buffer = await framesResponse.arrayBuffer();

  return buildMatchData(metaJson, buffer);
}

export { MatchDataError };
