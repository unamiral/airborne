/**
 * Inference worker: owns the MediaPipe HandLandmarker (plan §6).
 *
 * Packaging decision (docs/decisions/0001-worker-packaging.md): this is an ES
 * module worker. MediaPipe 1.2.3 first tries `importScripts`, which throws a
 * TypeError in module workers, and then falls back to dynamic `import()`. That
 * fallback only works with the ES-module WASM loader
 * (`vision_wasm_module_internal.js`), which sets `globalThis.ModuleFactory`.
 * We therefore construct the WasmFileset explicitly with the module loader
 * instead of using FilesetResolver.
 *
 * Ownership: every received ImageBitmap is closed in `finally`.
 * Clocks: all durations here are worker-local `performance.now()` deltas; the
 * worker never reports absolute times that the main thread could mistake for
 * its own clock.
 */
import { HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  LANDMARK_COUNT,
  PROTOCOL_VERSION,
  type Delegate,
  type DetectRequest,
  type HandPayload,
  type InitErrorCode,
  type InitRequest,
  type MainToWorker,
  type WorkerToMain,
} from '../protocol';

declare const self: DedicatedWorkerGlobalScope;

let landmarker: HandLandmarker | null = null;
let currentEpoch = -1;
let lastSourceMs = -Infinity;
/** Detector timeline, ms. Strictly increasing for the worker's lifetime. */
let modelClockMs = 0;
let queue: Promise<void> = Promise.resolve();

