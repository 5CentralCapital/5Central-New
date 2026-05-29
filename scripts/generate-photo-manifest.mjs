import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const galleryRoot = path.join(root, "client", "public", "attached_assets", "gallery");
const outputPath = path.join(root, "data", "photo-manifest.json");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }

    if (imageExtensions.has(path.extname(entry.name).toLowerCase())) {
      const info = await stat(fullPath);
      const publicPath = "/" + path.relative(path.join(root, "client", "public"), fullPath).split(path.sep).join("/");
      const parts = path.relative(galleryRoot, fullPath).split(path.sep);
      files.push({
        property: parts[0] || "root",
        stage: parts.length > 2 ? parts[1] : "gallery",
        fileName: entry.name,
        publicPath,
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
      });
    }
  }

  return files;
}

const files = await walk(galleryRoot);
const grouped = files.reduce((acc, file) => {
  acc[file.property] ||= { count: 0, stages: {}, photos: [] };
  acc[file.property].count += 1;
  acc[file.property].stages[file.stage] = (acc[file.property].stages[file.stage] || 0) + 1;
  acc[file.property].photos.push(file);
  return acc;
}, {});

const manifest = {
  generatedAt: new Date().toISOString(),
  galleryRoot: "/attached_assets/gallery",
  totalPhotos: files.length,
  properties: grouped,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${files.length} photos to ${path.relative(root, outputPath)}`);
