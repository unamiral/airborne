/**
 * Main-thread adapter for the inference worker (plan §5, §6).
 *
 * - `startTracker` creates a worker, initializes it, and falls back from GPU
 *   to a fresh CPU worker when the GPU delegate fails (plan §6 "Worker
 *   capability spike"). Model integrity/download failures are not retried
 *   with another delegate because the model is the same.
 * - `detect` sends one transferred bitmap and resolves with the validated
 *   result. A timeout rejects so the caller can clear its busy flag and run a
 *   bounded recovery.
 */
import {
  PROTOCOL_VERSION,
  parseWorkerMessage,
  type Delegate,
  type DetectRequest,
  type InitErrorCode,
  type InitRequest,
  type InitTimings,
  type MainToWorker,
  type ResultMessage,
  type WorkerAssets,
} from './protocol';

/** The subset of `Worker` used here; tests substitute a fake. */
export interface WorkerLike {
  postMessage(message: MainToWorker, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
}

export type BackendPreference = 'auto' | Delegate;

export interface TrackerOptions {
  readonly createWorker: () => WorkerLike;
  readonly assets: WorkerAssets;
  readonly backend: BackendPreference;
  readonly initTimeoutMs: number;
  readonly detectTimeoutMs: number;
  readonly warmupFrames: number;
  readonly signal?: AbortSignal;
}

export class TrackerInitError extends Error {
  constructor(
    readonly code: InitErrorCode | 'timeout' | 'crash' | 'aborted',
    message: string,
    /** Every attempt made, for diagnostics. */
    readonly attempts: readonly string[] = [],
  ) {
    super(message);
    this.name = 'TrackerInitError';
  }
}

export class DetectTimeoutError extends Error {
  constructor(readonly seq: number) {
    super(`Inference did not answer frame ${seq} in time.`);
    this.name = 'DetectTimeoutError';
  }
}

export class DetectFailedError extends Error {
  constructor(
    readonly seq: number,
    message: string,
  ) {
    super(message);
    this.name = 'DetectFailedError';
  }
}

export interface DetectEnvelope {
  readonly epoch: number;
  readonly seq: number;
  readonly sourceTimeMs: number;
  readonly width: number;
  readonly height: number;
  readonly bitmap: ImageBitmap;
}

interface Pending {
  readonly seq: number;
  readonly resolve: (result: ResultMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface TrackerDiagnostics {
  invalidMessages: number;
  lateResults: number;
}

export class TrackerClient {
  private pending: Pending | null = null;
  private disposed = false;
  private crashListener: ((message: string) => void) | null = null;
  readonly diagnostics: TrackerDiagnostics = { invalidMessages: 0, lateResults: 0 };

  constructor(
    private readonly worker: WorkerLike,
    readonly backend: Delegate,
    readonly timings: InitTimings,
    private readonly detectTimeoutMs: number,
    /** Why the preferred backend was not used, if it was not. */
    readonly fallbackReason: string | null,
  ) {
    worker.addEventListener('message', (event: MessageEvent) => this.onMessage(event.data));
    worker.addEventListener('error', () => this.handleCrash('The tracking worker stopped unexpectedly.'));
    worker.addEventListener('messageerror', () => {
      this.diagnostics.invalidMessages++;
    });
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  onCrash(listener: (message: string) => void): void {
    this.crashListener = listener;
  }

  /**
   * Transfers `envelope.bitmap` to the worker. If posting fails, the bitmap is
   * still owned here and is closed before rejecting.
   */
  detect(envelope: DetectEnvelope): Promise<ResultMessage> {
    if (this.disposed) {
      envelope.bitmap.close();
      return Promise.reject(new DetectFailedError(envelope.seq, 'Tracker disposed.'));
    }
    if (this.pending !== null) {
      envelope.bitmap.close();
      return Promise.reject(new DetectFailedError(envelope.seq, 'Another frame is in flight.'));
    }
    return new Promise<ResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.seq === envelope.seq) {
          this.pending = null;
          reject(new DetectTimeoutError(envelope.seq));
        }
      }, this.detectTimeoutMs);
      this.pending = { seq: envelope.seq, resolve, reject, timer };
      const request: DetectRequest = { type: 'detect', ...envelope };
      try {
        this.worker.postMessage(request, [envelope.bitmap]);
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        envelope.bitmap.close();
        reject(new DetectFailedError(envelope.seq, `Frame transfer failed: ${String(error)}`));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failPending('Tracker disposed.');
    try {
      this.worker.postMessage({ type: 'dispose' }, []);
    } catch {
      // The worker may already be gone; terminate below is sufficient.
    }
    this.worker.terminate();
  }

  private failPending(message: string): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new DetectFailedError(pending.seq, message));
  }

  private handleCrash(message: string): void {
    if (this.disposed) return;
    this.failPending(message);
    this.crashListener?.(message);
  }

  private onMessage(data: unknown): void {
    const parsed = parseWorkerMessage(data);
    if (!parsed.ok) {
      this.diagnostics.invalidMessages++;
      // A malformed result still answers the frame in flight; reject it so the
      // pipeline is not left busy.
      const seq = typeof data === 'object' && data !== null ? (data as { seq?: unknown }).seq : undefined;
      if (this.pending !== null && seq === this.pending.seq) {
        this.failPending(`Invalid result: ${parsed.reason}`);
      }
      return;
    }
    const message = parsed.message;
    if (message.type !== 'result' && message.type !== 'detect-error') return;
    const pending = this.pending;
    if (pending?.seq !== message.seq) {
      this.diagnostics.lateResults++;
      return;
    }
    this.pending = null;
    clearTimeout(pending.timer);
    if (message.type === 'result') pending.resolve(message);
    else pending.reject(new DetectFailedError(message.seq, message.message));
  }
}

