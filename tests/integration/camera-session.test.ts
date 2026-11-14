import { describe, expect, it } from 'vitest';
import { resolveAssets } from '../../src/app/assets';
import { CameraSession, type SessionState } from '../../src/app/camera-session';
import { DEFAULT_CONFIG } from '../../src/app/config';
import { Metrics } from '../../src/app/metrics';
import { FakeBitmap, FakeMedia, FakeVideo, FakeWorker, deferred, flush, type InitBehavior } from '../support/fakes';

function setup(behaviors: InitBehavior[] = []) {
  const media = new FakeMedia();
  const video = new FakeVideo();
  const workers: FakeWorker[] = [];
  const states: SessionState['kind'][] = [];
  const resets: number[] = [];
  let results = 0;
  const bitmaps: FakeBitmap[] = [];
  const session = new CameraSession({
    env: media.env(),
    camera: () => DEFAULT_CONFIG.camera,
    video,
    snapshot: () => {
      const b = new FakeBitmap();
      bitmaps.push(b);
      return Promise.resolve(b.asBitmap());
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    assets: resolveAssets('https://example.org/'),
    backend: 'auto',
    createWorker: () => {
      const w = new FakeWorker(behaviors[workers.length] ?? { kind: 'ready' });
      w.autoResult = true;
      workers.push(w);
      return w;
    },
    metrics: new Metrics(),
    now: () => 0,
    onState: (s) => states.push(s.kind),
    onResult: () => {
      results++;
    },
    onSourceReset: (epoch) => resets.push(epoch),
  });
  return { media, video, workers, states, resets, session, bitmaps, results: () => results };
}

const liveWorkers = (workers: FakeWorker[]) => workers.filter((w) => !w.terminated).length;

describe('camera session lifecycle', () => {
  it('reports truthful stages and becomes ready on the first accepted result', async () => {
    const s = setup();
    await s.session.start();
    expect(s.states).toEqual(['requesting-camera', 'loading-model', 'warming']);
    s.video.emitFrame(0.033);
    await flush(10);
    expect(s.session.state.kind).toBe('ready');
    expect(s.results()).toBe(1);
    expect(s.resets).toEqual([1]);
    expect(s.session.details.backend).toBe('GPU');
  });

  it('ignores a second Start while starting (double click)', async () => {
    const s = setup();
    const a = s.session.start();
    const b = s.session.start();
    await Promise.all([a, b]);
    expect(s.media.calls).toBe(1);
    expect(s.workers).toHaveLength(1);
  });

  it('stops a stream that arrives after the user cancelled', async () => {
    const s = setup();
    s.media.gate = deferred<void>();
    const starting = s.session.start();
    await flush();
    s.session.stop();
    expect(s.session.state.kind).toBe('idle');
    s.media.gate.resolve();
    await starting;
    await flush(10);
    expect(s.media.streams).toHaveLength(1);
    expect(s.media.liveTracks).toBe(0);
    expect(liveWorkers(s.workers)).toBe(0);
  });

  it('explains permission denial and releases the parallel model load', async () => {
    const s = setup();
    s.media.failWith = 'NotAllowedError';
    await s.session.start();
    await flush(10);
    const state = s.session.state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') expect(state.failure.kind).toBe('permission-denied');
    expect(liveWorkers(s.workers)).toBe(0);
    // Retry works after failure.
    s.media.failWith = null;
    await s.session.start();
    expect(s.session.state.kind).toBe('warming');
  });

  it('reports a damaged model and stops the camera', async () => {
    const s = setup([{ kind: 'error', code: 'model-integrity' }]);
    await s.session.start();
    const state = s.session.state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') expect(state.failure.kind).toBe('model-integrity');
    expect(s.media.liveTracks).toBe(0);
  });

  it('handles an unplugged camera without leaking the worker', async () => {
    const s = setup();
    await s.session.start();
    s.media.streams[0]!.track.end();
    const state = s.session.state;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') expect(state.failure.kind).toBe('disconnected');
    expect(liveWorkers(s.workers)).toBe(0);
  });

  it('leaves no streams, workers, or open bitmaps after twenty start/stop cycles', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
      await s.session.start();
      s.video.emitFrame(0.033 * (i + 1));
      await flush(10);
      s.session.stop();
      s.session.stop(); // idempotent
    }
    expect(s.media.streams).toHaveLength(20);
    expect(s.media.liveTracks).toBe(0);
    expect(s.workers).toHaveLength(20);
    expect(liveWorkers(s.workers)).toBe(0);
    expect(s.bitmaps.every((b) => b.closed)).toBe(true);
    expect(s.video.srcObject).toBeNull();
  });

  it('pauses admission and starts a new source epoch on resume', async () => {
    const s = setup();
    await s.session.start();
    s.video.emitFrame(0.033);
    await flush(10);
    s.session.pause();
    expect(s.session.state.kind).toBe('paused');
    s.video.emitFrame(0.066);
    await flush(10);
    expect(s.results()).toBe(1);
    s.session.resume();
    expect(s.resets).toEqual([1, 2]);
    s.video.emitFrame(0.1);
    await flush(10);
    expect(s.results()).toBe(2);
  });

  it('falls back to CPU after repeated frame failures and resumes results', async () => {
    const s = setup();
    await s.session.start();
    s.workers[0]!.throwOnPost = true;
    for (let i = 1; i <= 3; i++) {
      s.video.emitFrame(i * 0.033);
      await flush(10);
    }
    expect(s.workers[0]!.terminated).toBe(true);
    expect(s.session.details.backend).toBe('CPU');
    s.video.emitFrame(0.132);
    await flush(10);
    expect(s.session.state.kind).toBe('ready');
    expect(s.results()).toBe(1);
    s.session.stop();
  });

  it('resets the consecutive failure count after a successful frame', async () => {
    const s = setup();
    await s.session.start();
    for (let i = 1; i <= 6; i++) {
      s.workers[0]!.throwOnPost = i % 3 !== 0;
      s.video.emitFrame(i * 0.033);
      await flush(10);
    }
    expect(s.workers).toHaveLength(1);
    expect(s.results()).toBe(2);
    expect(s.session.state.kind).toBe('ready');
    s.session.stop();
  });

  it('bounds persistent frame failures and releases the camera', async () => {
    const s = setup();
    await s.session.start();
    for (let i = 1; i <= 9; i++) {
      s.workers.at(-1)!.throwOnPost = true;
      s.video.emitFrame(i * 0.033);
      await flush(10);
    }
    expect(s.session.state.kind).toBe('failed');
    expect(s.workers).toHaveLength(3);
    expect(liveWorkers(s.workers)).toBe(0);
    expect(s.media.liveTracks).toBe(0);
    await s.session.start();
    expect(s.session.details.backend).toBe('GPU');
    s.session.stop();
  });

  it('recovers from a crashed worker a bounded number of times', async () => {
    const s = setup();
    await s.session.start();
    s.video.emitFrame(0.033);
    await flush(10);
    s.workers[0]!.crash();
    expect(s.session.state.kind).toBe('recovering');
    await flush(10);
    expect(s.session.state.kind).toBe('warming');
    s.workers[1]!.crash();
    await flush(10);
    s.workers[2]!.crash();
    await flush(10);
    expect(s.session.state.kind).toBe('failed');
    expect(liveWorkers(s.workers)).toBe(0);
    expect(s.media.liveTracks).toBe(0);
  });
});
