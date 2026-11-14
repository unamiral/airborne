/**
 * Frame admission (plan §6.1–6.6).
 *
 * - New frames are discovered with requestVideoFrameCallback, or with
 *   requestAnimationFrame plus a changed `currentTime` check as fallback.
 *   Neither path may admit the same source frame twice.
 * - At most one pipeline operation (snapshot + inference) is in flight. Busy
 *   is set before the snapshot starts and cleared on every exit path. Frames
 *   arriving while busy are skipped and counted; nothing is queued.
 * - A stopped/obsolete generation closes any bitmap it still owns and drops
 *   its results.
 */
import type { MetricsSink } from '../app/metrics';
import type { ResultMessage } from '../tracking/protocol';
import { DetectTimeoutError, type DetectEnvelope } from '../tracking/tracker-client';

interface FrameMetadata {
  readonly mediaTime: number;
}

/** The subset of HTMLVideoElement used here; tests substitute a fake. */
export interface VideoFrameSource {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly currentTime: number;
  readonly readyState: number;
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export interface AdmittedResult {
  readonly result: ResultMessage;
  /** Main-thread time when the frame callback admitted the frame, ms. */
  readonly observedAt: number;
  /** Main-thread time when the validated result arrived, ms. */
  readonly receivedAt: number;
}

export interface FrameSchedulerDeps<V extends VideoFrameSource> {
  readonly video: V;
  readonly snapshot: (video: V) => Promise<ImageBitmap>;
  readonly detect: (envelope: DetectEnvelope) => Promise<ResultMessage>;
  readonly onResult: (admitted: AdmittedResult) => void;
  readonly onFailure: (error: unknown) => void;
  readonly now: () => number;
  readonly requestAnimationFrame: (callback: () => void) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly metrics: MetricsSink;
}

export class FrameScheduler<V extends VideoFrameSource> {
  private generation = 0;
  private running = false;
  private epoch = 0;
  private seq = 0;
  private busyFlag = false;
  private lastSourceMs = -Infinity;
  private lastSeenTime = Number.NaN;
  private lastFrameAt = Number.NaN;
  private vfcHandle: number | null = null;
  private rafHandle: number | null = null;

  constructor(private readonly deps: FrameSchedulerDeps<V>) {}

  get busy(): boolean {
    return this.busyFlag;
  }

  get usesVideoFrameCallback(): boolean {
    return typeof this.deps.video.requestVideoFrameCallback === 'function';
  }

  /** Starts admitting frames for `epoch`. Restarting resets the source clock. */
  start(epoch: number): void {
    this.stop();
    this.running = true;
    this.epoch = epoch;
    this.lastSourceMs = -Infinity;
    this.lastSeenTime = Number.NaN;
    this.lastFrameAt = Number.NaN;
    this.schedule(this.generation);
  }

  /** Stops admission. An in-flight operation finishes, but its result is dropped. */
  stop(): void {
    this.running = false;
    this.generation++;
    const video = this.deps.video;
    if (this.vfcHandle !== null) video.cancelVideoFrameCallback?.(this.vfcHandle);
    if (this.rafHandle !== null) this.deps.cancelAnimationFrame(this.rafHandle);
    this.vfcHandle = null;
    this.rafHandle = null;
  }

  private schedule(generation: number): void {
    if (!this.running || generation !== this.generation) return;
    const video = this.deps.video;
    if (typeof video.requestVideoFrameCallback === 'function') {
      this.vfcHandle = video.requestVideoFrameCallback((_now, metadata) => {
        this.vfcHandle = null;
        if (generation !== this.generation) return;
        this.onFrame(metadata.mediaTime * 1000, generation);
        this.schedule(generation);
      });
    } else {
      this.rafHandle = this.deps.requestAnimationFrame(() => {
        this.rafHandle = null;
        if (generation !== this.generation) return;
        const time = video.currentTime;
        if (time !== this.lastSeenTime) {
          this.lastSeenTime = time;
          this.onFrame(time * 1000, generation);
        }
        this.schedule(generation);
      });
    }
  }

  private onFrame(sourceTimeMs: number, generation: number): void {
    const { deps } = this;
    const video = deps.video;
    deps.metrics.count('sourceFrames');
    const frameAt = deps.now();
    if (Number.isFinite(this.lastFrameAt)) deps.metrics.sample('sourceIntervalMs', frameAt - this.lastFrameAt);
    this.lastFrameAt = frameAt;
    if (!Number.isFinite(sourceTimeMs) || sourceTimeMs <= this.lastSourceMs) {
      deps.metrics.count('duplicateFrames');
      return;
    }
    if (this.busyFlag) {
      deps.metrics.count('busySkips');
      return;
    }
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

    this.busyFlag = true;
    this.lastSourceMs = sourceTimeMs;
    const observedAt = frameAt;
    const seq = ++this.seq;
    const epoch = this.epoch;
    deps.metrics.count('admitted');

    let snapshotFailed = false;
    const run = async (): Promise<void> => {
      const snapshotStarted = deps.now();
      let bitmap: ImageBitmap;
      try {
        bitmap = await deps.snapshot(video);
      } catch (error) {
        snapshotFailed = true;
        throw error;
      }
      deps.metrics.sample('snapshotMs', deps.now() - snapshotStarted);
      if (generation !== this.generation) {
        bitmap.close();
        deps.metrics.count('obsoleteResults');
        return;
      }
      const posted = deps.now();
      const result = await deps.detect({
        epoch,
        seq,
        sourceTimeMs,
        width: bitmap.width,
        height: bitmap.height,
        bitmap,
      });
      const receivedAt = deps.now();
      deps.metrics.sample('roundTripMs', receivedAt - posted);
      if (generation !== this.generation) {
        deps.metrics.count('obsoleteResults');
        return;
      }
      deps.onResult({ result, observedAt, receivedAt });
    };

    run()
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        if (snapshotFailed) deps.metrics.count('snapshotFailures');
        else if (error instanceof DetectTimeoutError) deps.metrics.count('timeouts');
        else deps.metrics.count('detectErrors');
        deps.onFailure(error);
      })
      .finally(() => {
        this.busyFlag = false;
      });
  }
}
