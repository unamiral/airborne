/**
 * M0 renderer stub: opaque Canvas 2D board that redraws everything when
 * dirty. Replaced by the cached incremental renderer in M1/M2.
 */
import type { Stroke } from '../board/document';

export interface CursorView {
  readonly x: number;
  readonly y: number;
  readonly color: string;
  readonly diameter: number;
}

export interface ContextReport {
  readonly desynchronized: boolean | null;
  readonly alpha: boolean | null;
}

export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cssWidth = 0;
  private cssHeight = 0;
  private scale = 1;
  readonly contextReport: ContextReport;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (ctx === null) throw new Error('Canvas 2D is not available in this browser.');
    this.ctx = ctx;
    const attrs = typeof ctx.getContextAttributes === 'function' ? ctx.getContextAttributes() : null;
    this.contextReport = {
      desynchronized: attrs?.desynchronized ?? null,
      alpha: attrs?.alpha ?? null,
    };
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.scale = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.scale));
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.scale));
  }

  draw(strokes: readonly Stroke[], active: Stroke | null, cursor: CursorView | null): void {
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) this.drawStroke(stroke);
    if (active !== null) this.drawStroke(active);
    if (cursor !== null) {
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, Math.max(cursor.diameter / 2, 3), 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = cursor.color;
      ctx.stroke();
    }
  }

  private drawStroke(stroke: Stroke): void {
    const ctx = this.ctx;
    const p = stroke.points;
    if (p.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    if (p.length === 2) {
      ctx.beginPath();
      ctx.arc(p[0]!, p[1]!, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    ctx.stroke();
  }
}
