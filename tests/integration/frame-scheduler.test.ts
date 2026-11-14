import { describe, expect, it, vi } from 'vitest';
import { Metrics } from '../../src/app/metrics';
import { FrameScheduler, type AdmittedResult } from '../../src/camera/frame-scheduler';
import type { ResultMessage } from '../../src/tracking/protocol';
import type { DetectEnvelope } from '../../src/tracking/tracker-client';
import { FakeBitmap, FakeVideo, deferred, flush, type Deferred } from '../support/fakes';

function setup(video = new FakeVideo()) {
  const metrics = new Metrics();
  const bitmaps: FakeBitmap[] = [];
  const snapshots: Array<Deferred<ImageBitmap>> = [];
  const detects: Array<{ envelope: DetectEnvelope; reply: Deferred<ResultMessage> }> = [];
  const results: AdmittedResult[] = [];
  const failures: unknown[] = [];
  let now = 0;
  const rafCallbacks: Array<() => void> = [];
  const scheduler = new FrameScheduler({
    video,
    snapshot: () => {
      const d = deferred<ImageBitmap>();
      snapshots.push(d);
      return d.promise;
    },
    detect: (envelope) => {
      const reply = deferred<ResultMessage>();
      detects.push({ envelope, reply });
      return reply.promise;
    },
    onResult: (r) => results.push(r),
    onFailure: (e) => failures.push(e),
    now: () => now,
    requestAnimationFrame: (cb) => rafCallbacks.push(cb),
    cancelAnimationFrame: () => undefined,
    metrics,
  });
  const resolveSnapshot = (i: number) => {
    const b = new FakeBitmap();
    bitmaps.push(b);
    snapshots[i]!.resolve(b.asBitmap());
    return b;
  };
  const answer = (i: number) => {
    const { envelope, reply } = detects[i]!;
    (envelope.bitmap as unknown as FakeBitmap).close(); // worker closes it
    reply.resolve({
      type: 'result',
      epoch: envelope.epoch,
      seq: envelope.seq,
      sourceTimeMs: envelope.sourceTimeMs,
      inferenceMs: 5,
      hands: [],
    });
  };
  return {
    video, metrics, scheduler, snapshots, detects, results, failures, bitmaps, rafCallbacks,
    resolveSnapshot, answer,
    setNow: (t: number) => { now = t; },
  };
}

