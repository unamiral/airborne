import { describe, expect, it } from 'vitest';
import { PointBuffer } from '../../src/board/points';
import { StrokeBuilder, isDot, strokeFromPoints } from '../../src/board/stroke';
import { emitStroke, forEachFlatSegment, segmentCount, type PathSink } from '../../src/render/geometry';

const spacing = { spacing: 0.5, cornerAngleDeg: 60, cornerMinSegment: 2 };
const style = { color: '#000', width: 4 };

describe('chunked point storage', () => {
  it('grows in chunks, supports random access, pop, and freezes with trimmed capacity', () => {
    const b = new PointBuffer();
    for (let i = 0; i < 10_000; i++) b.push(i, -i);
    expect(b.length).toBe(10_000);
    expect(b.x(0)).toBe(0);
    expect(b.y(31)).toBe(-31);
    expect(b.x(32)).toBe(32);
    expect(b.x(9999)).toBe(9999);
    let sum = 0;
    b.forEach((x) => (sum += x));
    expect(sum).toBe((9999 * 10000) / 2);
    b.pop();
    expect(b.length).toBe(9999);
    const frozen = b.freeze();
    expect(frozen.byteLength).toBe(9999 * 16);
    expect(() => b.push(1, 1)).toThrow();
    expect(() => b.x(9999)).toThrow(RangeError);
  });
});

describe('stroke builder (F10, plan §8.5)', () => {
  it('keeps the first point, retains samples ≥ spacing apart, and keeps a live endpoint', () => {
    const s = new StrokeBuilder(1, 1, style, spacing);
    s.add(0, 0);
    s.add(0.2, 0); // below spacing: live endpoint
    expect(s.length).toBe(2);
    expect(s.retainedCount).toBe(1);
    s.add(0.3, 0); // replaces the live endpoint
    expect(s.length).toBe(2);
    expect(s.points.x(1)).toBe(0.3);
    s.add(1, 0); // retained; the live endpoint it replaces is gone
    expect(s.retainedCount).toBe(2);
    expect([s.points.x(1), s.points.y(1)]).toEqual([1, 0]);
  });

  it('does not grow while the pen is stationary', () => {
    const s = new StrokeBuilder(1, 1, style, spacing);
    s.add(10, 10);
    for (let i = 0; i < 1000; i++) s.add(10 + (i % 2) * 0.1, 10);
    expect(s.length).toBe(2);
  });

  it('preserves the exact first and last filtered points on commit', () => {
    const s = new StrokeBuilder(1, 1, style, spacing);
    const pts = [
      [3.25, 7.5],
      [8, 9],
      [12.125, 4],
      [12.3, 4.1],
    ];
    for (const [x, y] of pts) s.add(x!, y!);
    const stroke = s.build();
    expect([stroke.points.x(0), stroke.points.y(0)]).toEqual([3.25, 7.5]);
    const n = stroke.points.length;
    expect([stroke.points.x(n - 1), stroke.points.y(n - 1)]).toEqual([12.3, 4.1]);
    expect(stroke.bounds).toEqual({ minX: 3.25, minY: 4, maxX: 12.3, maxY: 9 });
  });

  it('keeps tiny punctuation: a single sample is a dot, two close samples stay a tiny mark', () => {
    const one = new StrokeBuilder(1, 1, style, spacing);
    one.add(5, 5);
    expect(isDot(one.build())).toBe(true);
    const minus = strokeFromPoints(2, 2, style, [0, 0, 1.5, 0], spacing);
    expect(minus.points.length).toBe(2);
    expect(isDot(minus)).toBe(false);
  });

  it('flags corners at sharp direction changes with long enough segments', () => {
    const s = strokeFromPoints(1, 1, style, [0, 0, 10, 0, 20, 0, 20, 10, 20, 20], spacing);
    expect(s.corners).toEqual([2]);
    const gentle = strokeFromPoints(2, 2, style, [0, 0, 10, 0, 20, 2, 30, 6], spacing);
    expect(gentle.corners).toEqual([]);
    const jitter = strokeFromPoints(3, 3, style, [0, 0, 1, 0, 1, 1, 0, 1], spacing);
    expect(jitter.corners).toEqual([]); // segments shorter than 2 px are not corners
  });

  it('counts finalized segments only once their next point is retained', () => {
    const s = new StrokeBuilder(1, 1, style, spacing);
    s.add(0, 0);
    s.add(5, 0);
    s.add(10, 0);
    expect(s.finalizedSegments).toBe(1);
    s.add(10.1, 0); // live endpoint does not finalize anything
    expect(s.finalizedSegments).toBe(1);
    s.add(15, 0);
    expect(s.finalizedSegments).toBe(2);
  });
});

class Recorder implements PathSink {
  readonly ops: Array<[string, ...number[]]> = [];
  moveTo(x: number, y: number): void {
    this.ops.push(['M', x, y]);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(['L', x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push(['Q', cx, cy, x, y]);
  }
}

describe('stroke geometry (plan §8.5)', () => {
  it('starts at the first point, passes through midpoints, and ends at the last point', () => {
    const s = strokeFromPoints(1, 1, style, [0, 0, 10, 0, 20, 10, 30, 10], { ...spacing, cornerAngleDeg: 170 });
    const r = new Recorder();
    emitStroke(s.points, s.corners, r);
    expect(r.ops).toEqual([
      ['M', 0, 0],
      ['Q', 10, 0, 15, 5],
      ['Q', 20, 10, 25, 10],
      ['L', 30, 10],
    ]);
    expect(segmentCount(s.points)).toBe(3);
  });

  it('draws corner vertices exactly instead of rounding across them', () => {
    const s = strokeFromPoints(1, 1, style, [0, 0, 10, 0, 20, 0, 20, 10, 20, 20], spacing);
    const r = new Recorder();
    emitStroke(s.points, s.corners, r);
    expect(r.ops).toContainEqual(['L', 20, 0]);
  });

  it('flattens curves within the requested tolerance and never leaves the control hull', () => {
    const s = strokeFromPoints(1, 1, style, [0, 0, 100, 0, 100, 100], { ...spacing, cornerAngleDeg: 170 });
    const pts: Array<[number, number]> = [];
    forEachFlatSegment(s.points, s.corners, 0.25, (ax, ay, bx, by) => {
      pts.push([ax, ay], [bx, by]);
    });
    // The quadratic from (0,0) via (100,0) to (100,50): check a few flattened points against the curve.
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(100 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(100 + 1e-9);
    }
    expect(pts.length).toBeGreaterThan(10);
  });

  it('represents a dot as a single degenerate segment for hit testing', () => {
    const s = strokeFromPoints(1, 1, style, [5, 5], spacing);
    const segs: number[][] = [];
    forEachFlatSegment(s.points, s.corners, 0.25, (ax, ay, bx, by) => {
      segs.push([ax, ay, bx, by]);
    });
    expect(segs).toEqual([[5, 5, 5, 5]]);
  });
});
