# Player model

`player.glb` is currently `Soldier.glb` from the three.js examples
(https://github.com/mrdoob/three.js, MIT), used as a stand-in.

It is a genuine Mixamo rig -- 65 `mixamorig:` bones -- so the animation code
written against it is bone-compatible with a real Mixamo download.

## Swapping in Mixamo assets

Mixamo downloads require an Adobe ID login, so they cannot be fetched
automatically. To swap in your own:

1. On mixamo.com, pick a character and download it as **FBX** with the clips
   Idle, Jogging, Running and Soccer Pass. Tick **In Place** for the
   locomotion clips if the option is offered (the loader strips root motion
   anyway, so it is not critical).
2. Convert to a single `.glb` containing the mesh and all four clips, e.g. in
   Blender: import the character, import each animation FBX, then export glTF
   Binary with "Animation > Group by NLA Track" off.
3. Replace `public/models/player.glb`.

No code change is needed. `lib/playerModel.ts` resolves clips by name against a
candidate list that already covers both this stand-in ("Idle", "Walk", "Run")
and Mixamo's naming ("Idle", "Jogging", "Running", "Soccer Pass"), and the rig
is auto-scaled to 1.8 m regardless of the model's units.
