/**
 * Single lifecycle owner for the camera stream, inference worker, and frame
 * scheduler (plan §11). Start/stop are idempotent; a cancelled start that
 * resolves later has its stream stopped and its worker disposed immediately.
 *
 * States: idle → requesting-camera → loading-model → warming → ready, plus
 * paused (stream + worker kept, no admission), recovering (bounded worker
 * restart), and failed. Pausing is driven by the app (button, blur, hidden).
 */
import {
  CAMERA_ERROR_TEXT,
  CameraError,
  actualSettings,
  openCamera,
  stopStream,
  type ActualCameraSettings,
  type MediaEnvironment,
} from '../camera/camera-source';
import { FrameScheduler, type AdmittedResult, type VideoFrameSource } from '../camera/frame-scheduler';
import {
  TrackerInitError,
  startTracker,
  type BackendPreference,
  type TrackerClient,
  type WorkerLike,
} from '../tracking/tracker-client';
import type { CameraConfig } from './config';
import type { ResolvedAssets } from './assets';
import type { MetricsSink } from './metrics';

export type FailureKind =
  | CameraError['kind']
  | 'model-missing'
  | 'model-integrity'
  | 'model-timeout'
  | 'tracking-unsupported'
  | 'tracking-crashed';

export interface Failure {
  readonly kind: FailureKind;
  readonly title: string;
  readonly help: string;
  readonly detail: string;
}

export type SessionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'requesting-camera'; readonly modelLoading: boolean }
  | { readonly kind: 'loading-model' }
  | { readonly kind: 'warming'; readonly backend: string }
  | { readonly kind: 'ready'; readonly backend: string }
  | { readonly kind: 'paused'; readonly backend: string }
  | { readonly kind: 'recovering'; readonly attempt: number }
  | { readonly kind: 'failed'; readonly failure: Failure };

export interface SessionInfo {
  readonly camera: ActualCameraSettings | null;
  readonly backend: string | null;
  readonly fallbackReason: string | null;
  readonly initTimings: TrackerClient['timings'] | null;
  /** Main-thread ms from Start press to tracker ready (includes permission wait). */
  readonly startToReadyMs: number | null;
  /** Main-thread ms from camera stream available to tracker ready. */
  readonly permissionToReadyMs: number | null;
  /** Main-thread ms from tracker ready to the first accepted result. */
  readonly readyToFirstResultMs: number | null;
  readonly epoch: number;
}

/** The parts of HTMLVideoElement the session uses; tests substitute a fake. */
export interface SessionVideo extends VideoFrameSource {
  srcObject: MediaProvider | null;
  muted: boolean;
  playsInline: boolean;
  play(): Promise<void>;
}

export interface SessionDeps {
  readonly env: MediaEnvironment;
  readonly camera: () => CameraConfig;
  readonly video: SessionVideo;
  readonly snapshot: (video: SessionVideo) => Promise<ImageBitmap>;
  readonly requestAnimationFrame: (callback: () => void) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly assets: ResolvedAssets;
  readonly backend: BackendPreference;
  readonly createWorker: () => WorkerLike;
  readonly metrics: MetricsSink;
  readonly now: () => number;
  readonly onState: (state: SessionState) => void;
  /** Called with every admitted result in order. */
  readonly onResult: (admitted: AdmittedResult, epoch: number) => void;
  /** Called when a new source timeline starts (start, device switch, recovery). */
  readonly onSourceReset: (epoch: number) => void;
}

const MAX_RECOVERIES = 2;
const RECOVERY_WINDOW_MS = 60_000;

function failureFromTracker(error: unknown): Failure {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof TrackerInitError) {
    switch (error.code) {
      case 'model-fetch':
        return {
          kind: 'model-missing',
          title: 'Hand-tracking model could not be loaded',
          help: 'Check the connection and press Try again. Mouse drawing keeps working.',
          detail,
        };
      case 'model-integrity':
        return {
          kind: 'model-integrity',
          title: 'Hand-tracking model is damaged',
          help: 'The downloaded model failed its integrity check. Reload the page and try again.',
          detail,
        };
      case 'model-timeout':
      case 'timeout':
        return {
          kind: 'model-timeout',
          title: 'Hand tracking took too long to load',
          help: 'The connection may be slow. Press Try again, or keep drawing with the mouse.',
          detail,
        };
      case 'wasm-load':
      case 'delegate':
      case 'protocol':
      case 'unknown':
      case 'crash':
      case 'aborted':
        return {
          kind: 'tracking-unsupported',
          title: 'Hand tracking is not supported here',
          help: 'This browser or device could not run hand tracking. Use Chrome or Edge on a laptop, or keep drawing with the mouse.',
          detail,
        };
    }
  }
  return {
    kind: 'tracking-unsupported',
    title: 'Hand tracking could not start',
    help: 'Press Try again, or keep drawing with the mouse.',
    detail,
  };
}

