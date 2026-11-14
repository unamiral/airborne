/**
 * Chunked point storage for strokes (plan §10: "Large individual strokes use
 * chunked point storage"). Chunks grow geometrically from 32 to 4096 points,
 * so short strokes stay small and long strokes never copy their whole history
 * while growing. `freeze` trims only the last chunk.
 */

const FIRST_CAPACITY = 32;
const MAX_CAPACITY = 4096;

export interface ReadonlyPoints {
  readonly length: number;
  x(index: number): number;
  y(index: number): number;
  /** Visits points in order without allocating per point. */
  forEach(visit: (x: number, y: number, index: number) => void): void;
  readonly byteLength: number;
}

export class PointBuffer implements ReadonlyPoints {
  private chunks: Float64Array[] = [];
  private starts: number[] = [];
  private capacities: number[] = [];
  private count = 0;
  private frozen = false;

  get length(): number {
    return this.count;
  }

  get byteLength(): number {
    let bytes = 0;
    for (const c of this.chunks) bytes += c.byteLength;
    return bytes;
  }

  push(x: number, y: number): void {
    if (this.frozen) throw new Error('PointBuffer is frozen');
    const k = this.chunks.length - 1;
    if (k < 0 || this.count - this.starts[k]! >= this.capacities[k]!) {
      const cap = k < 0 ? FIRST_CAPACITY : Math.min(this.capacities[k]! * 2, MAX_CAPACITY);
      this.chunks.push(new Float64Array(cap * 2));
      this.starts.push(this.count);
      this.capacities.push(cap);
    }
    const last = this.chunks.length - 1;
    const j = (this.count - this.starts[last]!) * 2;
    const chunk = this.chunks[last]!;
    chunk[j] = x;
    chunk[j + 1] = y;
    this.count++;
  }

  /** Removes the last point (used for the replaceable live endpoint). */
  pop(): void {
    if (this.frozen) throw new Error('PointBuffer is frozen');
    if (this.count === 0) return;
    this.count--;
    const last = this.chunks.length - 1;
    if (last > 0 && this.count === this.starts[last]) {
      this.chunks.pop();
      this.starts.pop();
      this.capacities.pop();
    }
  }

  private locate(index: number): [Float64Array, number] {
    if (index < 0 || index >= this.count) throw new RangeError(`point index ${index} out of range`);
    let k = this.chunks.length - 1;
    while (this.starts[k]! > index) k--;
    return [this.chunks[k]!, (index - this.starts[k]!) * 2];
  }

  x(index: number): number {
    const [chunk, j] = this.locate(index);
    return chunk[j]!;
  }

  y(index: number): number {
    const [chunk, j] = this.locate(index);
    return chunk[j + 1]!;
  }

  forEach(visit: (x: number, y: number, index: number) => void): void {
    let index = 0;
    for (let k = 0; k < this.chunks.length && index < this.count; k++) {
      const chunk = this.chunks[k]!;
      const end = Math.min(this.capacities[k]!, this.count - this.starts[k]!);
      for (let i = 0; i < end; i++, index++) visit(chunk[i * 2]!, chunk[i * 2 + 1]!, index);
    }
  }

  /** Makes the buffer immutable and releases unused capacity in the last chunk. */
  freeze(): ReadonlyPoints {
    if (!this.frozen) {
      const last = this.chunks.length - 1;
      if (last >= 0) {
        const used = this.count - this.starts[last]!;
        this.chunks[last] = this.chunks[last]!.slice(0, used * 2);
        this.capacities[last] = used;
      }
      this.frozen = true;
    }
    return this;
  }

  static from(coords: readonly number[]): PointBuffer {
    const b = new PointBuffer();
    for (let i = 0; i + 1 < coords.length; i += 2) b.push(coords[i]!, coords[i + 1]!);
    return b;
  }
}
