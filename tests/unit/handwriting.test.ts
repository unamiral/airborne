import { afterEach, describe, expect, it, vi } from 'vitest';
import { strokeFromPoints } from '../../src/board/stroke';
import { recognizeHandwriting } from '../../src/ui/handwriting';

const ink = strokeFromPoints(1, 1, { color: '#000', width: 2 }, [1, 2, 3, 4]);
afterEach(() => vi.unstubAllGlobals());

describe('handwriting recognition', () => {
  it('reports unavailable recognition without changing ink', async () => {
    vi.stubGlobal('navigator', {});
    await expect(recognizeHandwriting([ink])).rejects.toThrow('not available');
    expect(ink.points.length).toBe(2);
  });

  it('passes the stroke points to the local recognizer and releases resources', async () => {
    const points: Array<{ x: number; y: number }> = [];
    const added = vi.fn();
    const clear = vi.fn();
    const finish = vi.fn();
    class NativeStroke { addPoint(p: { x: number; y: number }): void { points.push(p); } }
    vi.stubGlobal('HandwritingStroke', NativeStroke);
    vi.stubGlobal('navigator', { createHandwritingRecognizer: () => Promise.resolve({
      startDrawing: () => ({ addStroke: added, getPrediction: () => Promise.resolve([{ text: ' hello ' }]), clear }), finish,
    }) });
    await expect(recognizeHandwriting([ink])).resolves.toBe('hello');
    expect(points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(added).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });
});

