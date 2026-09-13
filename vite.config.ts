import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

export default defineConfig({
  plugins: [react(), {
    name: 'precompressed-public-assets',
    apply: 'build',
    writeBundle(options, bundle) {
      // Vite replaces preload markers late in generateBundle. Compress the
      // final files on disk so every representation contains identical code.
      for (const fileName of Object.keys(bundle)) {
        if (!/\.(?:m?js|css|svg)$/.test(fileName)) continue;
        const file = path.resolve(options.dir!, fileName);
        const bytes = readFileSync(file);
        if (bytes.length < 1024) continue;
        writeFileSync(`${file}.br`,brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:9}}));
        writeFileSync(`${file}.gz`,gzipSync(bytes,{level:9}));
      }
    },
  }],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    manifest: true,
    rollupOptions: { output: { manualChunks(id) {
      if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return 'react-core';
      if (id.includes('/node_modules/lucide-react/')) return 'icons';
    } } },
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
