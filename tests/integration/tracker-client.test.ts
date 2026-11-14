import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAssets } from '../../src/app/assets';
import {
  DetectFailedError,
  DetectTimeoutError,
  TrackerInitError,
  startTracker,
  type TrackerOptions,
} from '../../src/tracking/tracker-client';
import { FakeBitmap, FakeWorker, flush, type InitBehavior } from '../support/fakes';

function options(workers: FakeWorker[], behaviors: InitBehavior[], extra: Partial<TrackerOptions> = {}): TrackerOptions {
  return {
    createWorker: () => {
      const w = new FakeWorker(behaviors[workers.length] ?? { kind: 'ready' });
      workers.push(w);
      return w;
    },
    assets: resolveAssets('https://example.org/app/'),
    backend: 'auto',
    initTimeoutMs: 1000,
    detectTimeoutMs: 500,
    warmupFrames: 2,
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('tracker start and backend fallback', () => {
  it('prefers GPU when it initializes', async () => {
    const workers: FakeWorker[] = [];
    const tracker = await startTracker(options(workers, [{ kind: 'ready' }]));
    expect(tracker.backend).toBe('GPU');
    expect(tracker.fallbackReason).toBeNull();
    expect(workers).toHaveLength(1);
    const init = workers[0]!.posted[0];
    expect(init).toMatchObject({ type: 'init', delegate: 'GPU', numHands: 2 });
  });

  it('falls back to a fresh CPU worker when the GPU delegate fails', async () => {
    const workers: FakeWorker[] = [];
    const tracker = await startTracker(options(workers, [{ kind: 'error', code: 'delegate' }, { kind: 'ready' }]));
    expect(tracker.backend).toBe('CPU');
    expect(tracker.fallbackReason).toMatch(/GPU: delegate/);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.terminated).toBe(false);
  });

  it('does not retry another delegate when the model itself is bad', async () => {
    const workers: FakeWorker[] = [];
    await expect(startTracker(options(workers, [{ kind: 'error', code: 'model-integrity' }]))).rejects.toMatchObject({
      code: 'model-integrity',
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('times out, tries CPU, and terminates every worker', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const promise = startTracker(options(workers, [{ kind: 'silent' }, { kind: 'silent' }]));
    const assertion = expect(promise).rejects.toBeInstanceOf(TrackerInitError);
    await vi.advanceTimersByTimeAsync(1001);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(workers).toHaveLength(2);
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('aborts promptly and terminates the worker', async () => {
    const controller = new AbortController();
    const workers: FakeWorker[] = [];
    const promise = startTracker(options(workers, [{ kind: 'silent' }], { signal: controller.signal }));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(workers[0]!.terminated).toBe(true);
  });

  it('replaces a GPU delegate that warms up like a software rasterizer with a faster CPU worker', async () => {
    const workers: FakeWorker[] = [];
    const tracker = await startTracker(
      options(workers, [
        { kind: 'ready', warmupMs: [5300, 117, 112, 115] },
        { kind: 'ready', warmupMs: [100, 24, 28, 25] },
      ]),
    );
    expect(tracker.backend).toBe('CPU');
    expect(tracker.fallbackReason).toMatch(/software rendering/);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.terminated).toBe(false);
  });

  it('keeps a slow GPU when CPU is slower or fails', async () => {
    const slower: FakeWorker[] = [];
    const t1 = await startTracker(
      options(slower, [
        { kind: 'ready', warmupMs: [900, 60, 61] },
        { kind: 'ready', warmupMs: [300, 90, 95] },
      ]),
    );
    expect(t1.backend).toBe('GPU');
    expect(slower[1]!.terminated).toBe(true);
    const failing: FakeWorker[] = [];
    const t2 = await startTracker(options(failing, [{ kind: 'ready', warmupMs: [900, 60, 61] }, { kind: 'error', code: 'unknown' }]));
    expect(t2.backend).toBe('GPU');
    expect(failing[0]!.terminated).toBe(false);
  });

  it('does not second-guess an explicitly requested backend', async () => {
    const workers: FakeWorker[] = [];
    const tracker = await startTracker(options(workers, [{ kind: 'ready', warmupMs: [900, 300, 300] }], { backend: 'GPU' }));
    expect(tracker.backend).toBe('GPU');
    expect(workers).toHaveLength(1);
  });

  it('treats a worker load error as a crash and retries on CPU', async () => {
    const workers: FakeWorker[] = [];
    const opts = options(workers, [{ kind: 'silent' }, { kind: 'ready' }]);
    const promise = startTracker(opts);
    await flush();
    workers[0]!.crash();
    const tracker = await promise;
    expect(tracker.backend).toBe('CPU');
  });
});

describe('detection round trips', () => {
  async function ready() {
    const workers: FakeWorker[] = [];
    const tracker = await startTracker(options(workers, [{ kind: 'ready' }]));
    return { tracker, worker: workers[0]! };
  }

  it('transfers the bitmap and resolves with the validated matching result', async () => {
    const { tracker, worker } = await ready();
    const bitmap = new FakeBitmap();
    const promise = tracker.detect({ epoch: 1, seq: 7, sourceTimeMs: 100, width: 640, height: 480, bitmap: bitmap.asBitmap() });
    expect(worker.transfers.at(-1)).toEqual([bitmap]);
    expect(tracker.busy).toBe(true);
    worker.answer(7, 1, 100);
    const result = await promise;
    expect(result.seq).toBe(7);
    expect(tracker.busy).toBe(false);
  });

  it('ignores late answers for frames that already timed out', async () => {
    vi.useFakeTimers();
    const { tracker, worker } = await ready();
    const promise = tracker.detect({ epoch: 1, seq: 1, sourceTimeMs: 1, width: 1, height: 1, bitmap: new FakeBitmap().asBitmap() });
    const assertion = expect(promise).rejects.toBeInstanceOf(DetectTimeoutError);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    worker.answer(1, 1, 1);
    expect(tracker.diagnostics.lateResults).toBe(1);
    expect(tracker.busy).toBe(false);
  });

  it('rejects the pending frame when the worker sends a malformed result for it', async () => {
    const { tracker, worker } = await ready();
    const promise = tracker.detect({ epoch: 1, seq: 2, sourceTimeMs: 1, width: 1, height: 1, bitmap: new FakeBitmap().asBitmap() });
    worker.emit({ type: 'result', epoch: 1, seq: 2, sourceTimeMs: 1, inferenceMs: 1, hands: [{ landmarks: [Number.NaN] }] });
    await expect(promise).rejects.toBeInstanceOf(DetectFailedError);
    expect(tracker.diagnostics.invalidMessages).toBe(1);
  });

  it('closes the bitmap itself when the transfer fails', async () => {
    const { tracker, worker } = await ready();
    worker.throwOnPost = true;
    const bitmap = new FakeBitmap();
    await expect(
      tracker.detect({ epoch: 1, seq: 3, sourceTimeMs: 1, width: 1, height: 1, bitmap: bitmap.asBitmap() }),
    ).rejects.toBeInstanceOf(DetectFailedError);
    expect(bitmap.closed).toBe(true);
    expect(tracker.busy).toBe(false);
  });

  it('rejects in-flight work and notifies on a worker crash', async () => {
    const { tracker, worker } = await ready();
    const crashed = vi.fn();
    tracker.onCrash(crashed);
    const promise = tracker.detect({ epoch: 1, seq: 4, sourceTimeMs: 1, width: 1, height: 1, bitmap: new FakeBitmap().asBitmap() });
    worker.crash();
    await expect(promise).rejects.toBeInstanceOf(DetectFailedError);
    expect(crashed).toHaveBeenCalledOnce();
  });

  it('disposes idempotently and refuses new frames, closing their bitmaps', async () => {
    const { tracker, worker } = await ready();
    tracker.dispose();
    tracker.dispose();
    expect(worker.terminated).toBe(true);
    expect(worker.posted.filter((m) => m.type === 'dispose')).toHaveLength(1);
    const bitmap = new FakeBitmap();
    await expect(
      tracker.detect({ epoch: 1, seq: 5, sourceTimeMs: 1, width: 1, height: 1, bitmap: bitmap.asBitmap() }),
    ).rejects.toBeInstanceOf(DetectFailedError);
    expect(bitmap.closed).toBe(true);
  });
});
