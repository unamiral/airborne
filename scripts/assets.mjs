#!/usr/bin/env node
// Prepares the locally hosted ML runtime assets in public/ and verifies them.
//
// - MediaPipe WASM loader/binary are copied from the pinned npm package.
// - The hand landmarker model is downloaded once from its pinned source URL.
// Every file is checked against the SHA-256 in assets.manifest.json; a
// mismatch fails loudly instead of silently shipping a different model.
// The app never contacts these source URLs at runtime.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'assets.manifest.json'), 'utf8'));

async function sha256File(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureMediapipe() {
  const { package: pkg, version, files, publicDir } = manifest.mediapipe;
  const pkgDir = join(root, 'node_modules', ...pkg.split('/'));
  const installed = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')).version;
  if (installed !== version) {
    throw new Error(
      `${pkg} ${installed} is installed but assets.manifest.json pins ${version}. Run "npm ci".`,
    );
  }
  const destDir = join(root, 'public', publicDir);
  await mkdir(destDir, { recursive: true });
  for (const [file, expected] of Object.entries(files)) {
    const source = join(pkgDir, 'wasm', file);
    const actual = await sha256File(source);
    if (actual !== expected) {
      throw new Error(`${pkg}/wasm/${file} checksum ${actual} does not match pinned ${expected}.`);
    }
    const dest = join(destDir, file);
    if (!(await exists(dest)) || (await sha256File(dest)) !== expected) {
      await copyFile(source, dest);
      console.log(`assets: copied ${file}`);
    }
  }
}

async function ensureModel() {
  const { sourceUrl, sha256, bytes, publicPath } = manifest.model;
  const dest = join(root, 'public', publicPath);
  if ((await exists(dest)) && (await sha256File(dest)) === sha256) return;
  await mkdir(dirname(dest), { recursive: true });
  console.log(`assets: downloading model from ${sourceUrl}`);
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(data).digest('hex');
  if (data.length !== bytes || actual !== sha256) {
    throw new Error(`Downloaded model (${data.length} B, ${actual}) does not match the pinned model.`);
  }
  const temp = `${dest}.partial`;
  await writeFile(temp, data);
  await rm(dest, { force: true });
  await rename(temp, dest);
  console.log(`assets: model verified (${bytes} bytes)`);
}

try {
  await ensureMediapipe();
  await ensureModel();
  console.log('assets: all runtime assets present and verified');
} catch (error) {
  console.error(`assets: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
