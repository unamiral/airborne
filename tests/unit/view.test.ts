import { describe, expect, it } from 'vitest';
import { IDENTITY_VIEW, TwoHandTransform, fitView, isValidView, toBoard, toWorld, zoomAt, type View } from '../../src/board/view';
import { boardPoint } from '../../src/core/coords';
import { rng } from '../support/synthetic';

const limits = { minScale: 0.1, maxScale: 10 };

describe('view transforms (F15, F16)', () => {
  it('round-trips board ↔ world', () => {
    const v: View = { scale: 2.5, tx: -40, ty: 13 };
    const w = toWorld(v, boardPoint(100, 50));
    const b = toBoard(v, w);
    expect(b.x).toBeCloseTo(100, 12);
    expect(b.y).toBeCloseTo(50, 12);
  });

  it('zooms about an anchor with clamping applied before translation', () => {
    const anchor = boardPoint(300, 200);
    const before = toWorld(IDENTITY_VIEW, anchor);
    const v = zoomAt(IDENTITY_VIEW, anchor, 100, limits);
    expect(v.scale).toBe(10);
    const after = toWorld(v, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('keeps the two-hand world anchor under the midpoint within 0.01 px', () => {
    const v0: View = { scale: 1.3, tx: 50, ty: -20 };
    const a = boardPoint(400, 300);
    const b = boardPoint(600, 320);
    const t = new TwoHandTransform(v0, a, b, 40, limits);
    const w0 = toWorld(v0, boardPoint(500, 310));
    let v = v0;
    const random = rng(9);
    for (let i = 0; i < 500; i++) {
      const ax = 300 + random() * 200;
      const bx = ax + 50 + random() * 400;
      const ay = 200 + random() * 200;
      const by = 200 + random() * 200;
      v = t.update(boardPoint(ax, ay), boardPoint(bx, by), v);
      expect(isValidView(v)).toBe(true);
      expect(v.scale).toBeGreaterThanOrEqual(0.1);
      expect(v.scale).toBeLessThanOrEqual(10);
      const m = toBoard(v, w0);
      expect(Math.abs(m.x - (ax + bx) / 2)).toBeLessThan(0.01);
      expect(Math.abs(m.y - (ay + by) / 2)).toBeLessThan(0.01);
    }
  });

  it('scales inversely with separation and never rotates', () => {
    const t = new TwoHandTransform(IDENTITY_VIEW, boardPoint(400, 300), boardPoint(600, 300), 40, limits);
    const v = t.update(boardPoint(300, 300), boardPoint(700, 300), IDENTITY_VIEW);
    expect(v.scale).toBeCloseTo(0.5, 12);
    const rotated = t.update(boardPoint(500, 200), boardPoint(500, 400), v);
    expect(rotated.scale).toBeCloseTo(1, 12); // vertical separation 200 = original: no rotation term
  });

  it('freezes scale below the minimum separation and rebases continuously', () => {
    const t = new TwoHandTransform(IDENTITY_VIEW, boardPoint(400, 300), boardPoint(600, 300), 40, limits);
    let v = t.update(boardPoint(450, 300), boardPoint(550, 300), IDENTITY_VIEW);
    expect(v.scale).toBeCloseTo(2, 12);
    const frozen = t.update(boardPoint(490, 300), boardPoint(510, 300), v); // 20 px apart
    expect(frozen.scale).toBe(v.scale);
    v = frozen;
    // Separation becomes usable again: no jump at the rebase sample.
    const rebased = t.update(boardPoint(470, 300), boardPoint(530, 300), v);
    expect(rebased.scale).toBeCloseTo(v.scale, 12);
    expect(rebased.tx).toBeCloseTo(v.tx, 9);
    expect(rebased.ty).toBeCloseTo(v.ty, 9);
    const grown = t.update(boardPoint(440, 300), boardPoint(560, 300), rebased);
    expect(grown.scale).toBeCloseTo(v.scale / 2, 9);
  });

  it('fits content (and resets for an empty board)', () => {
    const v = fitView({ minX: 1000, minY: 1000, maxX: 1400, maxY: 1200 }, 800, 600, 32, limits);
    const tl = toBoard(v, { x: 1000, y: 1000 });
    const br = toBoard(v, { x: 1400, y: 1200 });
    expect(tl.x).toBeGreaterThanOrEqual(31.9);
    expect(br.x).toBeLessThanOrEqual(768.1);
    expect((tl.y + br.y) / 2).toBeCloseTo(300, 9);
    expect(fitView({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, 800, 600, 32, limits)).toEqual(IDENTITY_VIEW);
  });
});
