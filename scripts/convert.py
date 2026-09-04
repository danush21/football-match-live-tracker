#!/usr/bin/env python3
"""
Convert Metrica Sports "Sample Game 1" tracking + event CSVs into static assets
for the 3D replay viewer.

Source: https://github.com/metrica-sports/sample-data

Verified facts about the real CSVs (do not trust docs, these were measured):
  * Three header rows. Row 0 = team name, row 1 = jersey number, row 2 = column
    names. A player occupies TWO columns; only the first carries the name, so
    row 2 looks like  Period,Frame,Time [s],Player11,,Player1,,...,Ball,
  * Column order is Period, Frame, Time [s] -- NOT Frame, Period, Time.
  * Frames are 1-based, contiguous 1..145006, 25 fps. Time [s] == Frame * 0.04
    exactly, and runs continuously across the period break (no halftime gap in
    the frame axis) -- but the teams DO swap ends, so positions jump at the
    boundary and must never be interpolated across it.
  * Period 1 = frames 1..71268, period 2 = frames 71269..145006.
  * Coordinates are normalized to roughly 0..1 but legitimately exceed that
    range (x -0.045..1.060, y -0.050..1.050) when play goes off the pitch.
  * Ball_x/Ball_y appear in BOTH team files and are bit-identical; read once.
  * The ball is NaN for 56755 frames (39%) in 155 contiguous runs -- dead time.
  * 14 players per team (28 total). Substituted players have exactly one
    contiguous presence run, with a single-frame overlap at the swap.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

FRAME_RATE = 25
PITCH_LENGTH = 105.0
PITCH_WIDTH = 68.0

# int16 sentinel for "this entity has no position in this frame".
ABSENT = -32768
# Coordinates are stored as centimetres, i.e. metres rounded to 2 decimals.
SCALE = 100

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(REPO_ROOT, "data-raw")
OUT_DIR = os.path.join(REPO_ROOT, "public", "data")


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def read_tracking(side: str) -> Tuple[pd.DataFrame, List[Tuple[str, int]]]:
    """Return (dataframe, [(player_column_prefix, jersey), ...]) for one team."""
    path = os.path.join(RAW_DIR, f"Sample_Game_1_RawTrackingData_{side}_Team.csv")
    if not os.path.exists(path):
        sys.exit(f"missing input: {path}")

    header = pd.read_csv(path, header=None, nrows=3, dtype=str)
    team_row = header.iloc[0].tolist()
    jersey_row = header.iloc[1].tolist()
    name_row = header.iloc[2].tolist()

    names: List[str] = []
    roster: List[Tuple[str, int]] = []
    i = 0
    while i < len(name_row):
        cell = name_row[i]
        if i < 3:
            names.append(str(cell))
            i += 1
            continue
        if isinstance(cell, str) and cell.strip():
            label = cell.strip()
            names.append(f"{label}_x")
            names.append(f"{label}_y")
            if label != "Ball":
                jersey = jersey_row[i]
                if not (isinstance(jersey, str) and jersey.strip().isdigit()):
                    sys.exit(f"{side}: no jersey number for column {label!r}")
                team_label = team_row[i]
                if not (isinstance(team_label, str) and team_label.strip().lower() == side.lower()):
                    sys.exit(f"{side}: column {label!r} is labelled team {team_label!r}")
                roster.append((label, int(jersey.strip())))
            i += 2
        else:
            names.append(f"_unused{i}")
            i += 1

    df = pd.read_csv(path, skiprows=3, header=None, names=names)

    for required in ("Period", "Frame", "Time [s]", "Ball_x", "Ball_y"):
        if required not in df.columns:
            sys.exit(f"{side}: expected column {required!r} not found; CSV layout changed")

    return df, roster


def read_events(jersey_to_id: Dict[int, str]) -> List[dict]:
    path = os.path.join(RAW_DIR, "Sample_Game_1_RawEventsData.csv")
    if not os.path.exists(path):
        sys.exit(f"missing input: {path}")
    ev = pd.read_csv(path)

    expected = ["Team", "Type", "Subtype", "Period", "Start Frame", "Start Time [s]",
                "End Frame", "End Time [s]", "From", "To", "Start X", "Start Y",
                "End X", "End Y"]
    missing = [c for c in expected if c not in ev.columns]
    if missing:
        sys.exit(f"events CSV missing columns: {missing}")

    def player_id(cell: object) -> Optional[str]:
        if not isinstance(cell, str) or not cell.startswith("Player"):
            return None
        jersey = int(cell[len("Player"):])
        pid = jersey_to_id.get(jersey)
        if pid is None:
            sys.exit(f"events reference unknown player {cell!r}")
        return pid

    def opt_str(cell: object) -> Optional[str]:
        return cell.strip() if isinstance(cell, str) and cell.strip() else None

    out: List[dict] = []
    for idx, row in ev.iterrows():
        team = str(row["Team"]).strip().lower()
        if team not in ("home", "away"):
            sys.exit(f"events row {idx}: unexpected team {row['Team']!r}")
        start_frame = int(row["Start Frame"])
        end_frame_raw = int(row["End Frame"])
        # Exactly one row (the opening kick off) carries End Frame == 0.
        end_frame = end_frame_raw if end_frame_raw >= start_frame else None
        actor = player_id(row["From"])
        if actor is not None and not actor.startswith(team):
            sys.exit(f"events row {idx}: {row['From']!r} does not belong to {team}")
        out.append({
            "id": int(idx),
            "period": int(row["Period"]),
            "frame": start_frame,
            "time": round(float(row["Start Time [s]"]), 2),
            "endFrame": end_frame,
            "team": team,
            "type": str(row["Type"]).strip(),
            "subtype": opt_str(row["Subtype"]),
            "from": actor,
            "to": player_id(row["To"]),
        })
    return out


# --------------------------------------------------------------------------
# Encoding
# --------------------------------------------------------------------------

def to_int16(metres: np.ndarray) -> np.ndarray:
    """Round metres to centimetres as int16, mapping NaN to the ABSENT sentinel."""
    out = np.full(metres.shape, ABSENT, dtype=np.int16)
    present = ~np.isnan(metres)
    if present.any():
        vals = np.rint(metres[present] * SCALE)
        lo, hi = float(vals.min()), float(vals.max())
        if lo <= ABSENT or hi > 32767:
            sys.exit(f"coordinate {lo/SCALE}..{hi/SCALE} m does not fit int16 at cm precision")
        out[present] = vals.astype(np.int16)
    return out


def presence_runs(mask: np.ndarray) -> int:
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return 0
    return int(np.count_nonzero(np.diff(idx) != 1) + 1)


def frame_to_json_obj(k: int, frames: np.ndarray, data: np.ndarray,
                      entities: Sequence[str]) -> dict:
    """Build the brief's frame shape for frame index k (used for size measurement)."""
    obj: dict = {"f": int(frames[k]), "t": round(int(frames[k]) / FRAME_RATE, 2)}
    players: Dict[str, List[float]] = {}
    for e, name in enumerate(entities):
        x, y = int(data[k, e, 0]), int(data[k, e, 1])
        if x == ABSENT or y == ABSENT:
            continue
        pos = [round(x / SCALE, 2), round(y / SCALE, 2)]
        if name == "ball":
            obj["ball"] = pos
        else:
            players[name] = pos
    obj["players"] = players
    return obj


