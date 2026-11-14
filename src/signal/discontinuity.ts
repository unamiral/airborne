/**
 * Tracking-discontinuity detection for the pen point (plan §8.2).
 *
 * A sample is flagged only when BOTH
 *  1. its residual against a constant-velocity prediction (actual elapsed
 *     time) exceeds max(minResidualPx, palmRatio * palmSize,
 *     median + k * MAD of the last `historySize` accepted residuals),
 *     scaled up for longer intervals, and
 *  2. independent evidence disagrees: the palm size jumped, or the pen moved
 *     relative to the palm by more than the same floor.
 * Speed or a sharp corner alone is never an outlier. Rejected samples are not
 * added to the residual history and must not be fed to the coordinate filter.
 */
import type { OutlierConfig } from '../app/config';
import type { XY } from '../core/coords';

export interface PenObservation {
  /** Source time, ms. */
  readonly t: number;
  /** Raw (unfiltered) mapped pen position, surface CSS px. */
  readonly pen: XY;
  /** Mapped palm centre, surface CSS px. */
  readonly palm: XY;
  /** Mapped palm size, surface CSS px. */
  readonly palmSize: number;
}

export interface DiscontinuityVerdict {
  readonly outlier: boolean;
  readonly residual: number;
  readonly threshold: number;
  readonly consistent: boolean;
}

const NOMINAL_INTERVAL_MS = 1000 / 30;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class DiscontinuityDetector {
  private residuals: number[] = [];
  private prev: PenObservation | null = null;
  private last: PenObservation | null = null;

  constructor(private readonly config: OutlierConfig) {}

  reset(): void {
    this.residuals = [];
    this.prev = null;
    this.last = null;
  }

  /** Evaluates a sample without changing state. */
  check(o: PenObservation): DiscontinuityVerdict {
    const last = this.last;
    if (last === null) return { outlier: false, residual: 0, threshold: Number.POSITIVE_INFINITY, consistent: true };
    const dt = o.t - last.t;
    let px = last.pen.x;
    let py = last.pen.y;
    if (this.prev !== null) {
      const dtPrev = last.t - this.prev.t;
      if (dtPrev > 0) {
        px += ((last.pen.x - this.prev.pen.x) / dtPrev) * dt;
        py += ((last.pen.y - this.prev.pen.y) / dtPrev) * dt;
      }
    }
    const residual = Math.hypot(o.pen.x - px, o.pen.y - py);
    const c = this.config;
    const floor = Math.max(c.minResidualPx, c.palmResidualRatio * o.palmSize);
    let robust = 0;
    if (this.residuals.length >= 3) {
      const med = median(this.residuals);
      const mad = median(this.residuals.map((r) => Math.abs(r - med)));
      robust = med + c.madMultiplier * mad;
    }
    const threshold = Math.max(floor, robust) * Math.max(1, dt / NOMINAL_INTERVAL_MS);
    const sizeJump = Math.abs(o.palmSize / Math.max(last.palmSize, 1e-6) - 1) > c.palmScaleJumpRatio;
    const relX = o.pen.x - o.palm.x - (last.pen.x - last.palm.x);
    const relY = o.pen.y - o.palm.y - (last.pen.y - last.palm.y);
    const penJumpedOnHand = Math.hypot(relX, relY) > floor;
    const consistent = !sizeJump && !penJumpedOnHand;
    return { outlier: residual > threshold && !consistent, residual, threshold, consistent };
  }

  /** Records an accepted sample. Never call this for rejected samples. */
  accept(o: PenObservation, residual: number): void {
    if (this.last !== null) {
      this.residuals.push(residual);
      if (this.residuals.length > this.config.historySize) this.residuals.shift();
    }
    this.prev = this.last;
    this.last = o;
  }
}
