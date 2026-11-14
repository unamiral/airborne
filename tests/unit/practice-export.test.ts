import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/app/config';
import { PracticeTracker, strokeLengthPx } from '../../src/app/practice-tracker';
import { BoardController } from '../../src/board/controller';
import { strokeFromPoints } from '../../src/board/stroke';
import { boardPoint } from '../../src/core/coords';
import { ExportError, exportFileName, exportStrokes, renderPng, type ExportSurface } from '../../src/render/export';

const center = () => ({ x: 400, y: 300 });

describe('practice tracker (F26)', () => {
  it('validates the four steps through domain events, in order', () => {
    let now = 1000;
    const t = new PracticeTracker(() => now, center, { scale: 1, tx: 0, ty: 0 });
    expect(t.current).toBe('draw');
    t.strokeCommitted(strokeFromPoints(1, 1, { color: '#000', width: 4 }, [0, 0, 20, 0]), { scale: 1, tx: 0, ty: 0 });
    expect(t.current).toBe('draw'); // 20 px is too short
    t.viewChanged({ scale: 1, tx: 100, ty: 0 }); // panning before drawing does not count
    expect(t.current).toBe('draw');
    t.strokeCommitted(strokeFromPoints(2, 2, { color: '#000', width: 4 }, [0, 0, 30, 0, 30, 30]), { scale: 1, tx: 100, ty: 0 });
    expect(t.current).toBe('pan');
    t.viewChanged({ scale: 1, tx: 130, ty: 0 });
    expect(t.current).toBe('pan');
    t.viewChanged({ scale: 1, tx: 145, ty: 0 });
    expect(t.current).toBe('zoom');
    t.viewChanged({ scale: 1.1, tx: 145, ty: 0 });
    expect(t.current).toBe('zoom');
    t.viewChanged({ scale: 1.2, tx: 145, ty: 0 });
    expect(t.current).toBe('erase');
    now = 19_000;
    t.strokesErased(1, { scale: 1.2, tx: 145, ty: 0 });
    expect(t.complete).toBe(true);
    expect(t.elapsedMs).toBe(18_000);
  });

  it('does not count zooming about the board centre as a pan', () => {
    const t = new PracticeTracker(() => 0, center, { scale: 1, tx: 0, ty: 0 });
    t.strokeCommitted(strokeFromPoints(1, 1, { color: '#000', width: 4 }, [0, 0, 50, 0]), { scale: 1, tx: 0, ty: 0 });
    // Zoom ×1.5 about (400, 300): t = c - (c - t0) * 1.5
    t.viewChanged({ scale: 1.5, tx: 400 - 400 * 1.5, ty: 300 - 300 * 1.5 });
    expect(t.current).toBe('pan');
  });

  it('measures stroke length in CSS px at the view scale', () => {
    const s = strokeFromPoints(1, 1, { color: '#000', width: 4 }, [0, 0, 30, 40]);
    expect(strokeLengthPx(s, 2)).toBeCloseTo(100, 9);
  });
});

class FakeCtx {
  calls: string[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  setTransform(): void {
    this.calls.push('setTransform');
  }
  fillRect(_x: number, _y: number, w: number, h: number): void {
    this.calls.push(`fillRect ${w}x${h} ${this.fillStyle}`);
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  quadraticCurveTo(): void {}
  arc(): void {}
  stroke(): void {
    this.calls.push(`stroke ${this.strokeStyle}`);
  }
  fill(): void {
    this.calls.push(`fill ${this.fillStyle}`);
  }
}

function surfaceFactory(blob: Blob | null) {
  const made: Array<{ w: number; h: number; ctx: FakeCtx }> = [];
  const create = (w: number, h: number): ExportSurface => {
    const ctx = new FakeCtx();
    made.push({ w, h, ctx });
    return { width: w, height: h, getContext: () => ctx as never, toPngBlob: () => Promise.resolve(blob) };
  };
  return { create, made };
}

describe('PNG export (F30)', () => {
  it('renders the visible raster size with a white background and leaves history and view unchanged', async () => {
    const board = new BoardController(DEFAULT_CONFIG);
    board.beginStroke(boardPoint(10, 10), false);
    board.extendStroke(boardPoint(100, 40));
    board.commitStroke();
    board.setView({ scale: 2, tx: -30, ty: 5 });
    const before = { depth: board.history.undoDepth, view: board.view, version: board.doc.version };
    const f = surfaceFactory(new Blob(['png'], { type: 'image/png' }));
    const blob = await renderPng(board, 800, 600, 1.5, f.create);
    expect(blob.type).toBe('image/png');
    expect(f.made[0]).toMatchObject({ w: 1200, h: 900 });
    expect(f.made[0]!.ctx.calls[1]).toBe('fillRect 1200x900 #ffffff');
    expect(f.made[0]!.ctx.calls.some((c) => c.startsWith('stroke'))).toBe(true);
    expect({ depth: board.history.undoDepth, view: board.view, version: board.doc.version }).toEqual(before);
  });

  it('reports a failed encoding instead of downloading nothing', async () => {
    const board = new BoardController(DEFAULT_CONFIG);
    await expect(renderPng(board, 100, 100, 1, surfaceFactory(null).create)).rejects.toBeInstanceOf(ExportError);
  });

  it('includes a confirmed active stroke but never a provisional one', () => {
    const board = new BoardController(DEFAULT_CONFIG);
    board.beginStroke(boardPoint(0, 0), true);
    board.extendStroke(boardPoint(50, 0));
    expect(exportStrokes(board)).toHaveLength(0);
    board.confirmStroke();
    expect(exportStrokes(board)).toHaveLength(1);
  });

  it('names files by local date and time', () => {
    expect(exportFileName(new Date(2026, 10, 14, 9, 5))).toBe('air-whiteboard-20261114-0905.png');
  });
});
