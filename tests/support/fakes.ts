/**
 * Deterministic stand-ins for browser objects used by the camera/tracking
 * lifecycle. They record ownership events so tests can assert that every
 * bitmap is closed, every track stopped, and every worker terminated.
 */
import type { SessionVideo } from '../../src/app/camera-session';
import type { MediaEnvironment } from '../../src/camera/camera-source';
import { LANDMARK_VALUES, PROTOCOL_VERSION, type MainToWorker } from '../../src/tracking/protocol';
import type { WorkerLike } from '../../src/tracking/tracker-client';

export class FakeBitmap {
  closed = false;
  constructor(
    readonly width = 640,
    readonly height = 480,
  ) {}
  close(): void {
    this.closed = true;
  }
  asBitmap(): ImageBitmap {
    return this;
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

export class FakeVideo implements SessionVideo {
  videoWidth = 640;
  videoHeight = 480;
  currentTime = 0;
  readyState = 4;
  srcObject: MediaProvider | null = null;
  muted = false;
  playsInline = false;
  private callbacks: Array<(now: number, metadata: { mediaTime: number }) => void> = [];
  private nextHandle = 1;

  requestVideoFrameCallback = (cb: (now: number, metadata: { mediaTime: number }) => void): number => {
    this.callbacks.push(cb);
    return this.nextHandle++;
  };

  cancelVideoFrameCallback = (): void => {
    this.callbacks = [];
  };

  play(): Promise<void> {
    return Promise.resolve();
  }

  /** Presents a new frame with the given media time in seconds. */
  emitFrame(mediaTime: number): void {
    const pending = this.callbacks;
    this.callbacks = [];
    for (const cb of pending) cb(0, { mediaTime });
  }

  get pendingCallbacks(): number {
    return this.callbacks.length;
  }
}

export class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  readonly kind = 'video';
  readonly label = 'Fake camera';
  stop(): void {
    this.readyState = 'ended';
  }
  getSettings(): MediaTrackSettings {
    return { width: 640, height: 480, frameRate: 30, deviceId: 'fake' };
  }
  /** Simulates an unplugged camera. */
  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

export class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  getVideoTracks(): FakeTrack[] {
    return [this.track];
  }
  asStream(): MediaStream {
    return this as unknown as MediaStream;
  }
}

export class FakeMedia {
  readonly streams: FakeStream[] = [];
  calls = 0;
  /** When set, the next getUserMedia call waits on this. */
  gate: Deferred<void> | null = null;
  failWith: string | null = null;

  env(): MediaEnvironment {
    return {
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: async () => {
          this.calls++;
          if (this.gate !== null) await this.gate.promise;
          if (this.failWith !== null) throw Object.assign(new Error(this.failWith), { name: this.failWith });
          const stream = new FakeStream();
          this.streams.push(stream);
          return stream.asStream();
        },
        enumerateDevices: () => Promise.resolve([]),
      },
    };
  }

  get liveTracks(): number {
    return this.streams.filter((s) => s.track.readyState === 'live').length;
  }
}

type Listener = (event: { data?: unknown }) => void;

export type InitBehavior =
  | { kind: 'ready'; warmupMs?: number[] }
  | { kind: 'error'; code: string }
  | { kind: 'silent' };

/** Fake inference worker. Detect requests are answered manually or automatically. */
export class FakeWorker implements WorkerLike {
  readonly posted: MainToWorker[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  autoResult = false;
  hands = 1;
  throwOnPost = false;
  private listeners = new Map<string, Listener[]>();

  constructor(private readonly init: InitBehavior = { kind: 'ready' }) {}

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as Listener);
    this.listeners.set(type, list);
  }

  postMessage(message: MainToWorker, transfer: Transferable[]): void {
    if (this.throwOnPost && message.type === 'detect') throw new Error('DataCloneError');
    this.posted.push(message);
    this.transfers.push(transfer);
    if (message.type === 'init') {
      queueMicrotask(() => {
        if (this.init.kind === 'ready') {
          this.emit({
            type: 'ready',
            protocol: PROTOCOL_VERSION,
            backend: message.delegate,
            timings: { modelFetchMs: 5, modelVerifyMs: 1, createMs: 10, warmupMs: this.init.warmupMs ?? [30, 12, 11] },
          });
        } else if (this.init.kind === 'error') {
          this.emit({ type: 'init-error', code: this.init.code, delegate: message.delegate, message: 'fake failure' });
        }
      });
    } else if (message.type === 'detect' && this.autoResult) {
      // The worker owns and closes the transferred bitmap.
      message.bitmap.close();
      queueMicrotask(() => this.answer(message.seq, message.epoch, message.sourceTimeMs));
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    for (const l of this.listeners.get('message') ?? []) l({ data });
  }

  crash(): void {
    for (const l of this.listeners.get('error') ?? []) l({});
  }

  answer(seq: number, epoch: number, sourceTimeMs: number): void {
    this.emit({
      type: 'result',
      epoch,
      seq,
      sourceTimeMs,
      inferenceMs: 7,
      hands: Array.from({ length: this.hands }, () => ({
        landmarks: Array.from({ length: LANDMARK_VALUES }, () => 0.5),
        world: Array.from({ length: LANDMARK_VALUES }, () => 0.01),
        handedness: 'Right',
        handednessScore: 0.9,
      })),
    });
  }

  lastDetect(): Extract<MainToWorker, { type: 'detect' }> | undefined {
    const detects = this.posted.filter((m): m is Extract<MainToWorker, { type: 'detect' }> => m.type === 'detect');
    return detects[detects.length - 1];
  }
}
