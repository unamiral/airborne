/**
 * View transform between board-local CSS pixels and world coordinates
 * (plan §7, §9 "Two-hand transform mathematics"):
 *
 *   board = world * scale + t        world = (board - t) / scale
 *
 * Scale is finite and positive; translation is finite. World coordinates do
 * not depend on the viewport size.
 */
import { boardPoint, clamp, isEmptyBounds, worldPoint, type BoardPoint, type Bounds, type WorldPoint, type XY } from '../core/coords';

export interface View {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

export interface ScaleLimits {
  readonly minScale: number;
  readonly maxScale: number;
}

export const IDENTITY_VIEW: View = { scale: 1, tx: 0, ty: 0 };

export function isValidView(v: View): boolean {
  return Number.isFinite(v.scale) && v.scale > 0 && Number.isFinite(v.tx) && Number.isFinite(v.ty);
}

export function toWorld(v: View, p: XY): WorldPoint {
  return worldPoint((p.x - v.tx) / v.scale, (p.y - v.ty) / v.scale);
}

export function toBoard(v: View, w: XY): BoardPoint {
  return boardPoint(w.x * v.scale + v.tx, w.y * v.scale + v.ty);
}

/** Zooms by `factor` keeping the world point under `anchor` fixed. Clamp first, then translate. */
export function zoomAt(v: View, anchor: BoardPoint, factor: number, limits: ScaleLimits): View {
  const w = toWorld(v, anchor);
  const scale = clamp(v.scale * factor, limits.minScale, limits.maxScale);
  return { scale, tx: anchor.x - w.x * scale, ty: anchor.y - w.y * scale };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { scale: v.scale, tx: v.tx + dx, ty: v.ty + dy };
}

/** View that fits `bounds` (world) inside a board of the given size. */
export function fitView(bounds: Bounds, boardWidth: number, boardHeight: number, padding: number, limits: ScaleLimits): View {
  if (isEmptyBounds(bounds) || boardWidth <= 0 || boardHeight <= 0) return IDENTITY_VIEW;
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  const availW = Math.max(boardWidth - 2 * padding, 1);
  const availH = Math.max(boardHeight - 2 * padding, 1);
  const scale = clamp(Math.min(availW / w, availH / h, 1), limits.minScale, limits.maxScale);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, tx: boardWidth / 2 - cx * scale, ty: boardHeight / 2 - cy * scale };
}

/**
 * Simultaneous two-hand pan and zoom. At start (or rebase) it stores the
 * midpoint m0, separation d0, scale s0, and world anchor w0 = (m0 - t0)/s0;
 * each update sets s = clamp(s0 * d0/d) and t = m - w0 * s, so the world
 * anchor stays under the current midpoint. Below the minimum separation the
 * scale freezes while midpoint panning continues; when separation becomes
 * usable again the reference is rebased at the current view, which is
 * continuous by construction. No rotation, no inertia.
 */
export class TwoHandTransform {
  private s0: number;
  private d0: number;
  private w0: XY;
  private scaling: boolean;

  constructor(
    view: View,
    a: BoardPoint,
    b: BoardPoint,
    private readonly minSeparation: number,
    private readonly limits: ScaleLimits,
  ) {
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.s0 = view.scale;
    this.d0 = Math.hypot(a.x - b.x, a.y - b.y);
    this.w0 = toWorld(view, m);
    this.scaling = this.d0 >= minSeparation;
  }

  update(a: BoardPoint, b: BoardPoint, current: View): View {
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (this.scaling && d < this.minSeparation) {
      // Freeze scale at its current value; keep panning about the same anchor.
      this.scaling = false;
      this.s0 = current.scale;
    } else if (!this.scaling && d >= this.minSeparation) {
      // Rebase at the current view so the transition is continuous.
      this.scaling = true;
      this.s0 = current.scale;
      this.d0 = d;
      this.w0 = toWorld(current, m);
    }
    const scale = this.scaling ? clamp((this.s0 * this.d0) / d, this.limits.minScale, this.limits.maxScale) : this.s0;
    const next = { scale, tx: m.x - this.w0.x * scale, ty: m.y - this.w0.y * scale };
    return isValidView(next) ? next : current;
  }
}
