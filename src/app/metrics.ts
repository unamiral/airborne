/**
 * Lightweight instrumentation (plan §12). Production builds use `noopMetrics`;
 * development and bench builds record into fixed-size ring buffers so memory
 * stays bounded during long sessions.
 *
 * Clock domains: every sample is a duration measured within one context
 * (main thread or worker). Cross-context values are never subtracted.
 */

export type SeriesName =
  | 'sourceIntervalMs'
  | 'snapshotMs'
  | 'roundTripMs'
  | 'inferenceMs'
  | 'resultAgeMs'
  | 'inputMs'
  | 'drawSubmitMs'
  | 'renderMs'
  | 'frameWorkMs'
  | 'rafIntervalMs'
  | 'rebuildChunkMs';

export type CounterName =
  | 'sourceFrames'
  | 'duplicateFrames'
  | 'busySkips'
  | 'deferredAdmissions'
  | 'admitted'
  | 'accepted'
  | 'staleResults'
  | 'invalidResults'
  | 'outOfOrderResults'
  | 'detectErrors'
  | 'timeouts'
  | 'snapshotFailures'
  | 'obsoleteResults'
  | 'identityAmbiguous'
  | 'identityNewTracks'
  | 'outliersFlagged'
  | 'longTasks';

export interface MetricsSink {
  sample(name: SeriesName, value: number): void;
  count(name: CounterName, delta?: number): void;
}

export const noopMetrics: MetricsSink = {
  sample: () => undefined,
  count: () => undefined,
};

/** Fixed-capacity ring buffer of numeric samples. */
export class RingSeries {
  private readonly data: Float64Array;
  private next = 0;
  private size = 0;
  total = 0;

  constructor(readonly capacity: number) {
    this.data = new Float64Array(capacity);
  }

  push(value: number): void {
    this.data[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this.total++;
  }

  get length(): number {
    return this.size;
  }

  /** Samples in insertion order (copy). */
  values(): Float64Array {
    const out = new Float64Array(this.size);
    const start = this.size < this.capacity ? 0 : this.next;
    for (let i = 0; i < this.size; i++) out[i] = this.data[(start + i) % this.capacity]!;
    return out;
  }

  clear(): void {
    this.next = 0;
    this.size = 0;
    this.total = 0;
  }
}

/**
 * Percentile with linear interpolation between closest ranks (the "type 7"
 * definition used by NumPy and R by default). `sorted` must be ascending.
 */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (p <= 0) return sorted[0]!;
  if (p >= 100) return sorted[n - 1]!;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (rank - lo);
}

export interface Summary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export function summarize(values: ArrayLike<number>): Summary {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const n = sorted.length;
  return {
    count: n,
    mean: n > 0 ? sum / n : Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n > 0 ? sorted[n - 1]! : Number.NaN,
  };
}

export class Metrics implements MetricsSink {
  private readonly series = new Map<SeriesName, RingSeries>();
  private readonly counters = new Map<CounterName, number>();

  constructor(private readonly capacity = 8192) {}

  sample(name: SeriesName, value: number): void {
    if (!Number.isFinite(value)) return;
    let s = this.series.get(name);
    if (s === undefined) {
      s = new RingSeries(this.capacity);
      this.series.set(name, s);
    }
    s.push(value);
  }

  count(name: CounterName, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  counter(name: CounterName): number {
    return this.counters.get(name) ?? 0;
  }

  values(name: SeriesName): Float64Array {
    return this.series.get(name)?.values() ?? new Float64Array(0);
  }

  summary(name: SeriesName): Summary {
    return summarize(this.values(name));
  }

  snapshot(): { series: Record<string, Summary>; counters: Record<string, number> } {
    const series: Record<string, Summary> = {};
    for (const name of this.series.keys()) series[name] = this.summary(name);
    return { series, counters: Object.fromEntries(this.counters) };
  }

  reset(): void {
    this.series.clear();
    this.counters.clear();
  }
}
