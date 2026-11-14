/**
 * Optional mirrored camera preview with a landmark skeleton (plan §4). The
 * preview is positioning feedback only; it updates at a reduced rate and
 * hiding it never stops inference (the video keeps rendering at 1 px).
 */
import { HAND_CONNECTIONS } from '../tracking/landmarks';
import type { HandPayload } from '../tracking/protocol';
import { el } from './dom';

export interface ContainFit {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** `object-fit: contain` placement of a frame inside a box (letterboxing). */
export function containFit(frameW: number, frameH: number, boxW: number, boxH: number): ContainFit {
  if (frameW <= 0 || frameH <= 0 || boxW <= 0 || boxH <= 0) return { scale: 0, offsetX: 0, offsetY: 0 };
  const scale = Math.min(boxW / frameW, boxH / frameH);
  return { scale, offsetX: (boxW - frameW * scale) / 2, offsetY: (boxH - frameH * scale) / 2 };
}

/** Reach rectangle in unmirrored normalized camera coordinates. */
export interface PreviewReach {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

const MIN_INTERVAL_MS = 66; // ~15 Hz is enough for positioning feedback.

export class CameraPreview {
  readonly element: HTMLDivElement;
  readonly video: HTMLVideoElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private lastDraw = -Infinity;
  private visible = true;

  constructor() {
    this.video = el('video', { muted: true, playsinline: true, autoplay: true, class: 'mirrored' });
    this.video.muted = true;
    this.overlay = el('canvas', { class: 'mirrored', 'aria-hidden': 'true' });
    this.ctx = this.overlay.getContext('2d');
    this.element = el('div', { class: 'preview', role: 'img', 'aria-label': 'Mirrored camera preview' }, [
      this.video,
      this.overlay,
    ]);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.dataset.hidden = visible ? 'false' : 'true';
    if (!visible) this.clear();
  }

  clear(): void {
    this.ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  /** Draws skeletons at most ~15 times per second. */
  draw(hands: readonly HandPayload[], now: number, reach: PreviewReach | null): void {
    if (!this.visible || this.ctx === null) return;
    if (now - this.lastDraw < MIN_INTERVAL_MS) return;
    this.lastDraw = now;
    const ctx = this.ctx;
    const box = this.element.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    const fit = containFit(this.video.videoWidth, this.video.videoHeight, w, h);
    if (fit.scale === 0) return;
    const fw = this.video.videoWidth * fit.scale;
    const fh = this.video.videoHeight * fit.scale;
    if (reach !== null) {
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = dpr;
      ctx.strokeRect(fit.offsetX + reach.u0 * fw, fit.offsetY + reach.v0 * fh, (reach.u1 - reach.u0) * fw, (reach.v1 - reach.v0) * fh);
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 2 * dpr;
    ctx.lineCap = 'round';
    for (const hand of hands) {
      const lm = hand.landmarks;
      ctx.strokeStyle = '#7cf29a';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(fit.offsetX + lm[a * 3]! * fw, fit.offsetY + lm[a * 3 + 1]! * fh);
        ctx.lineTo(fit.offsetX + lm[b * 3]! * fw, fit.offsetY + lm[b * 3 + 1]! * fh);
      }
      ctx.stroke();
    }
  }
}
