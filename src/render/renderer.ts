/**
 * Canvas 2D board renderer (plan §10 "Canonical board and renderer").
 *
 * Layers (all calculated against `rasterBudgetBytes`):
 *  - visible: opaque board canvas (requested desynchronized, alpha:false)
 *  - front cache: committed strokes at `frontView` plus finalized segments of
 *    the active stroke, appended incrementally (never a full-stroke redraw)
 *  - back cache: target of chunked rebuilds; swapped in only when complete
 *    and only if the document did not change meanwhile
 *
 * Each frame composes: white fill, front cache (transformed when the view
 * moved since it was rendered), the active stroke's unfinalized tail, the
 * held-back preview and optional prediction, then cursors. Frames are
 * scheduled only while something is dirty, animating, or rebuilding.
 */
import type { RenderConfig } from '../app/config';
import type { MetricsSink } from '../app/metrics';
import type { BoardController } from '../board/controller';
import type { Stroke } from '../board/stroke';
import { isValidView, type View } from '../board/view';
import { boundsIntersect, emptyBounds, isEmptyBounds, unionBounds, type Bounds } from '../core/coords';
import { emitSegments, isDotGeometry, segmentCount, type Affine } from './geometry';

export type CursorMode = 'hover' | 'pinch' | 'draw' | 'blocked' | 'erase-arming' | 'erase' | 'move' | 'lost';

export interface CursorView {
  readonly id: number;
  /** Board-local CSS px. */
  readonly x: number;
  readonly y: number;
  readonly color: string;
  /** Pen diameter in CSS px. */
  readonly diameter: number;
  readonly mode: CursorMode;
  /** 0..1 for erase arming. */
  readonly progress: number;
  /** Eraser radius in CSS px. */
  readonly eraserRadius: number;
}

export interface Overlay {
  readonly cursors: readonly CursorView[];
  /** Predicted tip offset in board CSS px (visual only), or null. */
  readonly prediction: { readonly dx: number; readonly dy: number } | null;
}

type Surface2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

interface Layer {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly ctx: Surface2D;
}

interface Job {
  readonly view: View;
  readonly docVersion: number;
  readonly strokes: readonly Stroke[];
  index: number;
  readonly started: number;
}

export interface RendererStats {
  readonly rasterScale: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly cacheBytes: number;
  readonly rebuilding: boolean;
  readonly framesDrawn: number;
  readonly fullRebuilds: number;
  readonly regionRebuilds: number;
  readonly desynchronized: boolean | null;
}

/** Strokes intersecting a region with more points than this rebuild in chunks. */
const REGION_POINT_LIMIT = 40_000;

function createLayer(width: number, height: number): Layer {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('Canvas 2D is not available for the board cache.');
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('Canvas 2D is not available for the board cache.');
  return { canvas, ctx };
}

function sameView(a: View, b: View): boolean {
  return a.scale === b.scale && a.tx === b.tx && a.ty === b.ty;
}

