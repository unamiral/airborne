/**
 * Locally hosted runtime ML assets (plan §11: no third-party CDN at runtime).
 * Paths are relative to the deployed app's base URL and must match
 * assets.manifest.json (enforced by a unit test).
 */
export const MEDIAPIPE_VERSION = '1.2.3';
export const WASM_DIR = `assets/mediapipe/${MEDIAPIPE_VERSION}/`;
export const WASM_LOADER_FILE = 'vision_wasm_module_internal.js';
export const WASM_BINARY_FILE = 'vision_wasm_module_internal.wasm';

export const MODEL_PATH = 'assets/models/hand_landmarker/float16-1/hand_landmarker.task';
export const MODEL_SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';
export const MODEL_BYTES = 7_819_105;
export const MODEL_ID = 'hand_landmarker/float16/1';

export interface ResolvedAssets {
  readonly wasmLoaderUrl: string;
  readonly wasmBinaryUrl: string;
  readonly modelUrl: string;
  readonly modelSha256: string;
  readonly modelBytes: number;
}

/**
 * Resolves absolute asset URLs on the main thread. A worker resolves relative
 * URLs against its own (hashed chunk) location, so it must receive absolute URLs.
 */
export function resolveAssets(baseUri: string): ResolvedAssets {
  return {
    wasmLoaderUrl: new URL(WASM_DIR + WASM_LOADER_FILE, baseUri).href,
    wasmBinaryUrl: new URL(WASM_DIR + WASM_BINARY_FILE, baseUri).href,
    modelUrl: new URL(MODEL_PATH, baseUri).href,
    modelSha256: MODEL_SHA256,
    modelBytes: MODEL_BYTES,
  };
}
