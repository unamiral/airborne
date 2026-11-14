import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as assets from '../../src/app/assets';

const manifest = JSON.parse(readFileSync('assets.manifest.json', 'utf8')) as {
  mediapipe: { version: string; publicDir: string; files: Record<string, string> };
  model: { sha256: string; bytes: number; publicPath: string };
};
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };

describe('runtime asset descriptors', () => {
  it('match the pinned manifest and package version', () => {
    expect(assets.MEDIAPIPE_VERSION).toBe(manifest.mediapipe.version);
    expect(pkg.dependencies['@mediapipe/tasks-vision']).toBe(manifest.mediapipe.version);
    expect(assets.WASM_DIR).toBe(`${manifest.mediapipe.publicDir}/`);
    expect(Object.keys(manifest.mediapipe.files)).toEqual([assets.WASM_LOADER_FILE, assets.WASM_BINARY_FILE]);
    expect(assets.MODEL_PATH).toBe(manifest.model.publicPath);
    expect(assets.MODEL_SHA256).toBe(manifest.model.sha256);
    expect(assets.MODEL_BYTES).toBe(manifest.model.bytes);
  });

  it('resolves absolute same-origin URLs under a subpath base', () => {
    const r = assets.resolveAssets('https://example.org/teaching/air/index.html');
    expect(r.modelUrl).toBe(`https://example.org/teaching/air/${manifest.model.publicPath}`);
    expect(r.wasmLoaderUrl).toBe(
      `https://example.org/teaching/air/${manifest.mediapipe.publicDir}/vision_wasm_module_internal.js`,
    );
    for (const url of [r.modelUrl, r.wasmLoaderUrl, r.wasmBinaryUrl]) {
      expect(new URL(url).origin).toBe('https://example.org');
    }
  });

  it('pins exact dependency versions (no ranges)', () => {
    const all = { ...pkg.dependencies, ...(JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> }).devDependencies };
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
