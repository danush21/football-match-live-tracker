/** Shapes of the static assets emitted by scripts/convert.py. */

export type TeamSide = "home" | "away";

export interface PitchDimensions {
  /** Goal line to goal line, metres. */
  readonly length: number;
  /** Touchline to touchline, metres. */
  readonly width: number;
}

export interface PeriodMeta {
  readonly period: number;
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface PlayerMeta {
  readonly id: string;
  readonly team: TeamSide;
  readonly jersey: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
}

export interface MatchEvent {
  readonly id: number;
  readonly period: number;
  readonly frame: number;
  readonly time: number;
  readonly endFrame: number | null;
  readonly team: TeamSide;
  readonly type: string;
  readonly subtype: string | null;
  /** Player id of the actor, or null when the source names no player. */
  readonly from: string | null;
  readonly to: string | null;
}

/** Index describing the layout of frames.bin. */
export interface FramesIndex {
  readonly file: string;
  readonly format: "int16-le";
  /** Source frame number of blob index 0. */
  readonly startFrame: number;
  readonly frameCount: number;
  /** int16 values per frame: entities.length * 2. */
  readonly stride: number;
  /** Stored value / scale = metres. */
  readonly scale: number;
  /** Sentinel meaning "no position for this entity in this frame". */
  readonly absent: number;
  /** Entity id per slot, in blob order. entities[0] is always "ball". */
  readonly entities: readonly string[];
}

export interface MatchMeta {
  readonly frameRate: number;
  readonly pitch: PitchDimensions;
  readonly periods: readonly PeriodMeta[];
  readonly players: readonly PlayerMeta[];
  readonly frames: FramesIndex;
  readonly events: readonly MatchEvent[];
}

export interface MatchData {
  readonly meta: MatchMeta;
  /** frameCount * stride little-endian int16s, in host order after decode. */
  readonly frames: Int16Array;
  /** Index into frames.entities, by player id. */
  readonly entityIndex: ReadonlyMap<string, number>;
  readonly durationSeconds: number;
  /**
   * Inferred height of the ball's centre per frame, metres. Not present in the
   * source, which is 2D; see lib/ballHeight.ts for what it is derived from.
   */
  readonly ballHeights: Float32Array;
}
