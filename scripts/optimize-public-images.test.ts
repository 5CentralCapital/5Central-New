import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { optimizePublicImages, publicAttachedAssetFiles } from "./optimize-public-images.mjs";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test("copies only reviewed legacy public images and excludes private source rasters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "r-ops-public-images-"));
  const publicDir = path.join(root, "dist", "public");
  const attachedDir = path.join(root, "attached_assets");
  const publicImage = path.join(publicDir, "attached_assets", "gallery", "published.jpg");
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 40, g: 80, b: 120 } },
  }).jpeg().toBuffer();

  try {
    await mkdir(path.dirname(publicImage), { recursive: true });
    await mkdir(attachedDir, { recursive: true });
    await writeFile(publicImage, image);
    for (const relative of publicAttachedAssetFiles) await writeFile(path.join(attachedDir, relative), image);
    await writeFile(path.join(attachedDir, "Screenshot_2026-02-19_at_12.05.33_AM_1771477572283.png"), image);

    const result = await optimizePublicImages(publicDir, attachedDir);
    assert.equal(result.images, publicAttachedAssetFiles.length + 1);
    assert.equal(await exists(path.join(publicDir, "attached_assets", publicAttachedAssetFiles[0])), true);
    assert.equal(await exists(path.join(publicDir, "attached_assets", "Screenshot_2026-02-19_at_12.05.33_AM_1771477572283.png")), false);
    assert.equal(await exists(`${publicImage}.responsive-v1-1600.webp`), true);
    assert.deepEqual(await readFile(publicImage), image);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
