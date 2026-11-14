#!/usr/bin/env node
// Reports production payload sizes (plan §12 "Shell payload", "Total cold
// camera-mode payload"). Run after `npm run build`.
//   first-party shell: index.html + hashed app JS/CSS (excludes the worker chunk)
//   ML: worker chunk (bundles @mediapipe/tasks-vision), WASM loader + binary, model
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dist = process.argv[2] ?? 'dist';
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
}
walk(dist);

const rows = files.map((p) => {
  const data = readFileSync(p);
  const rel = relative(dist, p);
  const ml = /mediapipe\/|models\/|inference\.worker/.test(rel);
  return {
    file: rel,
    category: ml ? 'ml' : 'shell',
    bytes: data.length,
    gzip: gzipSync(data, { level: 9 }).length,
    brotli: brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
});
const kib = (n) => (n / 1024).toFixed(1);
const mib = (n) => (n / 1024 / 1024).toFixed(2);
const sum = (cat, key) => rows.filter((r) => r.category === cat).reduce((a, r) => a + r[key], 0);
console.log('file'.padEnd(64), 'raw KiB'.padStart(10), 'gzip KiB'.padStart(10), 'br KiB'.padStart(10));
for (const r of rows.sort((a, b) => a.category.localeCompare(b.category) || b.bytes - a.bytes)) {
  console.log(`${r.category}:${r.file}`.padEnd(64), kib(r.bytes).padStart(10), kib(r.gzip).padStart(10), kib(r.brotli).padStart(10));
}
const summary = {
  shellGzipKiB: Number(kib(sum('shell', 'gzip'))),
  shellBrotliKiB: Number(kib(sum('shell', 'brotli'))),
  mlGzipMiB: Number(mib(sum('ml', 'gzip'))),
  mlBrotliMiB: Number(mib(sum('ml', 'brotli'))),
  coldCameraGzipMiB: Number(mib(sum('ml', 'gzip') + sum('shell', 'gzip'))),
  coldCameraBrotliMiB: Number(mib(sum('ml', 'brotli') + sum('shell', 'brotli'))),
};
console.log(summary);
mkdirSync('bench-results', { recursive: true });
writeFileSync(`bench-results/size-report-${dist.replace(/\W+/g, '_')}.json`, `${JSON.stringify({ date: new Date().toISOString(), rows, summary }, null, 1)}\n`);
