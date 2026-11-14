/**
 * Named coordinate spaces (plan §7). Points are plain `{x, y}` objects at
 * runtime; the brands only exist for the type checker so that, for example, a
 * world-space point cannot be passed where a board-local CSS point is expected.
 *
 *   camera   normalized landmark coordinates, unmirrored, [0,1] x [0,1]
 *   surface  CSS pixels of the whole interaction surface (control strip + board)
 *   board    CSS pixels relative to the board canvas' top-left corner
 *   world    board document coordinates (independent of viewport size)
 *
 * Canvas backing-store pixels only exist inside the renderer.
 */
declare const space: unique symbol;

export interface XY {
  readonly x: number;
  readonly y: number;
}

type In<S extends string> = XY & { readonly [space]: S };

export type CameraPoint = In<'camera'>;
export type SurfacePoint = In<'surface'>;
export type BoardPoint = In<'board'>;
export type WorldPoint = In<'world'>;

export const cameraPoint = (x: number, y: number): CameraPoint => ({ x, y }) as CameraPoint;
export const surfacePoint = (x: number, y: number): SurfacePoint => ({ x, y }) as SurfacePoint;
export const boardPoint = (x: number, y: number): BoardPoint => ({ x, y }) as BoardPoint;
export const worldPoint = (x: number, y: number): WorldPoint => ({ x, y }) as WorldPoint;

export function distance(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isFinitePoint(p: XY): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function rectContains(r: Rect, p: XY): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/** Axis-aligned bounds; `minX > maxX` means empty. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmptyBounds(b: Bounds): boolean {
  return b.minX > b.maxX || b.minY > b.maxY;
}

export function extendBounds(b: Bounds, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function inflateBounds(b: Bounds, by: number): Bounds {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