describe('frame admission', () => {
  it('keeps one operation in flight, queues no images, and admits the newest skipped frame when free', async () => {
    const s = setup();
    s.scheduler.start(1);
    s.setNow(0);
    s.video.emitFrame(0.033);
    expect(s.scheduler.busy).toBe(true);
    expect(s.snapshots).toHaveLength(1);
    s.setNow(33);
    s.video.emitFrame(0.066);
    s.setNow(66);
    s.video.emitFrame(0.1);
    // No snapshot while busy; the older waiting frame was superseded.
    expect(s.snapshots).toHaveLength(1);
    expect(s.metrics.counter('busySkips')).toBe(1);
    s.resolveSnapshot(0);
    await flush();
    expect(s.detects).toHaveLength(1);
    s.setNow(80);
    s.answer(0);
    await flush();
    expect(s.results).toHaveLength(1);
    // The newest frame (0.1 s) is admitted immediately, keeping its observation time.
    expect(s.snapshots).toHaveLength(2);
    expect(s.metrics.counter('deferredAdmissions')).toBe(1);
    s.resolveSnapshot(1);
    await flush();
    expect(s.detects[1]!.envelope.sourceTimeMs).toBeCloseTo(100, 6);
    expect(s.detects[1]!.envelope.seq).toBe(2);
    s.answer(1);
    await flush();
    expect(s.results[1]!.observedAt).toBe(66);
    expect(s.scheduler.busy).toBe(false);
    expect(s.bitmaps.every((b) => b.closed)).toBe(true);
  });

  it('never admits a duplicate or reversed source timestamp', async () => {
    const s = setup();
    s.scheduler.start(1);
    s.video.emitFrame(0.5);
    s.resolveSnapshot(0);
    await flush();
    s.answer(0);
    await flush();
    s.video.emitFrame(0.5);
    s.video.emitFrame(0.4);
    expect(s.snapshots).toHaveLength(1);
    expect(s.metrics.counter('duplicateFrames')).toBe(2);
  });

  it('closes a bitmap whose snapshot completes after stop and drops the work', async () => {
    const s = setup();
    s.scheduler.start(1);
    s.video.emitFrame(0.033);
    s.scheduler.stop();
    const bitmap = s.resolveSnapshot(0);
    await flush();
    expect(bitmap.closed).toBe(true);
    expect(s.detects).toHaveLength(0);
    expect(s.scheduler.busy).toBe(false);
    expect(s.metrics.counter('obsoleteResults')).toBe(1);
  });

  it('drops results that arrive after stop, but stays busy until the worker answers', async () => {
    const s = setup();
    s.scheduler.start(1);
    s.video.emitFrame(0.033);
    s.resolveSnapshot(0);
    await flush();
    s.scheduler.stop();
    s.scheduler.start(2);
    s.video.emitFrame(0.066);
    // Still one operation in flight from the old epoch: no second admission.
    expect(s.snapshots).toHaveLength(1);
    s.answer(0);
    await flush();
    expect(s.results).toHaveLength(0);
    expect(s.scheduler.busy).toBe(false);
    s.video.emitFrame(0.1);
    expect(s.snapshots).toHaveLength(2);
  });

  it('clears busy and reports when inference fails', async () => {
    const s = setup();
    s.scheduler.start(1);
    s.video.emitFrame(0.033);
    s.resolveSnapshot(0);
    await flush();
    s.detects[0]!.reply.reject(new Error('boom'));
    await flush();
    expect(s.failures).toHaveLength(1);
    expect(s.scheduler.busy).toBe(false);
    expect(s.metrics.counter('detectErrors')).toBe(1);
  });

  it('clears busy and counts snapshot failures separately', async () => {
    const s = setup();
    s.scheduler.start(1);
    s.video.emitFrame(0.033);
    s.snapshots[0]!.reject(new Error('InvalidStateError'));
    await flush();
    expect(s.scheduler.busy).toBe(false);
    expect(s.metrics.counter('snapshotFailures')).toBe(1);
    expect(s.metrics.counter('detectErrors')).toBe(0);
  });

  it('does not admit frames before the video has dimensions', () => {
    const video = new FakeVideo();
    video.videoWidth = 0;
    const s = setup(video);
    s.scheduler.start(1);
    video.emitFrame(0.033);
    expect(s.snapshots).toHaveLength(0);
  });

  it('records the main-thread observation time with each result', async () => {
    const s = setup();
    s.scheduler.start(1);
    s.setNow(1000);
    s.video.emitFrame(0.033);
    s.resolveSnapshot(0);
    await flush();
    s.setNow(1030);
    s.answer(0);
    await flush();
    expect(s.results[0]).toMatchObject({ observedAt: 1000, receivedAt: 1030 });
    expect(s.results[0]!.result.sourceTimeMs).toBeCloseTo(33, 6);
  });
});

describe('requestAnimationFrame fallback', () => {
  it('admits a frame only when currentTime changes', async () => {
    const video = new FakeVideo() as FakeVideo & { requestVideoFrameCallback?: unknown };
    delete (video as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback;
    Object.defineProperty(video, 'requestVideoFrameCallback', { value: undefined });
    const s = setup(video);
    s.scheduler.start(1);
    expect(s.scheduler.usesVideoFrameCallback).toBe(false);
    video.currentTime = 1;
    s.rafCallbacks.shift()!();
    expect(s.snapshots).toHaveLength(1);
    s.resolveSnapshot(0);
    await flush();
    s.answer(0);
    await flush();
    // Same currentTime on the next animation frames: no repeat inference.
    s.rafCallbacks.shift()!();
    s.rafCallbacks.shift()!();
    expect(s.snapshots).toHaveLength(1);
    video.currentTime = 1.033;
    s.rafCallbacks.shift()!();
    expect(s.snapshots).toHaveLength(2);
    vi.restoreAllMocks();
  });
});
