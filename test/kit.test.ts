/** Kit assignment and goalkeeper detection. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  HAIR_COLOURS,
  SKIN_TINTS,
  appearanceFor,
  classifyPart,
  detectGoalkeepers,
} from "../lib/kit.ts";
import { buildMatchData } from "../lib/loadMatch.ts";
import type { MatchData } from "../lib/types.ts";

const DATA = path.join(import.meta.dirname, "..", "public", "data");

async function loadFromDisk(): Promise<MatchData> {
  const metaJson: unknown = JSON.parse(await readFile(path.join(DATA, "match-meta.json"), "utf8"));
  const buf = await readFile(path.join(DATA, "frames.bin"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return buildMatchData(metaJson, ab);
}

const match = await loadFromDisk();

test("garment meshes are classified correctly", () => {
  // The names this character actually uses.
  assert.equal(classifyPart("Ch38_Shirt"), "shirt");
  assert.equal(classifyPart("Ch38_Shorts"), "shorts", "shorts must not be read as shirt");
  assert.equal(classifyPart("Ch38_Socks"), "socks");
  assert.equal(classifyPart("Ch38_Shoes"), "boots");
  assert.equal(classifyPart("Ch38_Body"), "skin");
  assert.equal(classifyPart("Ch38_Hair"), "hair");
  assert.equal(classifyPart("Ch38_Eyelashes"), "hair");
  // An unknown mesh falls back to skin rather than being painted in kit colours.
  assert.equal(classifyPart("Ch99_SomethingElse"), "skin");
});

test("appearance is stable and varied", () => {
  const a = appearanceFor("home_7", "home", false);
  const b = appearanceFor("home_7", "home", false);
  assert.deepEqual(a, b, "same player must look the same every load");

  const skins = new Set<string>();
  const hairs = new Set<string>();
  for (const player of match.meta.players) {
    const look = appearanceFor(player.id, player.team, false);
    assert.ok(SKIN_TINTS.includes(look.skin));
    assert.ok(HAIR_COLOURS.includes(look.hair));
    skins.add(look.skin);
    hairs.add(look.hair);
  }
  console.log(`    ${skins.size} skin tones and ${hairs.size} hair colours across 28 players`);
  assert.ok(skins.size >= 4, "players should not all share one skin tone");
  assert.ok(hairs.size >= 4, "players should not all share one hair colour");
});

test("the two teams never wear the same shirt", () => {
  const home = appearanceFor("home_7", "home", false);
  const away = appearanceFor("away_20", "away", false);
  assert.notEqual(home.kit.shirt, away.kit.shirt);

  // Keepers differ from their own outfielders and from each other.
  const homeKeeper = appearanceFor("home_11", "home", true);
  const awayKeeper = appearanceFor("away_25", "away", true);
  for (const keeper of [homeKeeper, awayKeeper]) {
    assert.notEqual(keeper.kit.shirt, home.kit.shirt);
    assert.notEqual(keeper.kit.shirt, away.kit.shirt);
  }
  assert.notEqual(homeKeeper.kit.shirt, awayKeeper.kit.shirt);
});

test("goalkeepers are found from where they stand", () => {
  const keepers = detectGoalkeepers(match);
  console.log(`    detected keepers: ${[...keepers].sort().join(", ")}`);
  assert.equal(keepers.size, 2, "exactly one keeper per team");

  const byId = new Map(match.meta.players.map((p) => [p.id, p]));
  const teams = new Set([...keepers].map((id) => byId.get(id)!.team));
  assert.equal(teams.size, 2, "one from each team");

  // Independent check: a keeper must be far closer to a goal line than the
  // median outfielder, or the detection has latched onto the wrong player.
  const { stride, absent, scale, frameCount } = match.meta.frames;
  const meanToGoal = (id: string): number => {
    const slot = match.entityIndex.get(id)!;
    let sum = 0;
    let seen = 0;
    for (let i = 0; i < frameCount; i += 25) {
      const x = match.frames[i * stride + slot * 2]!;
      if (x === absent) continue;
      const m = x / scale;
      sum += Math.min(Math.abs(m), Math.abs(match.meta.pitch.length - m));
      seen += 1;
    }
    return sum / seen;
  };

  const outfield = match.meta.players
    .filter((p) => !keepers.has(p.id))
    .map((p) => meanToGoal(p.id))
    .sort((a, b) => a - b);
  const medianOutfield = outfield[Math.floor(outfield.length / 2)]!;

  for (const id of keepers) {
    const d = meanToGoal(id);
    console.log(`      ${id}: ${d.toFixed(1)} m from the nearer goal line`);
    assert.ok(d < 20, `${id} averages ${d.toFixed(1)} m from goal, too far for a keeper`);
    assert.ok(d < medianOutfield / 2, `${id} is not clearly closer than outfielders`);
  }
  console.log(`      median outfielder: ${medianOutfield.toFixed(1)} m`);
});