def write_json_frames(path: str, indices: Sequence[int], frames: np.ndarray,
                      data: np.ndarray, entities: Sequence[str]) -> int:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('{"startFrame":%d,"frames":[' % int(frames[indices[0]]))
        for n, k in enumerate(indices):
            if n:
                fh.write(",")
            fh.write(json.dumps(frame_to_json_obj(k, frames, data, entities),
                                separators=(",", ":")))
        fh.write("]}")
    return os.path.getsize(path)


def human(nbytes: int) -> str:
    return f"{nbytes / (1024 * 1024):.1f} MB"


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--measure", action="store_true",
                    help="also write and measure the plain-JSON variants, then delete them")
    args = ap.parse_args()

    print("reading tracking data...")
    home_df, home_roster = read_tracking("Home")
    away_df, away_roster = read_tracking("Away")

    if len(home_df) != len(away_df):
        sys.exit("home and away tracking files have different row counts")
    if not home_df["Frame"].equals(away_df["Frame"]):
        sys.exit("home and away tracking files have different frame numbering")

    frames = home_df["Frame"].to_numpy()
    periods = home_df["Period"].to_numpy()
    n = len(frames)

    if not np.array_equal(np.diff(frames), np.ones(n - 1, dtype=frames.dtype)):
        sys.exit("frame numbers are not contiguous; the interpolator assumes they are")

    # Time [s] must be exactly Frame / 25 for the client to derive time from frame.
    drift = np.abs(home_df["Time [s]"].to_numpy() - frames / FRAME_RATE).max()
    if drift > 1e-6:
        sys.exit(f"Time [s] deviates from Frame/{FRAME_RATE} by up to {drift}s")

    # The ball is duplicated across both files; confirm before dropping one copy.
    for axis in ("Ball_x", "Ball_y"):
        a, b = home_df[axis].to_numpy(), away_df[axis].to_numpy()
        if not np.array_equal(a, b, equal_nan=True):
            sys.exit(f"{axis} differs between the home and away files")

    # ---- roster -------------------------------------------------------
    jersey_to_id: Dict[int, str] = {}
    players_meta: List[dict] = []
    entities: List[str] = ["ball"]
    columns: List[Tuple[pd.DataFrame, str]] = [(home_df, "Ball")]

    for df, roster, team in ((home_df, home_roster, "home"), (away_df, away_roster, "away")):
        for label, jersey in sorted(roster, key=lambda r: r[1]):
            pid = f"{team}_{jersey}"
            if jersey in jersey_to_id:
                sys.exit(f"jersey {jersey} is used by two players; ids would collide")
            jersey_to_id[jersey] = pid
            entities.append(pid)
            columns.append((df, label))
            mask = ~np.isnan(df[f"{label}_x"].to_numpy())
            if not mask.any():
                sys.exit(f"{pid} has no positions at all")
            idx = np.flatnonzero(mask)
            players_meta.append({
                "id": pid,
                "team": team,
                "jersey": jersey,
                "firstFrame": int(frames[idx[0]]),
                "lastFrame": int(frames[idx[-1]]),
                "presenceRuns": presence_runs(mask),
            })

    # ---- pack ---------------------------------------------------------
    print(f"packing {n} frames x {len(entities)} entities...")
    data = np.full((n, len(entities), 2), ABSENT, dtype=np.int16)
    for e, (df, label) in enumerate(columns):
        data[:, e, 0] = to_int16(df[f"{label}_x"].to_numpy(dtype=np.float64) * PITCH_LENGTH)
        data[:, e, 1] = to_int16(df[f"{label}_y"].to_numpy(dtype=np.float64) * PITCH_WIDTH)

    # A position must be fully present or fully absent, never half.
    half = (data[:, :, 0] == ABSENT) != (data[:, :, 1] == ABSENT)
    if half.any():
        sys.exit(f"{int(half.sum())} entity-frames have exactly one of x/y missing")

    present = data[:, :, 0] != ABSENT
    per_team: Dict[str, np.ndarray] = {}
    for team in ("home", "away"):
        cols = [i for i, name in enumerate(entities) if name.startswith(team + "_")]
        per_team[team] = present[:, cols].sum(axis=1)

    period_meta = []
    for p in sorted(set(int(v) for v in periods)):
        sel = np.flatnonzero(periods == p)
        period_meta.append({
            "period": p,
            "startFrame": int(frames[sel[0]]),
            "endFrame": int(frames[sel[-1]]),
        })

    events = read_events(jersey_to_id)

    # ---- write --------------------------------------------------------
    os.makedirs(OUT_DIR, exist_ok=True)
    bin_path = os.path.join(OUT_DIR, "frames.bin")
    data.astype("<i2").tofile(bin_path)
    bin_size = os.path.getsize(bin_path)

    meta = {
        "frameRate": FRAME_RATE,
        "pitch": {"length": PITCH_LENGTH, "width": PITCH_WIDTH},
        "periods": period_meta,
        "players": players_meta,
        "frames": {
            "file": "frames.bin",
            "format": "int16-le",
            "startFrame": int(frames[0]),
            "frameCount": n,
            "stride": len(entities) * 2,
            "scale": SCALE,
            "absent": ABSENT,
            "entities": entities,
            # time in seconds == frame / frameRate, so it is not stored per frame
        },
        "events": events,
    }
    meta_path = os.path.join(OUT_DIR, "match-meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    meta_size = os.path.getsize(meta_path)

    # ---- report -------------------------------------------------------
    ball_present = int(present[:, 0].sum())
    print()
    print("=" * 62)
    print(f"frames            : {n}  ({frames[0]}..{frames[-1]}) @ {FRAME_RATE}fps"
          f" = {n / FRAME_RATE / 60:.1f} min")
    print(f"periods           : " + ", ".join(
        f"P{m['period']} {m['startFrame']}-{m['endFrame']}" for m in period_meta))
    print(f"players           : {len(players_meta)} "
          f"(home {len(home_roster)}, away {len(away_roster)})")
    print(f"on-pitch per frame: home {per_team['home'].min()}-{per_team['home'].max()}, "
          f"away {per_team['away'].min()}-{per_team['away'].max()}")
    print(f"ball present      : {ball_present}/{n} frames ({100*ball_present/n:.1f}%)")
    print(f"events            : {len(events)} "
          f"({sum(1 for e in events if e['type'] in ('PASS','SHOT'))} PASS/SHOT)")
    print("-" * 62)
    print(f"frames.bin        : {human(bin_size)}  ({bin_size} bytes, "
          f"{meta['frames']['stride'] * 2} bytes/frame)")
    print(f"match-meta.json   : {human(meta_size)}")
    print(f"TOTAL             : {human(bin_size + meta_size)}")
    print("=" * 62)

    if args.measure:
        print("\nmeasuring plain-JSON alternatives (temporary files)...")
        tmp = os.path.join(OUT_DIR, "_measure.json")

        full = list(range(n))
        size_full = write_json_frames(tmp, full, frames, data, entities)
        print(f"  option 0  frames.json @ 25fps : {human(size_full)}")

        # 25 -> 10 fps needs a non-integer stride; land on the nearest source frame.
        ten = sorted(set(int(round(k * FRAME_RATE / 10)) for k in range(int(n * 10 / FRAME_RATE))))
        ten = [k for k in ten if k < n]
        size_ten = write_json_frames(tmp, ten, frames, data, entities)
        print(f"  option 1  frames.json @ 10fps : {human(size_ten)}  ({len(ten)} frames)")
        print(f"  option 2  per-minute chunks   : {human(size_full)} total across "
              f"{int(np.ceil(n / (FRAME_RATE * 60)))} files")
        print(f"  option 3  frames.bin (chosen) : {human(bin_size)}")
        os.remove(tmp)


if __name__ == "__main__":
    main()
