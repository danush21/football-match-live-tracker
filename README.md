# Football Match Live Tracker

Every player and the ball in 3D, in real time, from real optical tracking data —
145,006 frames, 96 minutes, 1,745 events, 25 times a second.

**What it is:** at 1x, the match runs at true pace, which is where "real time"
comes from. The data itself is a complete recorded match loaded up front — there
is no live feed and no streaming, just two fetches of static files at startup.
Every player is where a real footballer actually stood.

## Data

Tracking and event data: **[Metrica Sports Sample Game 1](https://github.com/metrica-sports/sample-data)**.
The data is anonymised — no player, team or competition names.

Metrica ask that any public use acknowledges the source. This README is
currently the only place that happens; there is no on-screen credit.

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