function initRequest(assets: WorkerAssets, delegate: Delegate, warmupFrames: number, timeoutMs: number): InitRequest {
  return {
    type: 'init',
    protocol: PROTOCOL_VERSION,
    delegate,
    assets,
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    warmupFrames,
    fetchTimeoutMs: timeoutMs,
  };
}

type Attempt =
  | { readonly ok: true; readonly worker: WorkerLike; readonly timings: InitTimings }
  | { readonly ok: false; readonly code: TrackerInitError['code']; readonly message: string };

function attempt(options: TrackerOptions, delegate: Delegate): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({ ok: false, code: 'aborted', message: 'Start was cancelled.' });
      return;
    }
    let settled = false;
    const worker = options.createWorker();
    const finish = (result: Attempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!result.ok) worker.terminate();
      resolve(result);
    };
    const onAbort = (): void => finish({ ok: false, code: 'aborted', message: 'Start was cancelled.' });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          code: 'timeout',
          message: `Tracking did not become ready within ${Math.round(options.initTimeoutMs / 1000)} s.`,
        }),
      options.initTimeoutMs,
    );
    options.signal?.addEventListener('abort', onAbort);
    worker.addEventListener('message', (event: MessageEvent) => {
      const parsed = parseWorkerMessage(event.data);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.type === 'ready') {
        finish({ ok: true, worker, timings: message.timings });
      } else if (message.type === 'init-error') {
        finish({ ok: false, code: message.code, message: message.message });
      }
    });
    worker.addEventListener('error', () =>
      finish({ ok: false, code: 'crash', message: 'The tracking worker failed to load.' }),
    );
    worker.postMessage(initRequest(options.assets, delegate, options.warmupFrames, options.initTimeoutMs), []);
  });
}

const RETRY_ON_CPU: ReadonlySet<string> = new Set(['delegate', 'unknown', 'crash', 'timeout']);

/**
 * Warm-up frames slower than this (median, excluding the first frame, which
 * includes shader compilation) indicate a GPU delegate running on a software
 * rasterizer such as SwiftShader. Measured in M0: Metal GPU ~11 ms, CPU/WASM
 * ~25 ms, SwiftShader GPU ~115 ms per blank 256x256 frame on an Apple M2.
 */
export const SLOW_WARMUP_MS = 50;

/** Median of warm-up durations after the first (compile) frame. */
export function steadyWarmupMs(timings: InitTimings): number {
  const steady = timings.warmupMs.slice(1).sort((a, b) => a - b);
  if (steady.length === 0) return timings.warmupMs[0] ?? Number.POSITIVE_INFINITY;
  const mid = steady.length >> 1;
  return steady.length % 2 === 1 ? steady[mid]! : (steady[mid - 1]! + steady[mid]!) / 2;
}

/**
 * Starts a ready tracker. With 'auto', GPU is tried first; if it fails, or
 * initializes but warms up slower than SLOW_WARMUP_MS, a CPU worker is
 * started and the faster of the two is kept (the other is terminated).
 */
export async function startTracker(options: TrackerOptions): Promise<TrackerClient> {
  const order: Delegate[] = options.backend === 'auto' ? ['GPU', 'CPU'] : [options.backend];
  const attempts: string[] = [];
  let last: Attempt | null = null;
  let slowGpu: Extract<Attempt, { ok: true }> | null = null;
  for (const delegate of order) {
    const result = await attempt(options, delegate);
    if (result.ok) {
      const warm = steadyWarmupMs(result.timings);
      if (delegate === 'GPU' && options.backend === 'auto' && warm > SLOW_WARMUP_MS) {
        slowGpu = result;
        attempts.push(`GPU: warm-up ${warm.toFixed(0)} ms/frame exceeds ${SLOW_WARMUP_MS} ms (likely software rendering)`);
        continue;
      }
      if (slowGpu !== null) {
        const gpuWarm = steadyWarmupMs(slowGpu.timings);
        if (gpuWarm < warm) {
          result.worker.terminate();
          attempts.push(`CPU: warm-up ${warm.toFixed(0)} ms/frame is slower; keeping GPU`);
          return new TrackerClient(slowGpu.worker, 'GPU', slowGpu.timings, options.detectTimeoutMs, attempts.join('; '));
        }
        slowGpu.worker.terminate();
      }
      const fallbackReason = attempts.length > 0 ? attempts.join('; ') : null;
      return new TrackerClient(result.worker, delegate, result.timings, options.detectTimeoutMs, fallbackReason);
    }
    attempts.push(`${delegate}: ${result.code}: ${result.message}`);
    last = result;
    if (result.code === 'aborted' || !RETRY_ON_CPU.has(result.code)) break;
  }
  if (slowGpu !== null) {
    if (last !== null && !last.ok && last.code === 'aborted') {
      slowGpu.worker.terminate();
    } else {
      // CPU failed; a slow GPU is still better than no tracking.
      return new TrackerClient(slowGpu.worker, 'GPU', slowGpu.timings, options.detectTimeoutMs, attempts.join('; '));
    }
  }
  const code = last !== null && !last.ok ? last.code : 'unknown';
  const message = last !== null && !last.ok ? last.message : 'Tracking failed to start.';
  throw new TrackerInitError(code, message, attempts);
}
