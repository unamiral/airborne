/**
 * Guided practice progress (plan §4 "Learning and recovery"). Steps are
 * validated through domain events on a separate practice board, never by
 * recognizing shapes:
 *   draw  – a committed stroke at least 40 CSS px long
 *   pan   – the board moved at least 40 CSS px
 *   zoom  – the scale changed by at least 15%
 *   erase – a practice stroke was deleted
 */
import type { Stroke } from '../board/stroke';
import { toBoard, toWorld, type View } from '../board/view';
import { boardPoint, type WorldPoint } from '../core/coords';

export type PracticeStep = 'draw' | 'pan' | 'zoom' | 'erase';
export const PRACTICE_STEPS: readonly PracticeStep[] = ['draw', 'pan', 'zoom', 'erase'];

export const PRACTICE_THRESHOLDS = {
  strokeLengthPx: 40,
  panPx: 40,
  scaleChange: 0.15,
} as const;

/** Stroke length in CSS px at the current view scale. */
export function strokeLengthPx(stroke: Stroke, scale: number): number {
  let length = 0;
  let px = Number.NaN;
  let py = Number.NaN;
  stroke.points.forEach((x, y) => {
    if (!Number.isNaN(px)) length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  });
  return length * scale;
}

export class PracticeTracker {
  private stepIndex = 0;
  private baseline: { view: View; anchor: WorldPoint } | null = null;
  readonly startedAt: number;
  completedAt: number | null = null;

  constructor(
    private readonly now: () => number,
    private readonly boardCenter: () => { x: number; y: number },
    view: View,
  ) {
    this.startedAt = now();
    this.rebase(view);
  }

  get current(): PracticeStep | null {
    return PRACTICE_STEPS[this.stepIndex] ?? null;
  }

  isDone(step: PracticeStep): boolean {
    return PRACTICE_STEPS.indexOf(step) < this.stepIndex;
  }

  get complete(): boolean {
    return this.stepIndex >= PRACTICE_STEPS.length;
  }

  get elapsedMs(): number {
    return (this.completedAt ?? this.now()) - this.startedAt;
  }

  private rebase(view: View): void {
    const c = this.boardCenter();
    this.baseline = { view, anchor: toWorld(view, boardPoint(c.x, c.y)) };
  }

  private advance(view: View): void {
    this.stepIndex++;
    this.rebase(view);
    if (this.complete) this.completedAt = this.now();
  }

  strokeCommitted(stroke: Stroke, view: View): void {
    if (this.current === 'draw' && strokeLengthPx(stroke, view.scale) >= PRACTICE_THRESHOLDS.strokeLengthPx) this.advance(view);
  }

  viewChanged(view: View): void {
    const base = this.baseline;
    if (base === null) return;
    if (this.current === 'pan') {
      const c = this.boardCenter();
      const moved = toBoard(view, base.anchor);
      if (Math.hypot(moved.x - c.x, moved.y - c.y) >= PRACTICE_THRESHOLDS.panPx) this.advance(view);
    } else if (this.current === 'zoom') {
      if (Math.abs(view.scale / base.view.scale - 1) >= PRACTICE_THRESHOLDS.scaleChange) this.advance(view);
    }
  }

  strokesErased(count: number, view: View): void {
    if (this.current === 'erase' && count > 0) this.advance(view);
  }
}
