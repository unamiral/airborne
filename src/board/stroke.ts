/**
 * Strokes and the incremental stroke builder (plan §8.5, §10).
 *
 * A stroke stores its observed/filtered centerline in world coordinates with
 * a constant world-space width and a frozen color. No predicted points are
 * ever stored. Committed strokes are immutable and shared by the document
 * and the history.
 *
 * Retention: the first point always; then a sample only when it is at least
 * `spacing` (0.5 CSS px at creation scale) from the last retained point.
 * Closer samples replace a single live endpoint, so a stationary pen neither
 * grows memory nor loses the true endpoint. Corners are flagged at retained
 * vertices whose direction changes by at least `cornerAngleDeg` with both
 * adjacent segments at least `cornerMinSegment` long.
 */
import { emptyBounds, extendBounds, type Bounds } from '../core/coords';
import { PointBuffer, type ReadonlyPoints } from './points';

export interface Stroke {
  readonly id: number;
  /** Document order key; strokes are drawn in ascending seq. */
  readonly seq: number;
  readonly color: string;
  /** World units. */
  readonly width: number;
  readonly points: ReadonlyPoints;
  /** Sorted indices of corner vertices. */
  readonly corners: readonly number[];
  /** Centerline bounds in world units (not inflated by width). */
  readonly bounds: Bounds;
  readonly geometryVersion: number;
}

export interface StrokeStyle {
  readonly color: string;
  /** World units. */
  readonly width: number;
}

export interface BuilderSpacing {
  /** Minimum retained spacing, world units. */
  readonly spacing: number;
  readonly cornerAngleDeg: number;
  /** World units. */
  readonly cornerMinSegment: number;
}

export function strokeBytes(stroke: Stroke): number {
  return stroke.points.byteLength + stroke.corners.length * 8 + 96;
}

export function isDot(stroke: Pick<Stroke, 'points'>): boolean {
  const p = stroke.points;
  if (p.length <= 1) return true;
  if (p.length === 2) return p.x(0) === p.x(1) && p.y(0) === p.y(1);
  return false;
}

export class StrokeBuilder {
  private readonly buffer = new PointBuffer();
  private hasTail = false;
  private readonly cornerList: number[] = [];
  private readonly box: Bounds = emptyBounds();
  private version = 0;

  constructor(
    readonly id: number,
    readonly seq: number,
    readonly style: StrokeStyle,
    private readonly spacing: BuilderSpacing,
  ) {}

  get points(): ReadonlyPoints {
    return this.buffer;
  }

  get corners(): readonly number[] {
    return this.cornerList;
  }

  get length(): number {
    return this.buffer.length;
  }

  /** Points that can no longer change (excludes the live endpoint). */
  get retainedCount(): number {
    return this.buffer.length - (this.hasTail ? 1 : 0);
  }

  /**
   * Number of path segments (numbered from 1, see render/geometry.ts) whose
   * geometry is final: segment i depends on points i-1..i+1 and the corner
   * flag of i, all of which are settled once point i+1 is retained.
   */
  get finalizedSegments(): number {
    return Math.max(0, this.retainedCount - 2);
  }

  get geometryVersion(): number {
    return this.version;
  }

  get bounds(): Bounds {
    return this.box;
  }

  add(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const b = this.buffer;
    if (this.hasTail) {
      b.pop();
      this.hasTail = false;
    }
    const n = b.length;
    if (n === 0) {
      b.push(x, y);
    } else {
      const lx = b.x(n - 1);
      const ly = b.y(n - 1);
      if (Math.hypot(x - lx, y - ly) >= this.spacing.spacing) {
        b.push(x, y);
        if (n >= 2) this.evaluateCorner(n - 1);
      } else {
        b.push(x, y);
        this.hasTail = true;
      }
    }
    extendBounds(this.box, x, y);
    this.version++;
  }

  private evaluateCorner(i: number): void {
    const b = this.buffer;
    const ax = b.x(i) - b.x(i - 1);
    const ay = b.y(i) - b.y(i - 1);
    const bx = b.x(i + 1) - b.x(i);
    const by = b.y(i + 1) - b.y(i);
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const min = this.spacing.cornerMinSegment;
    if (la < min || lb < min || la === 0 || lb === 0) return;
    const cos = (ax * bx + ay * by) / (la * lb);
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (angle >= this.spacing.cornerAngleDeg) this.cornerList.push(i);
  }

  /** Freezes the builder into an immutable stroke. The live endpoint is kept. */
  build(): Stroke {
    const points = this.buffer.freeze();
    // Exact bounds over the final points (the tail may have wandered).
    const bounds = emptyBounds();
    points.forEach((x, y) => extendBounds(bounds, x, y));
    return {
      id: this.id,
      seq: this.seq,
      color: this.style.color,
      width: this.style.width,
      points,
      corners: [...this.cornerList],
      bounds,
      geometryVersion: this.version,
    };
  }
}

/** Builds a committed stroke directly from world coordinates (tests, import). */
export function strokeFromPoints(
  id: number,
  seq: number,
  style: StrokeStyle,
  coords: readonly number[],
  spacing: BuilderSpacing = { spacing: 0, cornerAngleDeg: 60, cornerMinSegment: 2 },
): Stroke {
  const builder = new StrokeBuilder(id, seq, style, spacing);
  for (let i = 0; i + 1 < coords.length; i += 2) builder.add(coords[i]!, coords[i + 1]!);
  return builder.build();
}
