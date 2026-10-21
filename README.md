# Football Match Replay

A browser app that replays a real, recorded football match in 3D. All 22 players
and the ball are animated from genuine optical tracking data at 25fps — 145,006
frames, 96 minutes, 1,745 events.

It is a **recording, not a live feed and not a simulation**: every player is
where a real footballer actually stood. There is no network connection beyond
two fetches of static files at startup.

## Data

Tracking and event data: **[Metrica Sports Sample Game 1](https://github.com/metrica-sports/sample-data)**.
The data is anonymised — no player, team or competition names. Metrica ask that
any public use acknowledges the source, which the app does in its bottom corner.

## Running it

```bash
npm install
npm run dev
```

The match assets in `public/data/` are committed, so it runs without any setup.
To regenerate them from the raw CSVs:

```bash
./scripts/fetch-data.sh      # downloads the Metrica CSVs into data-raw/
python3 scripts/convert.py   # writes public/data/{match-meta.json,frames.bin}
python3 scripts/validate.py  # round-trips the output against the source CSVs
```

`convert.py` needs pandas. The 16 MB `frames.bin` is int16 centimetres rather
than JSON: full-fidelity JSON measured 77.8 MB, and 10fps JSON still 31.1 MB.

## Player model

`public/models/player.glb` is built from Mixamo downloads by
`scripts/build-player-model.mjs`. See `public/models/SOURCE.md` for how to swap
the character. Nothing in `lib/` is specific to the model — scale, forward axis,
clip ground speeds and kick contact are all measured off the rig at load.

## Checks

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # 40 tests, no browser needed
npm run build       # production build
```

## Deploying

The app is fully static — no server, no database, no API routes. Any static or
Next.js host works. `.vercelignore` keeps the raw FBX downloads, the brag video
and the source CSVs out of the upload; the deployed payload is about 20 MB,
almost all of it `frames.bin` and `player.glb`.

Note that every visitor downloads those assets once, so watch bandwidth if it
gets traffic.
