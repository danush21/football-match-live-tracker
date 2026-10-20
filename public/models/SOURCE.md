# Player model

`player.glb` is built from Mixamo downloads by `scripts/build-player-model.mjs`.
It is not edited by hand and is not the file you change to swap characters.

Current contents: Mixamo character **Ch38_nonPBR** (48,140 triangles, 65
`mixamorig5:` bones) plus 13 animation clips, 3.2 MB.

The character is modelled as one mesh per garment -- `Ch38_Shirt`,
`Ch38_Shorts`, `Ch38_Socks`, `Ch38_Shoes`, `Ch38_Body`, `Ch38_Hair` -- which is
what makes the kit system in `lib/kit.ts` possible without any shader work.
Those meshes were already separate draw calls, so dressing them individually
is free. Keep that split if you change character.

Two textures are kept, downscaled: the body atlas at 512px, without which
every player has a blank head, and the hair map at 256px for its alpha cutout.
The clothing half of the atlas is never sampled, because garments are flat
kit colour. The hair material's base colour alpha is forced back to 1 during
the build: Mixamo ships it at 0, which with `alphaMode: BLEND` makes the hair
invisible the moment it stops borrowing the body material.

## Clips

Four are driven by the renderer today:

| Clip | Role |
| --- | --- |
| `Idle` | speed < 0.5 m/s |
| `Jogging` | 0.5 - 4 m/s |
| `Running` | > 4 m/s |
| `Soccer Pass` | one-shot on PASS and SHOT events |

The rest are carried but not yet wired. They are here because this match's
event data contains things that could drive them, so wiring them up later
needs no new download:

| Clip | Events in Sample Game 1 |
| --- | --- |
| `Tackle` | 103 (subtype TACKLE) |
| `Header` | 53 (subtype HEAD) |
| `Throw In` | 28 (subtype THROW IN) |
| `Trip` / `Standing Up` | 22 (FAULT RECEIVED) |
| `Keeper Save` | 14 (subtype SAVED) |
| `Keeper Drop Kick` | 22 (subtype GOAL KICK) |
| `Keeper Idle` | keepers are `home_11` and `away_25` |
| `Walking` | would cover the slow end of the jog band |

## Rebuilding

Raw downloads live in `mixamo/` (gitignored). Put the character FBX and the
clip FBXs there, edit the `CLIPS` table at the top of
`scripts/build-player-model.mjs`, then:

    npm run build:model

Mixamo exports one clip per FBX and names every animation "mixamo.com"
regardless of content, so the script renames each clip after the role it
plays and merges them onto the single character. Textures are dropped: the
renderer replaces the character's material with a flat team colour anyway, and
the source maps were 38 MB of 2k PNGs that would never be sampled.

## Swapping the character

Nothing in `lib/` is specific to this model. Four things are measured off the
rig at load rather than hardcoded, each because guessing one broke something:

- `fitScale` - scales the rig to 1.8 m, whatever units the model uses.
- `detectForwardSign` - which axis the model calls forward. This character
  faces +Z; the previous stand-in faced -Z. Assuming it put every player on
  the pitch running backwards.
- `measureClipGroundSpeed` - the ground speed each locomotion clip depicts, so
  playback rate matches tracked speed and the feet do not skate. Calibrated by
  simulating the clip and minimising the toe's residual slip, not estimated
  from the pose: estimating read this rig's run clip at 3.3 m/s against a true
  6.1, and the feet slid for 77% of every stride.
- `measureKickContact` - where in the kick clip the foot meets the ball, so
  the strike lands on the event frame.

Clip roles resolve by name through `CLIP_CANDIDATES` in `lib/playerModel.ts`,
exact match first, which is why `Soccer Pass` wins the kick role over
`Keeper Drop Kick`.
