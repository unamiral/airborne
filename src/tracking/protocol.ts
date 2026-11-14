/**
 * Main-thread <-> inference-worker protocol (plan §5 "Frame envelope" and
 * "Tracking result"). Every message from the worker is validated by
 * `parseWorkerMessage` before use; nothing from the vendor API crosses the
 * boundary except plain numbers and strings.
 *
 * This module must compile under both the DOM and WebWorker libs, so it only
 * uses types common to both (ImageBitmap).
 */

export const PROTOCOL_VERSION = 1;
export const LANDMARK_COUNT = 21;
/** x, y, z per landmark. */
export const LANDMARK_STRIDE = 3;
export const LANDMARK_VALUES = LANDMARK_COUNT * LANDMARK_STRIDE;

export type Delegate = 'GPU' | 'CPU';

export interface WorkerAssets {
  readonly wasmLoaderUrl: string;
  readonly wasmBinaryUrl: string;
  readonly modelUrl: string;
  readonly modelSha256: string;
  readonly modelBytes: number;
}

export interface InitRequest {
  readonly type: 'init';
  readonly protocol: number;
  readonly delegate: Delegate;
  readonly assets: WorkerAssets;
  readonly numHands: number;
  readonly minHandDetectionConfidence: number;
  readonly minHandPresenceConfidence: number;
  readonly minTrackingConfidence: number;
  readonly warmupFrames: number;
  readonly fetchTimeoutMs: number;
}

/** Frame envelope. The bitmap is transferred; the worker closes it. */
export interface DetectRequest {
  readonly type: 'detect';
  readonly epoch: number;
  readonly seq: number;
  /** Source (media) timeline, ms. Strictly increasing within an epoch. */
  readonly sourceTimeMs: number;
  readonly width: number;
  readonly height: number;
  readonly bitmap: ImageBitmap;
}

export interface DisposeRequest {
  readonly type: 'dispose';
}

export type MainToWorker = InitRequest | DetectRequest | DisposeRequest;

export interface InitTimings {
  /** Worker-local durations, ms. */
  readonly modelFetchMs: number;
  readonly modelVerifyMs: number;
  readonly createMs: number;
  /** Individual warm-up inference durations, ms (excluded from steady state). */
  readonly warmupMs: readonly number[];
}

export interface ReadyMessage {
  readonly type: 'ready';
  readonly protocol: number;
  readonly backend: Delegate;
  readonly timings: InitTimings;
}

export type InitErrorCode =
  | 'model-fetch'
  | 'model-timeout'
  | 'model-integrity'
  | 'wasm-load'
  | 'delegate'
  | 'protocol'
  | 'unknown';

export interface InitErrorMessage {
  readonly type: 'init-error';
  readonly code: InitErrorCode;
  readonly delegate: Delegate;
  readonly message: string;
}

export type Handedness = 'Left' | 'Right' | 'Unknown';

export interface HandPayload {
  /** Normalized image landmarks, LANDMARK_VALUES numbers (x, y, z). */
  readonly landmarks: readonly number[];
  /** Per-hand world landmarks in meters, origin at the hand's center. */
  readonly world: readonly number[];
  /**
   * Handedness classification. Only a classification confidence, never a
   * tracking-quality score (plan §2). The model assumes mirrored input, so
   * labels for our unmirrored frames are swapped; identity code treats them as
   * weak, relative evidence only.
   */
  readonly handedness: Handedness;
  readonly handednessScore: number;
}

export interface ResultMessage {
  readonly type: 'result';
  readonly epoch: number;
  readonly seq: number;
  readonly sourceTimeMs: number;
  /** Worker-local duration of the synchronous detect call, ms. */
  readonly inferenceMs: number;
  readonly hands: readonly HandPayload[];
}

export interface DetectErrorMessage {
  readonly type: 'detect-error';
  readonly epoch: number;
  readonly seq: number;
  readonly message: string;
}

export type WorkerToMain = ReadyMessage | InitErrorMessage | ResultMessage | DetectErrorMessage;

// ---------------------------------------------------------------------------
// Validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function finiteArray(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  for (const v of value as unknown[]) if (!isFiniteNumber(v)) return null;
  return value as number[];
}

