import { describe, expect, it } from 'vitest';
import { enhanceInk } from '../../src/beautify/enhance';
import { DEFAULT_CONFIG } from '../../src/app/config';
import { BoardController } from '../../src/board/controller';
import { strokeFromPoints } from '../../src/board/stroke';
import { boardPoint } from '../../src/core/coords';

const style = { color: '#111', width: 2 };
const make = (id: number, points: number[]) => strokeFromPoints(id, id, style, points);

describe('conservative ink enhancement', () => {
  it('smooths a noisy line, retains endpoints and leaves dots unchanged', () => {
    const line = make(1, [0, 0, 5, 1, 10, -1, 15, 1, 20, 0]);
    const dot = make(2, [25, 1]);
    const edits = enhanceInk([line, dot], 'light', 1);
    expect(edits).toHaveLength(1);
    const p = edits[0]!.coordinates;
    expect(p.slice(0, 2)).toEqual([0, 0]);
    expect(p.slice(-2)).toEqual([20, 0]);
    expect(Math.abs(p[5]!)).toBeLessThan(1);
  });
  it('reduces synthetic high-frequency jitter while limiting displacement', () => {
    const coordinates: number[] = [];
    for (let i = 0; i <= 20; i++) coordinates.push(i * 4, i === 0 || i === 20 ? 0 : (i % 2 ? 1 : -1));
    const stroke = make(1, coordinates);
    const result = enhanceInk([stroke], 'balanced', 1)[0]!.coordinates;
    const before = coordinates.filter((_, i) => i % 2 === 1).reduce((n, y) => n + y * y, 0);
    const after = result.filter((_, i) => i % 2 === 1).reduce((n, y) => n + y * y, 0);
    expect(after).toBeLessThan(before * 0.2);
    for (let i = 0; i < result.length; i += 2) {
      expect(Math.hypot(result[i]! - coordinates[i]!, result[i + 1]! - coordinates[i + 1]!)).toBeLessThanOrEqual(1.8 + 1e-9);
    }
  });
  it('gently aligns plausible groups but leaves an ambiguous layout alone', () => {
    const line = [0, 1, 2, 3].map((i) => make(i + 1, [i * 20, 0, i * 20 + 3, 10 + (i === 0 ? 2 : 0)]));
    const edits = enhanceInk(line, 'balanced', 1);
    expect(edits.some((e) => e.original.id === 1 && e.coordinates[3]! < 12)).toBe(true);
    const diagram = [...line, make(9, [100, -100, 400, 200])];
    expect(enhanceInk(diagram, 'balanced', 1)).toHaveLength(0);
  });
  it('keeps original ink through undo and redoes the same geometry', () => {
    const board = new BoardController(DEFAULT_CONFIG);
    board.beginStroke(boardPoint(0, 0), false);
    for (const [x, y] of [[5, 1], [10, -1], [15, 1], [20, 0]]) board.extendStroke(boardPoint(x!, y!));
    const original = board.commitStroke()!;
    expect(board.beautify('light')).toBe(true);
    const enhanced = board.doc.strokes[0]!;
    expect(enhanced.id).not.toBe(original.id);
    expect(board.undo()).toBe(true);
    expect(board.doc.strokes[0]).toBe(original);
    expect(board.redo()).toBe(true);
    expect(board.doc.strokes[0]).toBe(enhanced);
  });
});
