#!/usr/bin/env bash
# Download the Metrica Sports Sample Game 1 CSVs that scripts/convert.py reads.
set -euo pipefail
BASE="https://raw.githubusercontent.com/metrica-sports/sample-data/master/data/Sample_Game_1"
DEST="$(cd "$(dirname "$0")/.." && pwd)/data-raw"
mkdir -p "$DEST"
for f in Sample_Game_1_RawTrackingData_Home_Team.csv \
         Sample_Game_1_RawTrackingData_Away_Team.csv \
         Sample_Game_1_RawEventsData.csv; do
  echo "fetching $f"
  curl -sSL -o "$DEST/$f" "$BASE/$f"
done
echo "done -> $DEST"
