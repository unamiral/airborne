/**
 * Stroke centerline geometry (plan §8.5). One definition is shared by live
 * drawing, cached rendering, export, and eraser hit testing, so committed ink
 * never changes shape and the eraser tests what is drawn.
 *
 * For points p0..p(n-1) (n >= 3), segments are numbered 1..n-1:
 *   S1 = p0, Ei = mid(pi, p(i+1)), S(i+1) = Ei
 *   segment i (1 <= i <= n-2): Si -> Ei, a quadratic with control pi, or two
 *     straight lines Si -> pi -> Ei when pi is a corner (exact vertex)
 *   segment n-1: straight line S(n-1) -> p(n-1), ending at the true endpoint
 * n = 2 is one straight segment; n = 1 is a dot. Quadratics through
 * midpoints stay inside the control triangle, so they cannot overshoot a
 * vertex or invent loops.
 */
import type { ReadonlyPoints } from '../board/points';

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
}

/** x' = x * scale + dx, y' = y * scale + dy (computed in double precision). */
export interface Affine {
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
}

export const IDENTITY_AFFINE: Affine = { scale: 1, dx: 0, dy: 0 };

export function segmentCount(points: ReadonlyPoints): number {
  return Math.max(0, points.length - 1);
}

function isCorner(corners: readonly number[], index: number): boolean {
  // corners is sorted and short; linear scan from the end is typical.
  for (let k = corners.length - 1; k >= 0; k--) {
    const c = corners[k]!;
    if (c === index) return true;
    if (c < index) return false;
  }
  return false;
}

/**
 * Emits segments `from..to` (inclusive, 1-based) as one subpath starting with
 * moveTo at the start of segment `from`.
 */
export function emitSegments(
  points: ReadonlyPoints,
  corners: readonly number[],
  from: number,
  to: number,
  sink: PathSink,
  t: Affine = IDENTITY_AFFINE,
): void {
  const n = points.length;
  const last = n - 1;
  if (n < 2 || from > to || from < 1 || to > last) return;
  const X = (i: number): number => points.x(i) * t.scale + t.dx;
  const Y = (i: number): number => points.y(i) * t.scale + t.dy;
  if (n === 2) {
    sink.moveTo(X(0), Y(0));
    sink.lineTo(X(1), Y(1));
    return;
  }
  // Start of segment `from`.
  if (from === 1) sink.moveTo(X(0), Y(0));
  else sink.moveTo((X(from - 1) + X(from)) / 2, (Y(from - 1) + Y(from)) / 2);
  for (let i = from; i <= to; i++) {
    if (i === last) {
      sink.lineTo(X(last), Y(last));
      break;
    }
    const ex = (X(i) + X(i + 1)) / 2;
    const ey = (Y(i) + Y(i + 1)) / 2;
    if (isCorner(corners, i)) {
      sink.lineTo(X(i), Y(i));
      sink.lineTo(ex, ey);
    } else {
      sink.quadraticCurveTo(X(i), Y(i), ex, ey);
    }
  }
}

/** Emits the whole centerline (not dots; see `isDotGeometry`). */
export function emitStroke(points: ReadonlyPoints, corners: readonly number[], sink: PathSink, t: Affine = IDENTITY_AFFINE): void {
  emitSegments(points, corners, 1, segmentCount(points), sink, t);
}

export function isDotGeometry(points: ReadonlyPoints): boolean {
  return points.length === 1 || (points.length === 2 && points.x(0) === points.x(1) && points.y(0) === points.y(1));
}

/**
 * Visits the centerline as straight pieces whose deviation from the drawn
 * curve is at most `tolerance` (same units as the points). For a quadratic
 * split into k equal parameter steps the error is |P0 - 2P1 + P2| / (4k²).
 */
export function forEachFlatSegment(
  points: ReadonlyPoints,
  corners: readonly number[],
  tolerance: number,
  visit: (ax: number, ay: number, bx: number, by: number) => boolean | void,
): void {
  const n = points.length;
  if (n === 0) return;
  if (n === 1) {
    visit(points.x(0), points.y(0), points.x(0), points.y(0));
    return;
  }
  const sink = new FlattenSink(Math.max(tolerance, 1e-9), visit);
  emitStroke(points, corners, sink);
}

class FlattenSink implements PathSink {
  private x = 0;
  private y = 0;
  private stopped = false;

  constructor(
    private readonly tolerance: number,
    private readonly visit: (ax: number, ay: number, bx: number, by: number) => boolean | void,
  ) {}

  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  lineTo(x: number, y: number): void {
    if (this.stopped) return;
    if (this.visit(this.x, this.y, x, y) === true) this.stopped = true;
    this.x = x;
    this.y = y;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (this.stopped) return;
    const x0 = this.x;
    const y0 = this.y;
    const dd = Math.hypot(x0 - 2 * cx + x, y0 - 2 * cy + y);
    const k = Math.min(64, Math.max(1, Math.ceil(Math.sqrt(dd / (4 * this.tolerance)))));
    for (let s = 1; s <= k; s++) {
      const u = s / k;
      const a = (1 - u) * (1 - u);
      const b = 2 * (1 - u) * u;
      const c = u * u;
      this.lineTo(a * x0 + b * cx + c * x, a * y0 + b * cy + c * y);
      if (this.stopped) return;
    }
  }
}
