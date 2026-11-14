/**
 * Local debug recording (plan §11, F32). Development and bench builds only.
 * Records tracking results (landmarks, timestamps, result ages) plus the
 * configuration and versions needed to replay them; never camera video.
 * Visible indicator, bounded duration and size, stop, discard, and export.
 */
import type { AppHandle } from '../app/app';
import { CONFIG_VERSION } from '../app/config';
import { MEDIAPIPE_VERSION, MODEL_SHA256 } from '../app/assets';
import type { HandPayload } from '../tracking/protocol';
import { el, setText } from '../ui/dom';
import { REPLAY_SCHEMA_VERSION, type ReplayFrame, type ReplayRecord } from './replay-format';

export interface RecorderLimits {
  readonly maxDurationMs: number;
  readonly maxFrames: number;
}

export const DEFAULT_RECORDER_LIMITS: RecorderLimits = { maxDurationMs: 120_000, maxFrames: 120 * 60 };

export class Recorder {
  readonly element: HTMLElement;
  private frames: ReplayFrame[] = [];
  private camera = { width: 0, height: 0 };
  private startedAt: number | null = null;
  private stoppedReason = '';
  private readonly status: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly discard: HTMLButtonElement;
  private readonly save: HTMLButtonElement;
  private timer: number | null = null;

  constructor(
    private readonly app: AppHandle,
    private readonly limits: RecorderLimits = DEFAULT_RECORDER_LIMITS,
  ) {
    this.status = el('span', { class: 'rec-status', 'aria-live': 'polite' }, ['Not recording']);
    this.toggle = el('button', { type: 'button', class: 'secondary' }, ['Record landmarks']);
    this.discard = el('button', { type: 'button', class: 'secondary', disabled: true }, ['Discard']);
    this.save = el('button', { type: 'button', class: 'secondary', disabled: true }, ['Export recording']);
    this.toggle.addEventListener('click', () => (this.recording ? this.stop('stopped') : this.start()));
    this.discard.addEventListener('click', () => this.clear());
    this.save.addEventListener('click', () => this.download());
    this.element = el('section', { class: 'recorder', 'aria-label': 'Developer landmark recorder' }, [
      el('strong', {}, ['Dev recorder (landmarks only, no video)']),
      this.status,
      el('div', { class: 'actions' }, [this.toggle, this.discard, this.save]),
    ]);
  }

  get recording(): boolean {
    return this.startedAt !== null;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  start(): void {
    if (this.recording) return;
    this.frames = [];
    this.startedAt = performance.now();
    this.app.resultTap = (t, hands, ageMs, camera) => this.capture(t, hands, ageMs, camera);
    this.element.dataset.recording = 'true';
    this.timer = window.setInterval(() => this.render(), 250);
    this.render();
  }

  private capture(t: number, hands: readonly HandPayload[], ageMs: number, camera: { width: number; height: number }): void {
    if (this.startedAt === null) return;
    const last = this.frames[this.frames.length - 1];
    if (last !== undefined && !(t > last.t)) return;
    this.camera = camera;
    this.frames.push({ t, ageMs, hands: hands.map((h) => ({ ...h, landmarks: [...h.landmarks], world: [...h.world] })) });
    if (performance.now() - this.startedAt >= this.limits.maxDurationMs) this.stop('duration limit reached');
    else if (this.frames.length >= this.limits.maxFrames) this.stop('size limit reached');
  }

  stop(reason: string): void {
    if (!this.recording) return;
    this.startedAt = null;
    this.stoppedReason = reason;
    this.app.resultTap = null;
    this.element.dataset.recording = 'false';
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.render();
  }

  clear(): void {
    this.stop('discarded');
    this.frames = [];
    this.render();
  }

  toRecord(): ReplayRecord {
    const layout = this.app.layout();
    const info = this.app.session.details;
    return {
      schema: REPLAY_SCHEMA_VERSION,
      source: 'recorded',
      createdAt: new Date().toISOString(),
      scenario: { name: 'local recording', description: `Recorded locally; stop reason: ${this.stoppedReason}`, tags: ['recorded'] },
      camera: this.camera,
      surface: { width: layout.width, height: layout.height, stripWidth: layout.board.x },
      configVersion: CONFIG_VERSION,
      config: this.app.config(),
      backend: { delegate: info.backend ?? 'unknown', mediapipeVersion: MEDIAPIPE_VERSION, modelSha256: MODEL_SHA256 },
      frames: this.frames,
      expected: {},
    };
  }

  download(): void {
    const blob = new Blob([JSON.stringify(this.toRecord())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `air-landmarks-${Date.now()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private render(): void {
    const seconds = this.recording && this.startedAt !== null ? Math.round((performance.now() - this.startedAt) / 1000) : 0;
    setText(
      this.status,
      this.recording ? `● Recording ${seconds} s, ${this.frames.length} frames` : this.frames.length > 0 ? `Stopped (${this.stoppedReason}): ${this.frames.length} frames` : 'Not recording',
    );
    setText(this.toggle, this.recording ? 'Stop recording' : 'Record landmarks');
    this.discard.disabled = this.frames.length === 0 && !this.recording;
    this.save.disabled = this.recording || this.frames.length === 0;
  }
}
