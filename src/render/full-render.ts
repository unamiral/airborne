/**
 * Synchronous full render of the committed board at a given view, with no
 * cache. Used by PNG export (bounded to the visible raster size) and as the
 * reference that cached rendering is tested against.
 */
import { paintBackground, type BoardBackground } from './background';
import type { Stroke } from '../board/stroke';
import type { View } from '../board/view';
import { boundsIntersect, isEmptyBounds, type Bounds } from '../core/coords';
import { drawStrokeInto } from './renderer';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function renderStrokes(
  ctx: Ctx2D,
  strokes: readonly Stroke[],
  view: View,
  rasterScale: number,
  cssWidth: number,
  cssHeight: number,
  dark = false,
  background: BoardBackground = 'plain',
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  paintBackground(ctx, cssWidth, cssHeight, rasterScale, dark, background === 'camera' ? 'plain' : background);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const viewport: Bounds = {
    minX: -view.tx / view.scale,
    minY: -view.ty / view.scale,
    maxX: (cssWidth - view.tx) / view.scale,
    maxY: (cssHeight - view.ty) / view.scale,
  };
  const affine = { scale: view.scale * rasterScale, dx: view.tx * rasterScale, dy: view.ty * rasterScale };
  for (const s of strokes) {
    if (isEmptyBounds(s.bounds)) continue;
    const h = s.width / 2;
    if (!boundsIntersect({ minX: s.bounds.minX - h, minY: s.bounds.minY - h, maxX: s.bounds.maxX + h, maxY: s.bounds.maxY + h }, viewport)) continue;
    drawStrokeInto(ctx, s, affine, dark);
  }
}