function inflate(b: Bounds, by: number): Bounds {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

export function drawStrokeInto(ctx: Surface2D, stroke: Pick<Stroke, 'points' | 'corners' | 'color' | 'width'>, affine: Affine): void {
  const p = stroke.points;
  if (p.length === 0) return;
  const w = stroke.width * affine.scale;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  if (isDotGeometry(p)) {
    ctx.beginPath();
    ctx.arc(p.x(0) * affine.scale + affine.dx, p.y(0) * affine.scale + affine.dy, w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = w;
  ctx.beginPath();
  emitSegments(p, stroke.corners, 1, segmentCount(p), ctx, affine);
  ctx.stroke();
}

export class BoardRenderer {
  private readonly visible: CanvasRenderingContext2D;
  private front: Layer | null = null;
  private back: Layer | null = null;
  private frontView: View | null = null;
  /** Strokes currently rendered in the front cache, by id. */
  private frontStrokes = new Map<number, Stroke>();
  private frontDocVersion = -1;
  /** Active stroke segments already appended into the front cache, and their bounds. */
  private activeDrawn: { id: number; segments: number; bounds: Bounds; width: number } | null = null;
  private job: Job | null = null;
  private overlay: Overlay = { cursors: [], prediction: null };
  private cssWidth = 0;
  private cssHeight = 0;
  private rs = 1;
  private scheduled = false;
  private dirty = true;
  private board: BoardController | null = null;
  private framesDrawn = 0;
  private fullRebuilds = 0;
  private regionRebuilds = 0;
  private readonly desync: boolean | null;
  /** Called after each composed frame with its main-thread duration. */
  onFrame: ((durationMs: number) => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private config: RenderConfig,
    private readonly metrics: MetricsSink,
    private readonly raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  ) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (ctx === null) throw new Error('Canvas 2D is not available in this browser.');
    this.visible = ctx;
    const attrs = typeof ctx.getContextAttributes === 'function' ? ctx.getContextAttributes() : null;
    this.desync = attrs?.desynchronized ?? null;
    // Graphics-context loss: the vector document is canonical, so a restored
    // context simply gets fresh caches and a full redraw.
    canvas.addEventListener('contextrestored', () => this.resetCache());
  }

  get stats(): RendererStats {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const layers = 1 + (this.front !== null ? 1 : 0) + (this.back !== null ? 1 : 0);
    return {
      rasterScale: this.rs,
      cssWidth: this.cssWidth,
      cssHeight: this.cssHeight,
      backingWidth: w,
      backingHeight: h,
      cacheBytes: w * h * 4 * layers,
      rebuilding: this.job !== null,
      framesDrawn: this.framesDrawn,
      fullRebuilds: this.fullRebuilds,
      regionRebuilds: this.regionRebuilds,
      desynchronized: this.desync,
    };
  }

  attach(board: BoardController): void {
    this.board = board;
    board.onChange((kind) => {
      if (kind === 'doc' || kind === 'view' || kind === 'active') this.invalidate();
    });
    this.resetCache();
  }

  /** Uses a different board (e.g. the practice board) with a fresh cache. */
  setBoard(board: BoardController): void {
    this.attach(board);
  }

  setOverlay(overlay: Overlay): void {
    this.overlay = overlay;
    this.invalidate();
  }

  /** Backing-store scale: device pixels, capped and fitted to the memory budget (3 layers). */
  static rasterScaleFor(cssWidth: number, cssHeight: number, dpr: number, config: RenderConfig): number {
    const area = Math.max(1, cssWidth * cssHeight);
    const budgetScale = Math.sqrt(config.rasterBudgetBytes / (3 * 4 * area));
    return Math.max(0.25, Math.min(dpr, config.maxRasterScale, budgetScale));
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const rs = BoardRenderer.rasterScaleFor(cssWidth, cssHeight, dpr, this.config);
    const w = Math.max(1, Math.round(cssWidth * rs));
    const h = Math.max(1, Math.round(cssHeight * rs));
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    if (w === this.canvas.width && h === this.canvas.height && rs === this.rs) return;
    this.rs = rs;
    this.canvas.width = w;
    this.canvas.height = h;
    this.resetCache();
  }

  private resetCache(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.front = createLayer(w, h);
    this.back = createLayer(w, h);
    this.frontView = null;
    this.frontStrokes = new Map();
    this.frontDocVersion = -1;
    this.activeDrawn = null;
    this.job = null;
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.raf(() => {
      this.scheduled = false;
      this.frame();
    });
  }

  private affineFor(view: View): Affine {
    return { scale: view.scale * this.rs, dx: view.tx * this.rs, dy: view.ty * this.rs };
  }

  private worldViewport(view: View): Bounds {
    return {
      minX: -view.tx / view.scale,
      minY: -view.ty / view.scale,
      maxX: (this.cssWidth - view.tx) / view.scale,
      maxY: (this.cssHeight - view.ty) / view.scale,
    };
  }

  private visibleStroke(stroke: Stroke, viewport: Bounds): boolean {
    return !isEmptyBounds(stroke.bounds) && boundsIntersect(inflate(stroke.bounds, stroke.width / 2 + 1e-6), viewport);
  }

  /** Composes one frame. Public for tests and benchmarks. */
  frame(): void {
    const board = this.board;
    const front = this.front;
    if (board === null || front === null || (!this.dirty && this.job === null)) return;
    const start = performance.now();
    this.dirty = false;
    const view = board.view;
    if (!isValidView(view)) return;

    if (this.frontView === null) this.startJob(view, board);
    else this.syncDocument(board);
    if (this.job === null && this.frontView !== null && !sameView(this.frontView, view)) {
      // The view moved: show the transformed snapshot now and render crisp
      // vectors for the current view in chunks. During a continuous gesture a
      // job is allowed to finish at its (slightly old) view and is shown
      // transformed, so newly exposed areas fill in progressively instead of
      // waiting for the gesture to end.
      this.startJob(view, board);
    }
    this.appendActive(board);
    this.runJob(board);
    this.compose(board, view);

    const duration = performance.now() - start;
    this.framesDrawn++;
    this.metrics.sample('renderMs', duration);
    this.onFrame?.(duration);
    if (this.job !== null) this.schedule();
  }

  /** Brings the front cache up to date with document changes. */
  private syncDocument(board: BoardController): void {
    const doc = board.doc;
    if (doc.version === this.frontDocVersion || this.frontView === null) return;
    if (this.job !== null && this.job.docVersion !== doc.version) this.job = null;
    const docIds = new Set<number>();
    const added: Stroke[] = [];
    let maxFrontSeq = 0;
    for (const s of doc.strokes) {
      docIds.add(s.id);
      if (this.frontStrokes.has(s.id)) maxFrontSeq = Math.max(maxFrontSeq, s.seq);
      else added.push(s);
    }
    const removed = [...this.frontStrokes.values()].filter((s) => !docIds.has(s.id));
    this.frontDocVersion = doc.version;
    if (added.length === 0 && removed.length === 0) return;

    // Fast path: the stroke just committed was already drawn incrementally.
    const drawn = this.activeDrawn;
    if (removed.length === 0 && added.length === 1 && drawn !== null && added[0]!.id === drawn.id) {
      const stroke = added[0]!;
      this.drawRemainder(stroke, drawn.segments);
      this.frontStrokes.set(stroke.id, stroke);
      this.activeDrawn = null;
      return;
    }
    // Newer strokes on top (e.g. redo of the last stroke) append without a rebuild.
    if (removed.length === 0 && drawn === null && added.every((s) => s.seq > maxFrontSeq)) {
      const affine = this.affineFor(this.frontView);
      for (const s of added) {
        drawStrokeInto(this.front!.ctx, s, affine);
        this.frontStrokes.set(s.id, s);
      }
      return;
    }
    // Otherwise repaint the union of changed strokes' bounds.
    let region = emptyBounds();
    for (const s of [...added, ...removed]) region = unionBounds(region, inflate(s.bounds, s.width / 2 + 1));
    this.regionRebuild(board, region);
  }

  private regionRebuild(board: BoardController, region: Bounds): void {
    const front = this.front!;
    const view = this.frontView!;
    const strokes = board.doc.strokes;
    if (isEmptyBounds(region)) {
      this.startJob(board.view, board);
      return;
    }
    let points = 0;
    const hits: Stroke[] = [];
    for (const s of strokes) {
      if (!isEmptyBounds(s.bounds) && boundsIntersect(inflate(s.bounds, s.width / 2 + 1), region)) {
        hits.push(s);
        points += s.points.length;
      }
    }
    if (points > REGION_POINT_LIMIT) {
      this.startJob(board.view, board);
      return;
    }
    const affine = this.affineFor(view);
    const x0 = Math.floor(region.minX * affine.scale + affine.dx) - 2;
    const y0 = Math.floor(region.minY * affine.scale + affine.dy) - 2;
    const x1 = Math.ceil(region.maxX * affine.scale + affine.dx) + 2;
    const y1 = Math.ceil(region.maxY * affine.scale + affine.dy) + 2;
    const ctx = front.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of hits) drawStrokeInto(ctx, s, affine);
    const active = board.active;
    if (active !== null && this.activeDrawn?.id === active.builder.id && this.activeDrawn.segments > 0) {
      this.drawActiveSegments(ctx, board, 1, this.activeDrawn.segments, affine);
    }
    ctx.restore();
    this.frontStrokes = new Map(strokes.map((s) => [s.id, s]));
    this.regionRebuilds++;
  }

  private startJob(view: View, board: BoardController): void {
    this.job = { view, docVersion: board.doc.version, strokes: board.doc.strokes.slice(), index: 0, started: performance.now() };
    const back = this.back!;
    back.ctx.setTransform(1, 0, 0, 1, 0, 0);
    back.ctx.fillStyle = '#ffffff';
    back.ctx.fillRect(0, 0, back.canvas.width, back.canvas.height);
    back.ctx.lineCap = 'round';
    back.ctx.lineJoin = 'round';
  }

  private runJob(board: BoardController): void {
    const job = this.job;
    if (job === null) return;
    if (job.docVersion !== board.doc.version) {
      // Never swap a stale cache into a newer document.
      this.startJob(board.view, board);
      return;
    }
    const back = this.back!;
    const affine = this.affineFor(job.view);
    const viewport = this.worldViewport(job.view);
    // The check runs after each stroke, so stop at 85% of the budget to keep
    // the chunk (including the last stroke drawn) within rebuildChunkMs.
    const budget = this.config.rebuildChunkMs * 0.85;
    const chunkStart = performance.now();
    while (job.index < job.strokes.length) {
      const s = job.strokes[job.index++]!;
      if (this.visibleStroke(s, viewport)) drawStrokeInto(back.ctx, s, affine);
      if (performance.now() - chunkStart > budget) break;
    }
    this.metrics.sample('rebuildChunkMs', performance.now() - chunkStart);
    if (job.index < job.strokes.length) return;
    // Complete: include the active stroke's finalized part, then swap.
    const active = board.active;
    let drawnSegments = 0;
    if (active !== null) {
      drawnSegments = active.builder.finalizedSegments;
      if (drawnSegments > 0) this.drawActiveSegments(back.ctx, board, 1, drawnSegments, affine);
    }
    const old = this.front!;
    this.front = back;
    this.back = old;
    this.frontView = job.view;
    this.frontStrokes = new Map(job.strokes.map((s) => [s.id, s]));
    this.frontDocVersion = job.docVersion;
    this.activeDrawn =
      active !== null
        ? { id: active.builder.id, segments: drawnSegments, bounds: { ...active.builder.bounds }, width: active.builder.style.width }
        : null;
    this.job = null;
    this.fullRebuilds++;
    this.dirty = true;
  }

  private drawActiveSegments(ctx: Surface2D, board: BoardController, from: number, to: number, affine: Affine): void {
    const active = board.active;
    if (active === null || to < from) return;
    const b = active.builder;
    ctx.strokeStyle = b.style.color;
    ctx.lineWidth = b.style.width * affine.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    emitSegments(b.points, b.corners, from, to, ctx, affine);
    ctx.stroke();
  }

  /** Appends newly finalized active segments to the front cache. */
  private appendActive(board: BoardController): void {
    const active = board.active;
    const front = this.front;
    if (front === null || this.frontView === null) return;
    const drawn = this.activeDrawn;
    if (active === null || (drawn !== null && drawn.id !== active.builder.id)) {
      // A cancelled stroke may have left segments in the cache: repaint its area.
      if (drawn !== null && drawn.segments > 0 && !board.doc.has(drawn.id)) {
        this.activeDrawn = null;
        this.regionRebuild(board, inflate(drawn.bounds, drawn.width / 2 + 2));
      } else {
        this.activeDrawn = null;
      }
      if (active === null) return;
    }
    const b = active.builder;
    const current = this.activeDrawn ?? { id: b.id, segments: 0, bounds: { ...b.bounds }, width: b.style.width };
    const finalized = b.finalizedSegments;
    if (finalized > current.segments) {
      this.drawActiveSegments(front.ctx, board, current.segments + 1, finalized, this.affineFor(this.frontView));
      this.activeDrawn = { id: b.id, segments: finalized, bounds: { ...b.bounds }, width: b.style.width };
    } else {
      this.activeDrawn = current;
    }
  }

  /** Draws the not-yet-cached end of a just-committed stroke into the front cache. */
  private drawRemainder(stroke: Stroke, drawnSegments: number): void {
    const front = this.front!;
    const affine = this.affineFor(this.frontView!);
    if (drawnSegments === 0) {
      drawStrokeInto(front.ctx, stroke, affine);
      return;
    }
    const total = segmentCount(stroke.points);
    if (total <= drawnSegments) return;
    front.ctx.strokeStyle = stroke.color;
    front.ctx.lineWidth = stroke.width * affine.scale;
    front.ctx.lineCap = 'round';
    front.ctx.lineJoin = 'round';
    front.ctx.beginPath();
    emitSegments(stroke.points, stroke.corners, drawnSegments + 1, total, front.ctx, affine);
    front.ctx.stroke();
  }

  private compose(board: BoardController, view: View): void {
    const ctx = this.visible;
    const rs = this.rs;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const front = this.front;
    const fv = this.frontView;
    if (front !== null && fv !== null) {
      if (sameView(fv, view)) {
        ctx.drawImage(front.canvas, 0, 0);
      } else if (fv.scale === view.scale) {
        // Pure pan: blit at a whole-pixel offset instead of resampling the
        // whole cache (sub-pixel jitter ≤ 0.5 device px while moving).
        ctx.drawImage(front.canvas, Math.round((view.tx - fv.tx) * rs), Math.round((view.ty - fv.ty) * rs));
      } else {
        const k = view.scale / fv.scale;
        ctx.setTransform(k, 0, 0, k, (view.tx - fv.tx * k) * rs, (view.ty - fv.ty * k) * rs);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(front.canvas, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    const affine = this.affineFor(view);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const active = board.active;
    if (active !== null) {
      const b = active.builder;
      const fromSeg = (this.activeDrawn?.id === b.id ? this.activeDrawn.segments : 0) + 1;
      const total = segmentCount(b.points);
      if (b.points.length === 1 || isDotGeometry(b.points)) {
        drawStrokeInto(ctx, { points: b.points, corners: b.corners, color: b.style.color, width: b.style.width }, affine);
      } else if (fromSeg <= total) {
        ctx.strokeStyle = b.style.color;
        ctx.lineWidth = b.style.width * affine.scale;
        ctx.beginPath();
        emitSegments(b.points, b.corners, fromSeg, total, ctx, affine);
        ctx.stroke();
      }
      const n = b.points.length;
      const endX = b.points.x(n - 1) * affine.scale + affine.dx;
      const endY = b.points.y(n - 1) * affine.scale + affine.dy;
      if (active.preview.length > 0 || this.overlay.prediction !== null) {
        ctx.strokeStyle = b.style.color;
        ctx.lineWidth = b.style.width * affine.scale;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        for (const p of active.preview) ctx.lineTo(p.x * affine.scale + affine.dx, p.y * affine.scale + affine.dy);
        const pred = this.overlay.prediction;
        if (pred !== null && active.preview.length === 0) ctx.lineTo(endX + pred.dx * rs, endY + pred.dy * rs);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    for (const c of this.overlay.cursors) this.drawCursor(ctx, c);
  }

  private drawCursor(ctx: CanvasRenderingContext2D, c: CursorView): void {
    const rs = this.rs;
    const x = c.x * rs;
    const y = c.y * rs;
    const r = Math.max(c.diameter / 2, 1) * rs;
    ctx.save();
    ctx.lineWidth = 2 * rs;
    switch (c.mode) {
      case 'hover':
      case 'blocked':
      case 'lost': {
        const ring = Math.max(r + 4 * rs, 7 * rs);
        ctx.setLineDash(c.mode === 'hover' ? [] : [4 * rs, 3 * rs]);
        this.outlinedCircle(ctx, x, y, ring, c.mode === 'hover' ? c.color : '#6b7280');
        ctx.setLineDash([]);
        if (c.mode === 'hover') this.fillCircle(ctx, x, y, r, c.color);
        break;
      }
      case 'pinch':
      case 'draw':
        this.fillCircle(ctx, x, y, Math.max(r, 2 * rs), c.color);
        this.outlinedCircle(ctx, x, y, Math.max(r + 3 * rs, 5 * rs), c.color);
        break;
      case 'erase-arming':
      case 'erase': {
        const er = c.eraserRadius * rs;
        ctx.setLineDash(c.mode === 'erase' ? [] : [5 * rs, 4 * rs]);
        this.outlinedCircle(ctx, x, y, er, '#b3261e');
        ctx.setLineDash([]);
        if (c.mode === 'erase-arming') {
          ctx.strokeStyle = '#b3261e';
          ctx.lineWidth = 4 * rs;
          ctx.beginPath();
          ctx.arc(x, y, er + 5 * rs, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, c.progress));
          ctx.stroke();
        }
        break;
      }
      case 'move':
        this.outlinedCircle(ctx, x, y, 9 * rs, '#0b57d0');
        this.fillCircle(ctx, x, y, 3 * rs, '#0b57d0');
        break;
    }
    ctx.restore();
  }

  private fillCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** Circle in `color` with a white and dark outline so it reads on any ink. */
  private outlinedCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    const rs = this.rs;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5 * rs;
    ctx.stroke();
    ctx.strokeStyle = '#1b1f24';
    ctx.lineWidth = 3.5 * rs;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * rs;
    ctx.stroke();
  }
}