function failureFromCamera(error: unknown): Failure {
  const kind = error instanceof CameraError ? error.kind : 'unknown';
  return { kind, ...CAMERA_ERROR_TEXT[kind], detail: error instanceof Error ? error.message : String(error) };
}

export class CameraSession {
  private stateValue: SessionState = { kind: 'idle' };
  private generation = 0;
  private epoch = 0;
  private stream: MediaStream | null = null;
  private tracker: TrackerClient | null = null;
  private scheduler: FrameScheduler<SessionVideo> | null = null;
  private abort: AbortController | null = null;
  private recoveries: number[] = [];
  private startPressedAt: number | null = null;
  private streamAt: number | null = null;
  private readyAt: number | null = null;
  private info: SessionInfo = {
    camera: null,
    backend: null,
    fallbackReason: null,
    initTimings: null,
    startToReadyMs: null,
    permissionToReadyMs: null,
    readyToFirstResultMs: null,
    epoch: 0,
  };

  constructor(private readonly deps: SessionDeps) {}

  get state(): SessionState {
    return this.stateValue;
  }

  get details(): SessionInfo {
    return this.info;
  }

  get active(): boolean {
    const k = this.stateValue.kind;
    return k !== 'idle' && k !== 'failed';
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  private setState(state: SessionState): void {
    this.stateValue = state;
    this.deps.onState(state);
  }

  /** Starts camera + tracking. A second call while active is ignored. */
  async start(deviceId: string | null = null): Promise<void> {
    if (this.active) return;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.startPressedAt = this.deps.now();
    this.recoveries = [];
    this.setState({ kind: 'requesting-camera', modelLoading: true });

    // Model loading runs in parallel with the permission prompt; both are
    // owned by this generation and released if it becomes obsolete. The
    // tracker may already be ready when the start is abandoned, so aborting
    // alone is not enough: a resolved tracker must be disposed too.
    const trackerPromise = this.createTracker(abort.signal);
    trackerPromise.catch(() => undefined);
    const releaseTracker = (): void => {
      abort.abort();
      void trackerPromise.then(
        (t) => t.dispose(),
        () => undefined,
      );
    };
    let stream: MediaStream;
    try {
      stream = await openCamera(this.deps.env, this.deps.camera(), deviceId);
    } catch (error) {
      releaseTracker();
      if (generation !== this.generation) return;
      this.setState({ kind: 'failed', failure: failureFromCamera(error) });
      return;
    }
    if (generation !== this.generation) {
      stopStream(stream);
      releaseTracker();
      return;
    }
    this.streamAt = this.deps.now();
    this.attachStream(stream);
    this.setState({ kind: 'loading-model' });

    let tracker: TrackerClient;
    try {
      tracker = await trackerPromise;
    } catch (error) {
      if (generation !== this.generation) return;
      this.releaseStream();
      this.setState({ kind: 'failed', failure: failureFromTracker(error) });
      return;
    }
    if (generation !== this.generation) {
      tracker.dispose();
      return;
    }
    this.adoptTracker(tracker);
    try {
      await this.deps.video.play();
    } catch {
      // Autoplay of a muted inline video is allowed after a user gesture; if it
      // still fails, frame callbacks simply never arrive and warming persists.
    }
    if (generation !== this.generation) return;
    this.startAdmission();
  }

  private createTracker(signal: AbortSignal): Promise<TrackerClient> {
    return startTracker({
      createWorker: this.deps.createWorker,
      assets: this.deps.assets,
      backend: this.deps.backend,
      initTimeoutMs: 45_000,
      detectTimeoutMs: 2_000,
      warmupFrames: 5,
      signal,
    });
  }

  private adoptTracker(tracker: TrackerClient): void {
    this.tracker = tracker;
    this.readyAt = this.deps.now();
    tracker.onCrash((message) => this.recover(message));
    this.info = {
      ...this.info,
      backend: tracker.backend,
      fallbackReason: tracker.fallbackReason,
      initTimings: tracker.timings,
      startToReadyMs: this.startPressedAt !== null ? this.readyAt - this.startPressedAt : null,
      permissionToReadyMs: this.streamAt !== null ? this.readyAt - this.streamAt : null,
      readyToFirstResultMs: null,
    };
    const tracker2 = tracker;
    this.scheduler = new FrameScheduler({
      video: this.deps.video,
      snapshot: this.deps.snapshot,
      detect: (envelope) => tracker2.detect(envelope),
      onResult: (admitted) => this.onResult(admitted),
      onFailure: (error) => this.onDetectFailure(error),
      now: this.deps.now,
      requestAnimationFrame: this.deps.requestAnimationFrame,
      cancelAnimationFrame: this.deps.cancelAnimationFrame,
      metrics: this.deps.metrics,
    });
  }

  private startAdmission(): void {
    if (this.tracker === null || this.scheduler === null) return;
    this.epoch++;
    this.info = { ...this.info, epoch: this.epoch };
    this.deps.onSourceReset(this.epoch);
    this.setState({ kind: 'warming', backend: this.tracker.backend });
    this.scheduler.start(this.epoch);
  }

  private onResult(admitted: AdmittedResult): void {
    if (admitted.result.epoch !== this.epoch) return;
    const kind = this.stateValue.kind;
    if (kind === 'warming' && this.tracker !== null) {
      if (this.readyAt !== null) {
        this.info = { ...this.info, readyToFirstResultMs: this.deps.now() - this.readyAt };
      }
      this.setState({ kind: 'ready', backend: this.tracker.backend });
    }
    this.deps.onResult(admitted, this.epoch);
  }

  private onDetectFailure(error: unknown): void {
    const name = error instanceof Error ? error.name : '';
    // A single failed frame is not fatal; timeouts and crashes trigger recovery.
    if (name === 'DetectTimeoutError') this.recover('Inference stopped responding.');
  }

  /** Bounded recovery: at most MAX_RECOVERIES worker restarts per minute. */
  private recover(reason: string): void {
    if (!this.active || this.stateValue.kind === 'recovering') return;
    const now = this.deps.now();
    this.recoveries = this.recoveries.filter((t) => now - t < RECOVERY_WINDOW_MS);
    this.scheduler?.stop();
    this.scheduler = null;
    this.tracker?.dispose();
    this.tracker = null;
    if (this.recoveries.length >= MAX_RECOVERIES) {
      this.releaseStream();
      this.setState({
        kind: 'failed',
        failure: {
          kind: 'tracking-crashed',
          title: 'Hand tracking stopped',
          help: 'Tracking failed repeatedly. Press Try again, or keep drawing with the mouse. Your board is unchanged.',
          detail: reason,
        },
      });
      return;
    }
    this.recoveries.push(now);
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.setState({ kind: 'recovering', attempt: this.recoveries.length });
    this.createTracker(abort.signal).then(
      (tracker) => {
        if (generation !== this.generation) {
          tracker.dispose();
          return;
        }
        this.adoptTracker(tracker);
        this.startAdmission();
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.releaseStream();
        this.setState({ kind: 'failed', failure: failureFromTracker(error) });
      },
    );
  }

  /** Suspends admission while keeping the stream and worker. */
  pause(): void {
    const s = this.stateValue;
    if (s.kind !== 'ready' && s.kind !== 'warming') return;
    this.scheduler?.stop();
    this.setState({ kind: 'paused', backend: s.backend });
  }

  resume(): void {
    if (this.stateValue.kind !== 'paused') return;
    this.startAdmission();
  }

  /** Switches camera device; the tracker is kept and its timeline reset. */
  async switchDevice(deviceId: string): Promise<void> {
    if (this.tracker === null || this.stream === null) return;
    const generation = ++this.generation;
    this.scheduler?.stop();
    this.releaseStream();
    this.setState({ kind: 'requesting-camera', modelLoading: false });
    let stream: MediaStream;
    try {
      stream = await openCamera(this.deps.env, this.deps.camera(), deviceId);
    } catch (error) {
      if (generation !== this.generation) return;
      this.disposeTracker();
      this.setState({ kind: 'failed', failure: failureFromCamera(error) });
      return;
    }
    if (generation !== this.generation) {
      stopStream(stream);
      return;
    }
    this.attachStream(stream);
    try {
      await this.deps.video.play();
    } catch {
      // See start().
    }
    if (generation !== this.generation) return;
    this.startAdmission();
  }

  /** Stops everything and returns to idle. Safe to call repeatedly. */
  stop(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.scheduler?.stop();
    this.scheduler = null;
    this.disposeTracker();
    this.releaseStream();
    if (this.stateValue.kind !== 'idle') this.setState({ kind: 'idle' });
  }

  private disposeTracker(): void {
    this.tracker?.dispose();
    this.tracker = null;
  }

  private attachStream(stream: MediaStream): void {
    this.stream = stream;
    this.info = { ...this.info, camera: actualSettings(stream) };
    const video = this.deps.video;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.onTrackEnded();
      });
    }
  }

  private onTrackEnded(): void {
    this.generation++;
    this.scheduler?.stop();
    this.scheduler = null;
    this.disposeTracker();
    this.releaseStream();
    this.setState({
      kind: 'failed',
      failure: { kind: 'disconnected', ...CAMERA_ERROR_TEXT.disconnected, detail: 'Video track ended.' },
    });
  }

  private releaseStream(): void {
    if (this.stream !== null) stopStream(this.stream);
    this.stream = null;
    this.deps.video.srcObject = null;
  }
}
