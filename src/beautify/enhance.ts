/** Conservative, bounded edits for handwritten ink. */
import type { Stroke } from '../board/stroke';

export type Enhancement = 'light' | 'balanced';
export interface InkEdit { readonly original: Stroke; readonly coordinates: readonly number[] }
interface Group { strokes: Stroke[]; left: number; right: number; top: number; bottom: number }
const median = (v: readonly number[]): number => {
  const a = [...v].sort((x, y) => x - y);
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i]! : (a[i - 1]! + a[i]!) / 2;
};

/** Overlapping horizontal bounds join multiple strokes, including dots and bars. */
function groupsFor(strokes: readonly Stroke[]): Group[] {
  const sorted = [...strokes].sort((a, b) => a.bounds.minX - b.bounds.minX);
  const groups: Group[] = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && s.bounds.minX <= last.right) {
      last.strokes.push(s);
      last.right = Math.max(last.right, s.bounds.maxX);
      last.top = Math.min(last.top, s.bounds.minY);
      last.bottom = Math.max(last.bottom, s.bounds.maxY);
    } else groups.push({ strokes: [s], left: s.bounds.minX, right: s.bounds.maxX, top: s.bounds.minY, bottom: s.bounds.maxY });
  }
  return groups;
}

/**
 * Smooths small local deviations while retaining endpoints and detected corners.
 * Balanced also gently aligns a plausible single line of separated groups.
 * Ambiguous layouts and large corrections are deliberately left unchanged.
 */
export function enhanceInk(strokes: readonly Stroke[], level: Enhancement, scale: number): InkEdit[] {
  if (!Number.isFinite(scale) || scale <= 0 || strokes.length > 300 || strokes.reduce((n, s) => n + s.points.length, 0) > 20000) return [];
  const offsets = new Map<number, number>();
  if (level === 'balanced' && strokes.length >= 4) {
    const groups = groupsFor(strokes);
    if (groups.length >= 4 && groups.length <= 80) {
      const heights = groups.map((g) => g.bottom - g.top);
      const height = median(heights);
      const widths = groups.map((g) => g.right - g.left);
      const bottoms = groups.map((g) => g.bottom);
      const baseline = median(bottoms);
      // Only near-horizontal, similarly sized, separate clusters; no layout guessing.
      if (height >= 8 / scale && groups.every((g, i) => heights[i]! >= height * 0.5 && heights[i]! <= height * 1.8 && widths[i]! <= height * 1.5 && Math.abs(g.bottom - baseline) <= height * 0.22)) {
        for (const g of groups) {
          const shift = Math.max(-2 / scale, Math.min(2 / scale, (baseline - g.bottom) * 0.35));
          for (const s of g.strokes) offsets.set(s.id, shift);
        }
      }
    }
  }
  const edits: InkEdit[] = [];
  for (const stroke of strokes) {
    const p = stroke.points;
    const offset = offsets.get(stroke.id) ?? 0;
    const coords: number[] = [];
    const corners = new Set(stroke.corners);
    const limit = (level === 'light' ? 0.8 : 1.8) / scale;
    let changed = false;
    for (let i = 0; i < p.length; i++) {
      let x = p.x(i), y = p.y(i);
      // Balance the neighbours by their distance along the stroke. Equal
      // weights would pull even straight ink toward the more distant sample
      // when hand speed or camera cadence changes. Keep marked corners and
      // their immediate neighbours.
      if (i > 0 && i < p.length - 1 && !corners.has(i) && !corners.has(i - 1) && !corners.has(i + 1) && p.length >= 5) {
        const beforeX = p.x(i - 1) - x, beforeY = p.y(i - 1) - y;
        const afterX = p.x(i + 1) - x, afterY = p.y(i + 1) - y;
        const before = Math.hypot(beforeX, beforeY);
        const after = Math.hypot(afterX, afterY);
        const span = before + after;
        if (span > 0) {
          const strength = level === 'light' ? 0.325 : 0.5;
          const dx = (beforeX * (after / span) + afterX * (before / span)) * strength;
          const dy = (beforeY * (after / span) + afterY * (before / span)) * strength;
          const distance = Math.hypot(dx, dy);
          const factor = distance > limit ? limit / distance : 1;
          x += dx * factor; y += dy * factor;
        }
      }
      y += offset;
      if (Math.abs(x - p.x(i)) > 1e-6 || Math.abs(y - p.y(i)) > 1e-6) changed = true;
      coords.push(x, y);
    }
    if (changed) edits.push({ original: stroke, coordinates: coords });
  }
  return edits;
}
