/**
 * Build public/models/player.glb from the raw Mixamo downloads in mixamo/.
 *
 * Mixamo only exports FBX, one clip per file, and names every animation
 * "mixamo.com" regardless of what it is. This converts each file to glTF,
 * renames the clip after the role it plays, and merges them all onto the one
 * character so the app still loads a single file.
 *
 * Most textures are dropped on purpose. The kit system colours the shirt,
 * shorts and socks flat, so their maps are never sampled. Two are kept and
 * downscaled: the body atlas, without which every player has a blank head,
 * and the hair map, whose alpha channel cuts out the hair cards.
 *
 * Requires the devDependencies fbx2gltf, @gltf-transform/core and sharp.
 * Run with: npm run build:model
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import convertFbx from "fbx2gltf";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIXAMO = path.join(ROOT, "mixamo");
const PACK = path.join(MIXAMO, "pack");
const OUT = path.join(ROOT, "public", "models", "player.glb");

/** The character mesh. Everything else contributes animation only. */
const CHARACTER = "Ch38_nonPBR.fbx";

/**
 * source file -> clip name.
 *
 * Names matter: lib/playerModel.ts resolves roles by matching these, exact
 * match first, so "Soccer Pass" wins the kick role over "Keeper Drop Kick".
 * The first four are the ones the renderer currently drives; the rest are
 * carried so the event data they match can be wired up without another
 * download, and cost nothing until then.
 */
const CLIPS = [
  { file: "Idle.fbx", name: "Idle", wired: true },
  { file: "Jogging.fbx", name: "Jogging", wired: true },
  { file: "Running.fbx", name: "Running", wired: true },
  { file: "pack/kick soccerball.fbx", name: "Soccer Pass", wired: true },

  { file: "Walking.fbx", name: "Walking" },
  { file: "pack/header soccerball.fbx", name: "Header" },
  { file: "pack/soccer tackle.fbx", name: "Tackle" },
  { file: "pack/throw in.fbx", name: "Throw In" },
  { file: "pack/soccer trip.fbx", name: "Trip" },
  { file: "pack/standing up.fbx", name: "Standing Up" },
  { file: "pack/goalkeeper idle.fbx", name: "Keeper Idle" },
  { file: "pack/goalkeeper diving save.fbx", name: "Keeper Save" },
  { file: "pack/goalkeeper drop kick.fbx", name: "Keeper Drop Kick" },
];

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

/**
 * Textures to keep, by a fragment of their name, and the size to shrink them
 * to. Everything else is discarded. The body atlas carries the face, which is
 * the only reason to keep any texture at all; the hair map is kept purely for
 * its alpha.
 */
const KEEP_TEXTURES = [
  { match: /1001_diffuse/i, size: 512, label: "body atlas (face)" },
  { match: /1002_diffuse/i, size: 256, label: "hair alpha" },
];

async function shrinkTextures(doc) {
  const kept = [];
  for (const texture of doc.getRoot().listTextures()) {
    const name = texture.getName() ?? texture.getURI() ?? "";
    const rule = KEEP_TEXTURES.find((r) => r.match.test(name));
    if (rule === undefined) {
      texture.dispose();
      continue;
    }
    const image = texture.getImage();
    if (image === null) {
      texture.dispose();
      continue;
    }
    const before = image.byteLength;
    const resized = await sharp(Buffer.from(image))
      .resize(rule.size, rule.size, { fit: "inside" })
      .png({ compressionLevel: 9 })
      .toBuffer();
    texture.setImage(new Uint8Array(resized)).setMimeType("image/png");
    kept.push(`${rule.label} ${mb(before)} -> ${mb(resized.length)}`);
  }
  return kept;
}

async function toGltf(fbxPath, outPath) {
  if (!existsSync(fbxPath)) throw new Error(`missing input: ${fbxPath}`);
  await convertFbx(fbxPath, outPath, []);
  return outPath;
}

/**
 * Copy one animation into `doc`, repointing every channel at the character's
 * own node of the same name. The clips were exported against this character,
 * so the skeletons match bone for bone.
 */
function copyAnimation(doc, sourceAnimation, name) {
  const buffer = doc.getRoot().listBuffers()[0];
  const byName = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));

  const animation = doc.createAnimation(name);
  let bound = 0;
  let unbound = 0;

  for (const channel of sourceAnimation.listChannels()) {
    const sourceNode = channel.getTargetNode();
    const target = sourceNode === null ? undefined : byName.get(sourceNode.getName());
    if (target === undefined) {
      unbound += 1;
      continue;
    }
    const source = channel.getSampler();
    if (source === null) continue;

    const input = doc
      .createAccessor()
      .setArray(source.getInput().getArray())
      .setType(source.getInput().getType())
      .setBuffer(buffer);
    const output = doc
      .createAccessor()
      .setArray(source.getOutput().getArray())
      .setType(source.getOutput().getType())
      .setBuffer(buffer);

    const sampler = doc
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation(source.getInterpolation());

    animation.addSampler(sampler);
    animation.addChannel(
      doc
        .createAnimationChannel()
        .setTargetNode(target)
        .setTargetPath(channel.getTargetPath())
        .setSampler(sampler),
    );
    bound += 1;
  }

  return { bound, unbound };
}

async function main() {
  const io = new NodeIO();
  const work = await mkdtemp(path.join(tmpdir(), "player-model-"));

  try {
    console.log(`converting ${CHARACTER}...`);
    const characterGlb = await toGltf(
      path.join(MIXAMO, CHARACTER),
      path.join(work, "character.glb"),
    );
    const doc = await io.read(characterGlb);
    const root = doc.getRoot();

    const textureCount = root.listTextures().length;
    const kept = await shrinkTextures(doc);
    console.log(`  textures: kept ${kept.length} of ${textureCount}`);
    for (const line of kept) console.log(`    ${line}`);

    // The hair material's base colour alpha is 0, which with alphaMode BLEND
    // makes the hair invisible the moment it stops borrowing the body material.
    // Its real cutout lives in the texture's alpha, so let that through.
    for (const material of root.listMaterials()) {
      const [r, g, b, a] = material.getBaseColorFactor();
      if (a < 1) {
        material.setBaseColorFactor([r, g, b, 1]);
        console.log(`  ${material.getName()}: base alpha ${a} -> 1 (was invisible)`);
      }
    }

    // The character file carries its own T-pose take; the real clips replace it.
    for (const animation of root.listAnimations()) animation.dispose();

    for (const clip of CLIPS) {
      const source = path.join(clip.file.startsWith("pack/") ? MIXAMO : MIXAMO, clip.file);
      const glb = await toGltf(source, path.join(work, `${clip.name.replace(/\W+/g, "_")}.glb`));
      const clipDoc = await io.read(glb);
      const animations = clipDoc.getRoot().listAnimations();
      if (animations.length === 0) throw new Error(`${clip.file} contains no animation`);

      const { bound, unbound } = copyAnimation(doc, animations[0], clip.name);
      const flag = clip.wired === true ? "*" : " ";
      console.log(
        `  ${flag} ${clip.name.padEnd(18)} ${String(bound).padStart(3)} channels` +
          (unbound > 0 ? `  (${unbound} unmatched bones skipped)` : ""),
      );
    }

    await mkdir(path.dirname(OUT), { recursive: true });
    await io.write(OUT, doc);

    const { statSync } = await import("node:fs");
    console.log(`\nwrote ${path.relative(ROOT, OUT)}  ${mb(statSync(OUT).size)}`);
    console.log(`  ${CLIPS.length} clips, ${CLIPS.filter((c) => c.wired).length} currently driven`);
    console.log("  (* = used by the renderer today)");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
