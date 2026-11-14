/**
 * Board controller: the only writer of the document, history, and view.
 * Hand intents (via the reducer) and pointer/keyboard commands both arrive
 * here in board-local CSS pixels and share the same geometry and history.
 *
 * Invariants (tests/integration/controller.test.ts):
 * - Hover, pause, and eraser arming never mutate the document.
 * - A provisional stroke enters the document only when committed after
 *   confirmation; cancelling leaves committed content untouched.
 * - Predicted or preview points never enter a stroke.
 * - One stroke, one erase gesture, or one clear is one history entry.
 * - Views stay finite with clamped scale.
 */
import { enhanceInk, type Enhancement } from '../beautify/enhance';
import type { AppConfig } from '../app/config';
import { type BoardPoint } from '../core/coords';
import { BoardDocument } from './document';
import { History } from './history';
import { strokesHitByCapsule } from './hit-test';
import { StrokeBuilder, strokeFromPoints, type Stroke } from './stroke';
import { IDENTITY_VIEW, TwoHandTransform, fitView, isValidView, panBy, toWorld, zoomAt, type View } from './view';

export type Tool = 'pen' | 'eraser' | 'move';

export type ChangeKind = 'doc' | 'view' | 'active' | 'history' | 'style' | 'limit';

export interface ActiveStroke {
  readonly builder: StrokeBuilder;
  provisional: boolean;
  /** Held-back samples (world), drawn as a disposable preview only. */
  preview: readonly { x: number; y: number }[];
  readonly startScale: number;
}

export interface EraseGesture {
  last: { x: number; y: number };
  readonly removed: Stroke[];
  readonly removedIds: Set<number>;
}

export interface BoardStats {
  readonly strokes: number;
  readonly points: number;
  readonly activePoints: number;
  readonly undoDepth: number;
  readonly undoBytes: number;
}

export class BoardController {
  readonly doc = new BoardDocument();
  readonly history: History;
  private viewValue: View = IDENTITY_VIEW;
  private activeValue: ActiveStroke | null = null;
  private transform: TwoHandTransform | null = null;
  private erase: EraseGesture | null = null;
  private nextId = 1;
  private nextSeq = 1;
  private listeners: Array<(kind: ChangeKind) => void> = [];
  color = '#1b1f24';
  /** Brush diameter in CSS px at stroke start. */
  widthPx = 4;
  tool: Tool = 'pen';
  /** Set when the hard guard refused new ink; cleared when space is freed. */
  limitReached = false;
  viewVersion = 0;
  activeVersion = 0;

  constructor(private config: AppConfig) {
    this.history = new History({ maxActions: config.limits.undoActions, maxBytes: config.limits.undoBytes });
  }

  setConfig(config: AppConfig): void {
    this.config = config;
    this.history.setLimits({ maxActions: config.limits.undoActions, maxBytes: config.limits.undoBytes });
  }

