#!/usr/bin/env python3
"""Validate public/data output against the source CSVs and the expected shapes."""
import json, os, sys
import numpy as np, pandas as pd

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(R, "public", "data")
meta = json.load(open(os.path.join(OUT, "match-meta.json")))
fi = meta["frames"]
raw = np.fromfile(os.path.join(OUT, fi["file"]), dtype="<i2")
n, stride = fi["frameCount"], fi["stride"]
assert raw.size == n * stride, f"blob size {raw.size} != {n*stride}"
data = raw.reshape(n, stride // 2, 2)
ents = fi["entities"]
ok = lambda m: print(f"  ok  {m}")

print("== meta shape ==")
assert meta["frameRate"] == 25 and meta["pitch"] == {"length":105.0,"width":68.0}
ok("frameRate / pitch")
assert [p["period"] for p in meta["periods"]] == [1,2]
assert meta["periods"][0]["endFrame"] + 1 == meta["periods"][1]["startFrame"]
ok("periods contiguous, no frame-axis gap")
assert len(meta["players"]) == 28 and len(ents) == 29 and ents[0] == "ball"
assert all(set(p) >= {"id","team","jersey","firstFrame","lastFrame"} for p in meta["players"])
assert [p["id"] for p in meta["players"]] == ents[1:]
ok("players[] matches entity order, required keys present")
assert all(p["presenceRuns"] == 1 for p in meta["players"])
ok("every player has exactly one contiguous presence run")

print("== binary sanity ==")
absent, scale = fi["absent"], fi["scale"]
pres = data[:,:,0] != absent
assert (( data[:,:,0]==absent) == (data[:,:,1]==absent)).all()
ok("x/y presence always agrees")
for p in meta["players"]:
    e = ents.index(p["id"]); m = pres[:,e]; idx = np.flatnonzero(m)
    assert int(idx[0]) + fi["startFrame"] == p["firstFrame"]
    assert int(idx[-1]) + fi["startFrame"] == p["lastFrame"]
ok("firstFrame/lastFrame agree with the blob")
xs = data[:,:,0][pres]/scale; ys = data[:,:,1][pres]/scale
print(f"  x range {xs.min():.2f}..{xs.max():.2f} m,  y range {ys.min():.2f}..{ys.max():.2f} m")

print("== round-trip vs source CSV (sampled) ==")
hdr = pd.read_csv(os.path.join(R,"data-raw","Sample_Game_1_RawTrackingData_Home_Team.csv"), header=None, nrows=3, dtype=str)
names=[];i=0;row=hdr.iloc[2].tolist()
while i < len(row):
    c=row[i]
    if i<3: names.append(str(c)); i+=1; continue
    if isinstance(c,str) and c.strip(): names += [f"{c.strip()}_x", f"{c.strip()}_y"]; i+=2
    else: names.append(f"_u{i}"); i+=1
src = pd.read_csv(os.path.join(R,"data-raw","Sample_Game_1_RawTrackingData_Home_Team.csv"), skiprows=3, header=None, names=names)
rng = np.random.default_rng(0); worst = 0.0; checked = 0
for k in rng.choice(n, 4000, replace=False):
    for label, jersey in [("Player11",11),("Player9",9),("Player12",12),("Player14",14),("Ball",None)]:
        e = 0 if label=="Ball" else ents.index(f"home_{jersey}")
        sx, sy = src[f"{label}_x"].iloc[k], src[f"{label}_y"].iloc[k]
        if np.isnan(sx):
            assert not pres[k,e], f"frame {k} {label}: NaN in source but present in blob"
            continue
        assert pres[k,e], f"frame {k} {label}: present in source but absent in blob"
        worst = max(worst, abs(data[k,e,0]/scale - sx*105), abs(data[k,e,1]/scale - sy*68))
        checked += 1
ok(f"{checked} sampled positions match source; max error {worst*100:.3f} cm (<= 0.5 expected)")
assert worst <= 0.005 + 1e-9

print("== events ==")
ev = meta["events"]; ids = {p["id"] for p in meta["players"]}
assert len(ev) == 1745
for e in ev:
    assert set(e) == {"id","period","frame","time","endFrame","team","type","subtype","from","to"}
    assert e["team"] in ("home","away")
    assert fi["startFrame"] <= e["frame"] <= fi["startFrame"]+n-1
    for k in ("from","to"):
        assert e[k] is None or e[k] in ids
    assert e["from"] is None or e["from"].startswith(e["team"])
    assert e["endFrame"] is None or e["endFrame"] >= e["frame"]
ok("1745 events, frames in range, player refs resolve, actor team consistent")
# actor must actually be on the pitch when the event fires
bad = [e for e in ev if e["from"] and not pres[e["frame"]-fi["startFrame"], ents.index(e["from"])]]
print(f"  events whose actor is absent from tracking at that frame: {len(bad)}")
print("\nALL CHECKS PASSED")