class InitFailure extends Error {
  constructor(
    readonly code: InitErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function post(message: WorkerToMain): void {
  self.postMessage(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function nextModelTimestamp(deltaMs: number): number {
  modelClockMs += Math.max(1, Math.round(deltaMs));
  return modelClockMs;
}

async function fetchVerifiedModel(
  request: InitRequest,
): Promise<{ bytes: Uint8Array; fetchMs: number; verifyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.fetchTimeoutMs);
  const start = performance.now();
  let buffer: ArrayBuffer;
  try {
    const response = await fetch(request.assets.modelUrl, {
      signal: controller.signal,
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new InitFailure('model-fetch', `Model request failed (HTTP ${response.status}).`);
    }
    buffer = await response.arrayBuffer();
  } catch (error) {
    if (error instanceof InitFailure) throw error;
    if (controller.signal.aborted) {
      throw new InitFailure(
        'model-timeout',
        `Model download did not finish within ${Math.round(request.fetchTimeoutMs / 1000)} s.`,
      );
    }
    throw new InitFailure('model-fetch', `Model download failed: ${describe(error)}`);
  } finally {
    clearTimeout(timer);
  }
  const fetched = performance.now();
  if (buffer.byteLength !== request.assets.modelBytes) {
    throw new InitFailure(
      'model-integrity',
      `Model file has ${buffer.byteLength} bytes; expected ${request.assets.modelBytes}.`,
    );
  }
  const digest = toHex(await crypto.subtle.digest('SHA-256', buffer));
  if (digest !== request.assets.modelSha256) {
    throw new InitFailure('model-integrity', 'Model file failed its SHA-256 integrity check.');
  }
  return { bytes: new Uint8Array(buffer), fetchMs: fetched - start, verifyMs: performance.now() - fetched };
}

function classifyCreateError(error: unknown, delegate: Delegate): InitFailure {
  const text = describe(error);
  if (/ModuleFactory|wasm|WebAssembly|dynamically imported module|Failed to fetch/i.test(text)) {
    return new InitFailure('wasm-load', `Tracking runtime failed to load: ${text}`);
  }
  if (delegate === 'GPU') {
    return new InitFailure('delegate', `GPU tracking backend failed to start: ${text}`);
  }
  return new InitFailure('unknown', `Tracking failed to start: ${text}`);
}

async function init(request: InitRequest): Promise<void> {
  if (request.protocol !== PROTOCOL_VERSION) {
    post({ type: 'init-error', code: 'protocol', delegate: request.delegate, message: 'Protocol mismatch.' });
    return;
  }
  try {
    const model = await fetchVerifiedModel(request);
    const createStart = performance.now();
    try {
      landmarker = await HandLandmarker.createFromOptions(
        { wasmLoaderPath: request.assets.wasmLoaderUrl, wasmBinaryPath: request.assets.wasmBinaryUrl },
        {
          baseOptions: { modelAssetBuffer: model.bytes, delegate: request.delegate },
          runningMode: 'VIDEO',
          numHands: request.numHands,
          minHandDetectionConfidence: request.minHandDetectionConfidence,
          minHandPresenceConfidence: request.minHandPresenceConfidence,
          minTrackingConfidence: request.minTrackingConfidence,
        },
      );
    } catch (error) {
      throw classifyCreateError(error, request.delegate);
    }
    const createMs = performance.now() - createStart;

    // Warm-up on a blank frame. Only the palm detector runs on an empty frame,
    // so the first real hand can still be slower; that is reported separately
    // by the main thread rather than hidden here.
    const blank = new ImageData(new Uint8ClampedArray(256 * 256 * 4).fill(128), 256, 256);
    const warmupMs: number[] = [];
    for (let i = 0; i < request.warmupFrames; i++) {
      const t0 = performance.now();
      landmarker.detectForVideo(blank, nextModelTimestamp(33));
      warmupMs.push(performance.now() - t0);
    }
    post({
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      backend: request.delegate,
      timings: { modelFetchMs: model.fetchMs, modelVerifyMs: model.verifyMs, createMs, warmupMs },
    });
  } catch (error) {
    landmarker?.close();
    landmarker = null;
    const failure = error instanceof InitFailure ? error : new InitFailure('unknown', describe(error));
    post({ type: 'init-error', code: failure.code, delegate: request.delegate, message: failure.message });
  }
}

function flatten(points: ReadonlyArray<{ x: number; y: number; z: number }>): number[] {
  const out = new Array<number>(LANDMARK_COUNT * 3);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = points[i];
    out[i * 3] = p?.x ?? Number.NaN;
    out[i * 3 + 1] = p?.y ?? Number.NaN;
    out[i * 3 + 2] = p?.z ?? Number.NaN;
  }
  return out;
}

function toPayload(result: HandLandmarkerResult): HandPayload[] {
  const hands: HandPayload[] = [];
  const count = Math.min(result.landmarks.length, result.worldLandmarks.length, 2);
  for (let i = 0; i < count; i++) {
    const category = result.handedness[i]?.[0];
    const name = category?.categoryName;
    hands.push({
      landmarks: flatten(result.landmarks[i] ?? []),
      world: flatten(result.worldLandmarks[i] ?? []),
      handedness: name === 'Left' || name === 'Right' ? name : 'Unknown',
      handednessScore: category?.score ?? 0,
    });
  }
  return hands;
}

async function detect(request: DetectRequest): Promise<void> {
  const { bitmap } = request;
  try {
    if (landmarker === null) {
      post({ type: 'detect-error', epoch: request.epoch, seq: request.seq, message: 'Detector not ready.' });
      return;
    }
    if (request.epoch !== currentEpoch) {
      // New source timeline: refresh the graph so tracking state from the
      // previous source cannot leak into this one. The model clock keeps
      // increasing, so detector timestamps stay strictly monotonic.
      if (currentEpoch !== -1) await landmarker.setOptions({});
      currentEpoch = request.epoch;
      lastSourceMs = -Infinity;
    }
    if (!(request.sourceTimeMs > lastSourceMs)) {
      post({
        type: 'detect-error',
        epoch: request.epoch,
        seq: request.seq,
        message: 'Non-increasing source timestamp.',
      });
      return;
    }
    const delta = Number.isFinite(lastSourceMs) ? request.sourceTimeMs - lastSourceMs : 1;
    lastSourceMs = request.sourceTimeMs;
    const timestamp = nextModelTimestamp(delta);
    const start = performance.now();
    const result = landmarker.detectForVideo(bitmap, timestamp);
    const inferenceMs = performance.now() - start;
    post({
      type: 'result',
      epoch: request.epoch,
      seq: request.seq,
      sourceTimeMs: request.sourceTimeMs,
      inferenceMs,
      hands: toPayload(result),
    });
  } catch (error) {
    post({ type: 'detect-error', epoch: request.epoch, seq: request.seq, message: describe(error) });
  } finally {
    bitmap.close();
  }
}

function dispose(): void {
  landmarker?.close();
  landmarker = null;
  self.close();
}

async function handle(message: MainToWorker): Promise<void> {
  switch (message.type) {
    case 'init':
      await init(message);
      return;
    case 'detect':
      await detect(message);
      return;
    case 'dispose':
      dispose();
      return;
  }
}

self.addEventListener('message', (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  // Serialize: init, graph refresh, and detect must never interleave.
  queue = queue.then(() => handle(message)).catch((error: unknown) => {
    if (message.type === 'detect') message.bitmap.close();
    console.error('inference worker:', describe(error));
  });
});
