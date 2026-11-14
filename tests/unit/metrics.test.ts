import { describe, expect, it } from 'vitest';
import { Metrics, RingSeries, percentile, summarize } from '../../src/app/metrics';

describe('percentile (linear interpolation, type 7)', () => {
  it('matches known values', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBeCloseTo(5.5, 12);
    expect(percentile(sorted, 95)).toBeCloseTo(9.55, 12);
    expect(percentile(sorted, 99)).toBeCloseTo(9.91, 12);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNaN();
  });

  it('summarizes known synthetic durations', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000 ms
    const s = summarize(values);
    expect(s.count).toBe(1000);
    expect(s.mean).toBeCloseTo(500.5, 9);
    expect(s.p50).toBeCloseTo(500.5, 9);
    expect(s.p95).toBeCloseTo(950.05, 9);
    expect(s.max).toBe(1000);
  });
});

describe('RingSeries', () => {
  it('keeps the newest samples in insertion order within capacity', () => {
    const r = new RingSeries(3);
    [1, 2, 3, 4, 5].forEach((v) => r.push(v));
    expect(Array.from(r.values())).toEqual([3, 4, 5]);
    expect(r.length).toBe(3);
    expect(r.total).toBe(5);
    r.clear();
    expect(r.values()).toHaveLength(0);
  });
});

describe('Metrics', () => {
  it('records series and counters separately and ignores non-finite samples', () => {
    const m = new Metrics(16);
    m.sample('inferenceMs', 10);
    m.sample('inferenceMs', 20);
    m.sample('inferenceMs', Number.NaN);
    m.count('busySkips');
    m.count('busySkips', 2);
    expect(m.summary('inferenceMs').count).toBe(2);
    expect(m.counter('busySkips')).toBe(3);
    expect(m.counter('timeouts')).toBe(0);
    const snap = m.snapshot();
    expect(snap.counters.busySkips).toBe(3);
    expect(snap.series.inferenceMs!.p50).toBe(15);
  });
});