function parseHand(value: unknown): HandPayload | null {
  if (!isRecord(value)) return null;
  const landmarks = finiteArray(value.landmarks, LANDMARK_VALUES);
  const world = finiteArray(value.world, LANDMARK_VALUES);
  if (landmarks === null || world === null) return null;
  const handedness = value.handedness;
  if (handedness !== 'Left' && handedness !== 'Right' && handedness !== 'Unknown') return null;
  const score = value.handednessScore;
  if (!isFiniteNumber(score) || score < 0 || score > 1) return null;
  return { landmarks, world, handedness, handednessScore: score };
}

const INIT_ERROR_CODES: ReadonlySet<string> = new Set<InitErrorCode>([
  'model-fetch',
  'model-timeout',
  'model-integrity',
  'wasm-load',
  'delegate',
  'protocol',
  'unknown',
]);

export type ParsedWorkerMessage =
  | { readonly ok: true; readonly message: WorkerToMain }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates a message received from the worker. Results with any non-finite
 * landmark are rejected as a whole (plan §6.4).
 */
export function parseWorkerMessage(data: unknown): ParsedWorkerMessage {
  if (!isRecord(data) || typeof data.type !== 'string') {
    return { ok: false, reason: 'message without a type' };
  }
  switch (data.type) {
    case 'ready': {
      const t = data.timings;
      if (data.protocol !== PROTOCOL_VERSION) return { ok: false, reason: 'protocol mismatch' };
      if (data.backend !== 'GPU' && data.backend !== 'CPU') return { ok: false, reason: 'backend' };
      if (
        !isRecord(t) ||
        !isFiniteNumber(t.modelFetchMs) ||
        !isFiniteNumber(t.modelVerifyMs) ||
        !isFiniteNumber(t.createMs) ||
        !Array.isArray(t.warmupMs) ||
        !(t.warmupMs as unknown[]).every(isFiniteNumber)
      ) {
        return { ok: false, reason: 'ready timings' };
      }
      return {
        ok: true,
        message: {
          type: 'ready',
          protocol: PROTOCOL_VERSION,
          backend: data.backend,
          timings: {
            modelFetchMs: t.modelFetchMs,
            modelVerifyMs: t.modelVerifyMs,
            createMs: t.createMs,
            warmupMs: t.warmupMs as number[],
          },
        },
      };
    }
    case 'init-error': {
      if (typeof data.code !== 'string' || !INIT_ERROR_CODES.has(data.code)) {
        return { ok: false, reason: 'init-error code' };
      }
      if (data.delegate !== 'GPU' && data.delegate !== 'CPU') {
        return { ok: false, reason: 'init-error delegate' };
      }
      return {
        ok: true,
        message: {
          type: 'init-error',
          code: data.code as InitErrorCode,
          delegate: data.delegate,
          message: typeof data.message === 'string' ? data.message : '',
        },
      };
    }
    case 'result': {
      if (!isNonNegativeInt(data.epoch) || !isNonNegativeInt(data.seq)) {
        return { ok: false, reason: 'result identifiers' };
      }
      if (!isFiniteNumber(data.sourceTimeMs) || !isFiniteNumber(data.inferenceMs)) {
        return { ok: false, reason: 'result timing' };
      }
      if (!Array.isArray(data.hands) || data.hands.length > 2) {
        return { ok: false, reason: 'result hands' };
      }
      const hands: HandPayload[] = [];
      for (const raw of data.hands as unknown[]) {
        const hand = parseHand(raw);
        if (hand === null) return { ok: false, reason: 'non-finite or malformed landmarks' };
        hands.push(hand);
      }
      return {
        ok: true,
        message: {
          type: 'result',
          epoch: data.epoch,
          seq: data.seq,
          sourceTimeMs: data.sourceTimeMs,
          inferenceMs: data.inferenceMs,
          hands,
        },
      };
    }
    case 'detect-error': {
      if (!isNonNegativeInt(data.epoch) || !isNonNegativeInt(data.seq)) {
        return { ok: false, reason: 'detect-error identifiers' };
      }
      return {
        ok: true,
        message: {
          type: 'detect-error',
          epoch: data.epoch,
          seq: data.seq,
          message: typeof data.message === 'string' ? data.message : '',
        },
      };
    }
    default:
      return { ok: false, reason: `unknown message type ${data.type}` };
  }
}
