/**
 * M0 pointer-only board stub: an ordered list of polyline strokes in board CSS
 * pixels. Replaced by the world-space document in M1/M2.
 */
export interface Stroke {
  readonly id: number;
  readonly color: string;
  readonly width: number;
  /** Interleaved x, y. */
  readonly points: readonly number[];
}

export class BoardDocument {
  private list: Stroke[] = [];
  private nextId = 1;
  version = 0;

  get strokes(): readonly Stroke[] {
    return this.list;
  }

  add(color: string, width: number, points: readonly number[]): Stroke {
    const stroke: Stroke = { id: this.nextId++, color, width, points: points.slice() };
    this.list.push(stroke);
    this.version++;
    return stroke;
  }
}
