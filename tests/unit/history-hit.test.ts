import { describe, expect, it } from 'vitest';
import { BoardDocument } from '../../src/board/document';
import { History } from '../../src/board/history';
import { capsuleHitsStroke, segmentDistanceSq } from '../../src/board/hit-test';
import { strokeFromPoints } from '../../src/board/stroke';

const style = { color: '#000', width: 4 };
const mk = (id: number, coords: number[], width = 4) => strokeFromPoints(id, id, { ...style, width }, coords);

describe('history (F22)', () => {
  it('undoes and redoes add/remove/clear exactly, preserving stroke order', () => {
    const doc = new BoardDocument();
    const h = new History({ maxActions: 100, maxBytes: 1e9 });
    const strokes = [1, 2, 3, 4].map((i) => mk(i, [i, i, i + 10, i]));
    for (const s of strokes) {
      doc.insert([s]);
      h.record({ kind: 'add', strokes: [s] });
    }
    const removed = doc.remove(new Set([2, 3]));
    h.record({ kind: 'remove', strokes: removed });
    expect(doc.strokes.map((s) => s.id)).toEqual([1, 4]);
    h.undo(doc);
    expect(doc.strokes.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(doc.strokes[1]).toBe(strokes[1]); // same immutable object, no copy
    h.redo(doc);
    expect(doc.strokes.map((s) => s.id)).toEqual([1, 4]);
    const cleared = doc.clear();
    h.record({ kind: 'clear', strokes: cleared });
    expect(doc.strokeCount).toBe(0);
    h.undo(doc);
    expect(doc.strokes.map((s) => s.id)).toEqual([1, 4]);
    expect(doc.pointCount).toBe(4);
  });

  it('clears redo after a new edit and handles empty stacks', () => {
    const doc = new BoardDocument();
    const h = new History({ maxActions: 100, maxBytes: 1e9 });
    expect(h.undo(doc)).toBeNull();
    const a = mk(1, [0, 0, 5, 5]);
    doc.insert([a]);
    h.record({ kind: 'add', strokes: [a] });
    h.undo(doc);
    expect(h.canRedo).toBe(true);
    const b = mk(2, [1, 1, 6, 6]);
    doc.insert([b]);
    h.record({ kind: 'add', strokes: [b] });
    expect(h.canRedo).toBe(false);
    expect(h.redo(doc)).toBeNull();
  });

  it('caps actions and payload by evicting the oldest undo entries, never board content', () => {
    const doc = new BoardDocument();
    const h = new History({ maxActions: 3, maxBytes: 1e9 });
    for (let i = 1; i <= 5; i++) {
      const s = mk(i, [i, 0, i + 1, 0]);
      doc.insert([s]);
      h.record({ kind: 'add', strokes: [s] });
    }
    expect(h.undoDepth).toBe(3);
    expect(h.evicted).toBe(2);
    expect(doc.strokeCount).toBe(5);
    const big = new History({ maxActions: 100, maxBytes: 2000 });
    for (let i = 1; i <= 50; i++) big.record({ kind: 'add', strokes: [mk(i, Array.from({ length: 40 }, (_, k) => k))] });
    expect(big.retainedBytes).toBeLessThanOrEqual(2000);
    expect(big.undoDepth).toBeGreaterThan(0);
  });
});

describe('eraser hit testing (F18)', () => {
  it('computes segment distances, including crossings between sparse samples', () => {
    expect(segmentDistanceSq(0, 0, 10, 0, 5, -5, 5, 5)).toBeCloseTo(0, 12); // crossing
    expect(Math.sqrt(segmentDistanceSq(0, 0, 10, 0, 0, 3, 10, 3))).toBeCloseTo(3, 12); // parallel
    expect(Math.sqrt(segmentDistanceSq(0, 0, 0, 0, 3, 4, 3, 4))).toBeCloseTo(5, 12); // points
  });

  it('hits a sparse straight stroke crossed between its samples', () => {
    const s = mk(1, [0, 0, 200, 0]);
    expect(capsuleHitsStroke({ from: { x: 100, y: -50 }, to: { x: 100, y: 50 }, radius: 1 }, s, 0.25)).toBe(true);
  });

  it('includes stroke width: grazing a thick line hits, the same offset on a thin line misses', () => {
    const thick = mk(1, [0, 0, 100, 0], 20);
    const thin = mk(2, [0, 0, 100, 0], 2);
    const c = { from: { x: 50, y: 30 }, to: { x: 60, y: 30 }, radius: 24 };
    expect(capsuleHitsStroke(c, thick, 0.25)).toBe(true); // 30 ≤ 24 + 10
    expect(capsuleHitsStroke(c, thin, 0.25)).toBe(false); // 30 > 24 + 1
  });

  it('hits dots and follows the drawn curve, not just the samples', () => {
    expect(capsuleHitsStroke({ from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, radius: 5 }, mk(1, [3, 4]), 0.25)).toBe(true);
    // Quadratic from (0,0) via (100,0) to (100,50) (midpoint of last pair).
    const curve = strokeFromPoints(2, 2, { color: '#000', width: 2 }, [0, 0, 100, 0, 100, 100], { spacing: 0, cornerAngleDeg: 170, cornerMinSegment: 2 });
    // The corner point (100,0) is NOT on the drawn curve: the curve passes ~17 px inside it.
    expect(capsuleHitsStroke({ from: { x: 100, y: 0 }, to: { x: 100, y: 0 }, radius: 5 }, curve, 0.25)).toBe(false);
    expect(capsuleHitsStroke({ from: { x: 75, y: 12.5 }, to: { x: 75, y: 12.5 }, radius: 3 }, curve, 0.25)).toBe(true);
  });

  it('sweeps the eraser so fast motion cannot tunnel through a stroke', () => {
    const s = mk(1, [100, -100, 100, 100]);
    expect(capsuleHitsStroke({ from: { x: 0, y: 0 }, to: { x: 300, y: 0 }, radius: 2 }, s, 0.25)).toBe(true);
  });
});
