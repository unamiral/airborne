import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, patchConfig, type AppConfig } from '../../src/app/config';
import { BoardController } from '../../src/board/controller';
import { boardPoint } from '../../src/core/coords';
import { runReplay } from '../../src/dev/replay-runner';
import { hover, pinchMove, scenario } from '../support/scenarios';

const bp = boardPoint;

function config(patch: Parameters<typeof patchConfig>[1]): AppConfig {
  const r = patchConfig(DEFAULT_CONFIG, patch);
  if (!r.ok) throw new Error(r.errors.join());
  return r.config;
}

function draw(c: BoardController, pts: Array<[number, number]>, provisional = false): void {
  const [first, ...rest] = pts;
  c.beginStroke(bp(first![0], first![1]), provisional);
  for (const [x, y] of rest) c.extendStroke(bp(x, y));
}

describe('board controller invariants', () => {
  it('never commits a provisional stroke; cancel leaves the document untouched', () => {
    const c = new BoardController(DEFAULT_CONFIG);
    draw(c, [[0, 0], [10, 0]]);
    c.commitStroke();
    const before = c.doc.version;
    draw(c, [[0, 10], [10, 10]], true);
    c.cancelStroke();
    expect(c.doc.version).toBe(before);
    draw(c, [[0, 20], [10, 20]], true);
    expect(c.commitStroke()).toBeNull();
    expect(c.doc.strokeCount).toBe(1);
    expect(c.history.undoDepth).toBe(1);
  });

  it('never stores preview (held-back) points', () => {
    const c = new BoardController(DEFAULT_CONFIG);
    draw(c, [[0, 0], [10, 0], [20, 0]]);
    c.setPreview([bp(25, -5), bp(30, -10)]);
    const stroke = c.commitStroke()!;
    const xs: number[] = [];
    stroke.points.forEach((x) => xs.push(x));
    expect(xs).toEqual([0, 10, 20]);
  });

  it('freezes width at creation scale; zoom scales existing ink; style changes affect only new strokes (F20)', () => {
    const c = new BoardController(DEFAULT_CONFIG);
    c.setWidth(8);
    c.setColor('#d93025');
    draw(c, [[0, 0], [10, 0]]);
    const a = c.commitStroke()!;
    expect(a.width).toBe(8);
    c.zoom(bp(0, 0), 2);
    c.setWidth(4);
    c.setColor('#1a73e8');
    draw(c, [[0, 0], [10, 0]]);
    const b = c.commitStroke()!;
    expect(b.width).toBe(2); // 4 CSS px at scale 2 = 2 world units
    expect(a.width).toBe(8);
    expect(a.color).toBe('#d93025');
    expect(b.color).toBe('#1a73e8');
  });

  it('keeps the eraser hit radius equal to the visible radius at every zoom', () => {
    const c = new BoardController(DEFAULT_CONFIG);
    for (const factor of [0.2, 1, 3.7, 10]) {
      c.setView({ scale: factor, tx: 0, ty: 0 });
      expect(c.eraserRadiusWorld() * c.view.scale).toBeCloseTo(DEFAULT_CONFIG.eraserRadiusPx, 9);
    }
  });

  it('records one erase gesture as one action and restores order on undo', () => {
    const c = new BoardController(DEFAULT_CONFIG);
    for (let i = 0; i < 4; i++) {
      draw(c, [[i * 40, 0], [i * 40, 100]]);
      c.commitStroke();
    }
    c.beginErase(bp(-10, 50));
    c.moveErase(bp(90, 50)); // sweeps through strokes 1..3
    c.moveErase(bp(90, 50));
    expect(c.endErase()).toBe(3);
    expect(c.doc.strokes.map((s) => s.id)).toEqual([4]);
    expect(c.history.undoDepth).toBe(5);
    c.undo();
    expect(c.doc.strokes.map((s) => s.id)).toEqual([1, 2, 3, 4]);
  });

  it('refuses new ink at the hard guard without deleting existing work', () => {
    const c = new BoardController(config({ limits: { normalStrokes: 1, guardStrokes: 2 } }));
    draw(c, [[0, 0], [5, 0]]);
    c.commitStroke();
    draw(c, [[0, 10], [5, 10]]);
    c.commitStroke();
    expect(c.beginStroke(bp(0, 20), false)).toBe(false);
    expect(c.limitReached).toBe(true);
    expect(c.doc.strokeCount).toBe(2);
    c.undo();
    expect(c.limitReached).toBe(false);
    expect(c.beginStroke(bp(0, 20), false)).toBe(true);
  });

  it('closes a huge stroke at the point guard and keeps it as one undoable action', () => {
    const c = new BoardController(config({ limits: { normalPoints: 100, guardPoints: 500 } }));
    c.beginStroke(bp(0, 0), false);
    for (let i = 1; i < 2000; i++) c.extendStroke(bp(i, (i % 7) * 3));
    expect(c.active).toBeNull();
    expect(c.doc.strokeCount).toBe(1);
    expect(c.doc.pointCount).toBeLessThanOrEqual(501);
    expect(c.history.undoDepth).toBe(1);
    expect(c.beginStroke(bp(0, 0), false)).toBe(false);
  });

  it('clears as one reversible action', () => {
    const c = new BoardController(DEFAULT_CONFIG);
    draw(c, [[0, 0], [5, 5]]);
    c.commitStroke();
    expect(c.clear()).toBe(true);
    expect(c.doc.strokeCount).toBe(0);
    c.undo();
    expect(c.doc.strokeCount).toBe(1);
    expect(c.clear()).toBe(true);
    expect(c.clear()).toBe(false); // nothing to clear: no empty history entry
    // add, clear (the first clear was undone and replaced by the second).
    expect(c.history.undoDepth).toBe(2);
  });
});

describe('prediction never reaches the document (F13)', () => {
  it('produces an identical board with the prediction flag off and on', () => {
    const record = scenario('pred', [{ phases: [hover(300, 400, 300), pinchMove(900, 400, 300, 800, 420), hover(300, 800, 420)] }], { strokes: 1 }, { noisePx: 0.4 });
    const off = runReplay(record, { config: config({ prediction: { enabled: false } }) });
    const on = runReplay(record, { config: config({ prediction: { enabled: true } }) });
    const dump = (r: typeof off) => r.controller.doc.strokes.map((s) => {
      const pts: number[] = [];
      s.points.forEach((x, y) => pts.push(x, y));
      return pts;
    });
    expect(dump(on)).toEqual(dump(off));
  });
});
