/**
 * PNG export of the current viewport (plan §10 "Export"): white background,
 * current view transform, committed ink plus a confirmed active stroke. No
 * cursor, prediction, preview, guides, debug data, camera imagery, or
 * controls. Rendered on a dedicated surface at the visible raster size (never
 * sized from world bounds). Changes neither history nor the view.
 */
import type { BoardBackground } from './background';
import type { BoardController } from '../board/controller';
import type { Stroke } from '../board/stroke';
import { renderStrokes } from './full-render';

export interface ExportSurface {
  readonly width: number;
  readonly height: number;
  readonly getContext: (id: '2d') => OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  readonly toPngBlob: () => Promise<Blob | null>;
}

export function createExportSurface(width: number, height: number): ExportSurface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height);
    return {
      width,
      height,
      getContext: () => c.getContext('2d'),
      toPngBlob: () => c.convertToBlob({ type: 'image/png' }).catch(() => null),
    };
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return {
    width,
    height,
    getContext: () => c.getContext('2d'),
    toPngBlob: () => new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png')),
  };
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** Strokes to export: committed ink plus the active stroke once confirmed. */
export function exportStrokes(board: BoardController): Stroke[] {
  const strokes = [...board.doc.strokes];
  const active = board.active;
  if (active !== null && !active.provisional && active.builder.length > 0) {
    const b = active.builder;
    strokes.push({
      id: b.id,
      seq: b.seq,
      color: b.style.color,
      width: b.style.width,
      points: b.points,
      corners: [...b.corners],
      bounds: { ...b.bounds },
      geometryVersion: b.geometryVersion,
    });
  }
  return strokes;
}

export async function renderPng(
  board: BoardController,
  cssWidth: number,
  cssHeight: number,
  rasterScale: number,
  createSurface: (w: number, h: number) => ExportSurface = createExportSurface,
  dark = false,
  background: BoardBackground = 'plain',
): Promise<Blob> {
  const w = Math.max(1, Math.round(cssWidth * rasterScale));
  const h = Math.max(1, Math.round(cssHeight * rasterScale));
  const surface = createSurface(w, h);
  const ctx = surface.getContext('2d');
  if (ctx === null) throw new ExportError('This browser could not create an image surface for export.');
  // Snapshot a consistent board/view version before any await.
  renderStrokes(ctx, exportStrokes(board), board.view, rasterScale, cssWidth, cssHeight, dark, background);
  const blob = await surface.toPngBlob();
  if (blob === null) throw new ExportError('The browser could not encode the PNG image.');
  return blob;
}

export function exportFileName(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `air-whiteboard-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.png`;
}

/** Triggers a download and releases the object URL afterwards. */
export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  doc.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Revoke after the click has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
