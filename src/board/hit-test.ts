/**
 * Whole-stroke eraser hit testing (plan §10 "Erasing").
 *
 * The eraser sweeps a capsule between successive valid positions (no
 * tunneling) with radius = screen radius / scale (world units). A stroke is
 * hit when its centerline comes within radius + width/2 of the capsule's
 * axis. Broad phase: bounds overlap. Narrow phase: segment-to-segment
 * distance against the drawn curve flattened to a bounded screen-space error,
 * so crossings between sparse samples are found and dots are points.
 */
import type { XY } from '../core/coords';
import { forEachFlatSegment } from '../render/geometry';
import type { Stroke } from './stroke';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Squared distance between segments p0-p1 and q0-q1. */
export function segmentDistanceSq(
  p0x: number, p0y: number, p1x: number, p1y: number,
  q0x: number, q0y: number, q1x: number, q1y: number,
): number {
  const ux = p1x - p0x;
  const uy = p1y - p0y;
  const vx = q1x - q0x;
  const vy = q1y - q0y;
  const wx = p0x - q0x;
  const wy = p0y - q0y;
  const a = ux * ux + uy * uy;
  const b = ux * vx + uy * vy;
  const c = vx * vx + vy * vy;
  const d = ux * wx + uy * wy;
  const e = vx * wx + vy * wy;
  const denom = a * c - b * b;
  let s: number;
  let t: number;
  if (a <= 1e-18 && c <= 1e-18) {
    s = 0;
    t = 0;
  } else if (a <= 1e-18) {
    s = 0;
    t = clamp01(e / c);
  } else if (c <= 1e-18) {
    t = 0;
    s = clamp01(-d / a);
  } else {
    s = denom > 1e-18 ? clamp01((b * e - c * d) / denom) : 0;
    t = (b * s + e) / c;
    if (t < 0) {
      t = 0;
      s = clamp01(-d / a);
    } else if (t > 1) {
      t = 1;
      s = clamp01((b - d) / a);
    }
  }
  const dx = wx + s * ux - t * vx;
  const dy = wy + s * uy - t * vy;
  return dx * dx + dy * dy;
}

export interface Capsule {
  readonly from: XY;
  readonly to: XY;
  /** World units. */
  readonly radius: number;
}

export function capsuleHitsStroke(capsule: Capsule, stroke: Stroke, tolerance: number): boolean {
  const reach = capsule.radius + stroke.width / 2;
  const b = stroke.bounds;
  const minX = Math.min(capsule.from.x, capsule.to.x) - reach;
  const maxX = Math.max(capsule.from.x, capsule.to.x) + reach;
  const minY = Math.min(capsule.from.y, capsule.to.y) - reach;
  const maxY = Math.max(capsule.from.y, capsule.to.y) + reach;
  if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) return false;
  const reachSq = reach * reach;
  let hit = false;
  forEachFlatSegment(stroke.points, stroke.corners, tolerance, (ax, ay, bx, by) => {
    if (segmentDistanceSq(ax, ay, bx, by, capsule.from.x, capsule.from.y, capsule.to.x, capsule.to.y) <= reachSq) {
      hit = true;
      return true;
    }
    return false;
  });
  return hit;
}

/** Ids of strokes touched by the capsule, skipping ids in `exclude`. */
export function strokesHitByCapsule(
  strokes: readonly Stroke[],
  capsule: Capsule,
  tolerance: number,
  exclude: ReadonlySet<number>,
): number[] {
  const ids: number[] = [];
  for (const s of strokes) {
    if (exclude.has(s.id)) continue;
    if (capsuleHitsStroke(capsule, s, tolerance)) ids.push(s.id);
  }
  return ids;
}