  onChange(listener: (kind: ChangeKind) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(kind: ChangeKind): void {
    if (kind === 'view') this.viewVersion++;
    if (kind === 'active') this.activeVersion++;
    for (const l of this.listeners) l(kind);
  }

  get view(): View {
    return this.viewValue;
  }

  get active(): ActiveStroke | null {
    return this.activeValue;
  }

  get erasing(): boolean {
    return this.erase !== null;
  }

  get transforming(): boolean {
    return this.transform !== null;
  }

  get stats(): BoardStats {
    return {
      strokes: this.doc.strokeCount,
      points: this.doc.pointCount,
      activePoints: this.activeValue?.builder.length ?? 0,
      undoDepth: this.history.undoDepth,
      undoBytes: this.history.retainedBytes,
    };
  }

  private atGuard(extraPoints = 0): boolean {
    const l = this.config.limits;
    return this.doc.pointCount + extraPoints >= l.guardPoints || this.doc.strokeCount >= l.guardStrokes;
  }

  private refreshLimit(): void {
    const reached = this.atGuard();
    if (reached !== this.limitReached) {
      this.limitReached = reached;
      this.emit('limit');
    }
  }

  // --- Strokes -------------------------------------------------------------

  /** Starts a stroke at `at`. Returns false when the board guard refuses new ink. */
  beginStroke(at: BoardPoint, provisional: boolean): boolean {
    if (this.activeValue !== null) this.commitStroke();
    if (this.atGuard()) {
      this.limitReached = true;
      this.emit('limit');
      return false;
    }
    const scale = this.viewValue.scale;
    const s = this.config.stroke;
    const builder = new StrokeBuilder(
      this.nextId++,
      this.nextSeq++,
      { color: this.color, width: this.widthPx / scale },
      { spacing: s.minSpacingPx / scale, cornerAngleDeg: s.cornerAngleDeg, cornerMinSegment: s.cornerMinSegmentPx / scale },
    );
    const w = toWorld(this.viewValue, at);
    builder.add(w.x, w.y);
    this.activeValue = { builder, provisional, preview: [], startScale: scale };
    this.emit('active');
    return true;
  }

  extendStroke(at: BoardPoint): void {
    const active = this.activeValue;
    if (active === null) return;
    if (this.atGuard(active.builder.length)) {
      // Preserve work: close the stroke at the guard instead of growing it.
      if (!active.provisional) this.commitStroke();
      return;
    }
    const w = toWorld(this.viewValue, at);
    active.builder.add(w.x, w.y);
    this.emit('active');
  }

  setPreview(points: readonly BoardPoint[]): void {
    const active = this.activeValue;
    if (active === null) return;
    active.preview = points.map((p) => toWorld(this.viewValue, p));
    this.emit('active');
  }

  confirmStroke(): void {
    if (this.activeValue !== null) this.activeValue.provisional = false;
  }

  /** Commits the active stroke (unless still provisional, which cancels it). */
  commitStroke(): Stroke | null {
    const active = this.activeValue;
    if (active === null) return null;
    this.activeValue = null;
    if (active.provisional) {
      this.emit('active');
      return null;
    }
    const stroke = active.builder.build();
    this.doc.insert([stroke]);
    this.history.record({ kind: 'add', strokes: [stroke] });
    this.emit('doc');
    this.emit('active');
    this.emit('history');
    this.refreshLimit();
    return stroke;
  }

  cancelStroke(): void {
    if (this.activeValue === null) return;
    this.activeValue = null;
    this.emit('active');
  }

  /** Applies bounded edits as a single reversible action. */
  beautify(level: Enhancement): boolean {
    this.closeTransientWork();
    const edits = enhanceInk(this.doc.strokes, level, this.viewValue.scale);
    if (edits.length === 0) return false;
    const originals = edits.map((edit) => edit.original);
    const strokes = edits.map(({ original, coordinates }) => {
      const rebuilt = strokeFromPoints(this.nextId++, original.seq, { color: original.color, width: original.width }, coordinates);
      return { ...rebuilt, corners: original.corners };
    });
    this.doc.remove(new Set(originals.map((s) => s.id)));
    this.doc.insert(strokes);
    this.history.record({ kind: 'replace', strokes, originals });
    this.emit('doc');
    this.emit('history');
    return true;
  }

  // --- View ----------------------------------------------------------------

  setView(view: View): void {
    if (!isValidView(view)) return;
    const { minScale, maxScale } = this.config.view;
    const scale = Math.min(maxScale, Math.max(minScale, view.scale));
    const next = scale === view.scale ? view : { ...view, scale };
    if (next.scale === this.viewValue.scale && next.tx === this.viewValue.tx && next.ty === this.viewValue.ty) return;
    this.viewValue = next;
    this.emit('view');
  }

  pan(dx: number, dy: number): void {
    this.setView(panBy(this.viewValue, dx, dy));
  }

  zoom(anchor: BoardPoint, factor: number): void {
    this.setView(zoomAt(this.viewValue, anchor, factor, this.config.view));
  }

  resetView(): void {
    this.setView(IDENTITY_VIEW);
  }

  fit(boardWidth: number, boardHeight: number): void {
    this.setView(fitView(this.doc.contentBounds(), boardWidth, boardHeight, 32, this.config.view));
  }

  beginTransform(a: BoardPoint, b: BoardPoint): void {
    this.transform = new TwoHandTransform(this.viewValue, a, b, this.config.gesture.minTransformSeparationPx, this.config.view);
  }

  updateTransform(a: BoardPoint, b: BoardPoint): void {
    if (this.transform === null) return;
    this.setView(this.transform.update(a, b, this.viewValue));
  }

  endTransform(): void {
    this.transform = null;
  }

  // --- Erasing ---------------------------------------------------------------

  /** World radius matching the on-screen eraser circle at the current scale. */
  eraserRadiusWorld(): number {
    return this.config.eraserRadiusPx / this.viewValue.scale;
  }

  beginErase(at: BoardPoint): void {
    if (this.erase !== null) this.endErase();
    const w = toWorld(this.viewValue, at);
    this.erase = { last: w, removed: [], removedIds: new Set() };
    this.sweep(w, w);
  }

  moveErase(at: BoardPoint): void {
    const e = this.erase;
    if (e === null) return;
    const w = toWorld(this.viewValue, at);
    this.sweep(e.last, w);
    e.last = w;
  }

  /** Ends the gesture; everything it removed becomes one undoable action. */
  endErase(): number {
    const e = this.erase;
    this.erase = null;
    if (e === null || e.removed.length === 0) return 0;
    const removed = [...e.removed].sort((a, b) => a.seq - b.seq);
    this.history.record({ kind: 'remove', strokes: removed });
    this.emit('history');
    this.refreshLimit();
    return removed.length;
  }

  private sweep(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const e = this.erase;
    if (e === null) return;
    const scale = this.viewValue.scale;
    const ids = strokesHitByCapsule(this.doc.strokes, { from, to, radius: this.eraserRadiusWorld() }, 0.25 / scale, e.removedIds);
    if (ids.length === 0) return;
    const removed = this.doc.remove(new Set(ids));
    for (const s of removed) {
      e.removed.push(s);
      e.removedIds.add(s.id);
    }
    this.emit('doc');
  }

  // --- History -----------------------------------------------------------------

  undo(): boolean {
    this.closeTransientWork();
    const done = this.history.undo(this.doc) !== null;
    if (done) {
      this.emit('doc');
      this.emit('history');
      this.refreshLimit();
    }
    return done;
  }

  redo(): boolean {
    this.closeTransientWork();
    const done = this.history.redo(this.doc) !== null;
    if (done) {
      this.emit('doc');
      this.emit('history');
      this.refreshLimit();
    }
    return done;
  }

  /** Clears the board as one reversible action (call only after confirmation). */
  clear(): boolean {
    this.closeTransientWork();
    const removed = this.doc.clear();
    if (removed.length === 0) return false;
    this.history.record({ kind: 'clear', strokes: removed });
    this.emit('doc');
    this.emit('history');
    this.refreshLimit();
    return true;
  }

  /** Finishes in-progress gestures so history operations see a settled board. */
  closeTransientWork(): void {
    if (this.activeValue !== null) this.commitStroke();
    if (this.erase !== null) this.endErase();
    this.transform = null;
  }

  // --- Style -------------------------------------------------------------------

  setColor(color: string): void {
    this.color = color;
    this.emit('style');
  }

  setWidth(widthPx: number): void {
    this.widthPx = widthPx;
    this.emit('style');
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit('style');
  }
}
