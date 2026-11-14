/**
 * Canonical vector board (plan §10). Strokes live in world coordinates in
 * ascending `seq` order; raster layers are disposable caches. The document
 * is mutated only through BoardController/History; UI code reads summaries.
 */
import { emptyBounds, isEmptyBounds, unionBounds, type Bounds } from '../core/coords';
import type { Stroke } from './stroke';

export class BoardDocument {
  private list: Stroke[] = [];
  private points = 0;
  /** Increments on every content change. */
  version = 0;

  get strokes(): readonly Stroke[] {
    return this.list;
  }

  get strokeCount(): number {
    return this.list.length;
  }

  get pointCount(): number {
    return this.points;
  }

  has(id: number): boolean {
    return this.list.some((s) => s.id === id);
  }

  /** Inserts strokes keeping ascending seq order (append is the fast path). */
  insert(strokes: readonly Stroke[]): void {
    for (const stroke of strokes) {
      const last = this.list[this.list.length - 1];
      if (last === undefined || last.seq < stroke.seq) {
        this.list.push(stroke);
      } else {
        let lo = 0;
        let hi = this.list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (this.list[mid]!.seq < stroke.seq) lo = mid + 1;
          else hi = mid;
        }
        this.list.splice(lo, 0, stroke);
      }
      this.points += stroke.points.length;
    }
    if (strokes.length > 0) this.version++;
  }

  /** Removes strokes by id; returns the removed strokes in document order. */
  remove(ids: ReadonlySet<number>): Stroke[] {
    if (ids.size === 0) return [];
    const removed: Stroke[] = [];
    const kept: Stroke[] = [];
    for (const s of this.list) (ids.has(s.id) ? removed : kept).push(s);
    if (removed.length > 0) {
      this.list = kept;
      for (const s of removed) this.points -= s.points.length;
      this.version++;
    }
    return removed;
  }

  clear(): Stroke[] {
    const removed = this.list;
    this.list = [];
    this.points = 0;
    if (removed.length > 0) this.version++;
    return removed;
  }

  /** Bounds of all ink, inflated by half stroke widths. */
  contentBounds(): Bounds {
    let b = emptyBounds();
    for (const s of this.list) {
      if (isEmptyBounds(s.bounds)) continue;
      const h = s.width / 2;
      b = unionBounds(b, { minX: s.bounds.minX - h, minY: s.bounds.minY - h, maxX: s.bounds.maxX + h, maxY: s.bounds.maxY + h });
    }
    return b;
  }
}
