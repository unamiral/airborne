import { PointBuffer } from './points';
import type { Stroke } from './stroke';

const KEY = 'air-whiteboard-board-v1';

/** Store only committed ink; cookies are too small for drawing data. */
export function saveBoard(strokes: readonly Stroke[]): void {
  const data = strokes.map((s) => {
    const points: number[] = [];
    s.points.forEach((x, y) => points.push(x, y));
    return { id: s.id, seq: s.seq, color: s.color, width: s.width, points, corners: s.corners };
  });
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function loadBoard(): Stroke[] {
  const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  if (!Array.isArray(raw)) throw new Error('Invalid saved board');
  const ids = new Set<number>();
  return raw.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid saved stroke');
    const s = item as Record<string, unknown>;
    if (!Number.isSafeInteger(s.id) || (s.id as number) < 1 || ids.has(s.id as number) || !Number.isSafeInteger(s.seq) || (s.seq as number) < 1 || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color) || typeof s.width !== 'number' || !Number.isFinite(s.width) || s.width <= 0 || !Array.isArray(s.points) || s.points.length < 2 || s.points.length % 2 !== 0 || !s.points.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)) || !Array.isArray(s.corners) || !s.corners.every((v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < (s.points as number[]).length / 2)) throw new Error('Invalid saved stroke');
    ids.add(s.id as number);
    const coords = s.points as number[];
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = 0; i < coords.length; i += 2) {
      bounds.minX = Math.min(bounds.minX, coords[i]!); bounds.maxX = Math.max(bounds.maxX, coords[i]!);
      bounds.minY = Math.min(bounds.minY, coords[i + 1]!); bounds.maxY = Math.max(bounds.maxY, coords[i + 1]!);
    }
    return { id: s.id as number, seq: s.seq as number, color: s.color, width: s.width, points: PointBuffer.from(coords).freeze(), corners: s.corners as number[], bounds, geometryVersion: 0 };
  });
}
