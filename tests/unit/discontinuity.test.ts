import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/app/config';
import { DiscontinuityDetector, type PenObservation } from '../../src/signal/discontinuity';

const cfg = DEFAULT_CONFIG.outlier;

function run(observations: PenObservation[]): boolean[] {
  const d = new DiscontinuityDetector(cfg);
  return observations.map((o) => {
    const v = d.check(o);
    if (!v.outlier) d.accept(o, v.residual);
    return v.outlier;
  });
}

/** Whole hand moving consistently: pen and palm keep their offset. */
function hand(t: number, x: number, y: number, palmSize = 150): PenObservation {
  return { t, pen: { x, y }, palm: { x: x + 40, y: y + 120 }, palmSize };
}

describe('discontinuity detection (F12)', () => {
  it('never flags a valid fast sweep, even at 1500 px/s', () => {
    const obs = Array.from({ length: 40 }, (_, i) => hand(i * 33, 100 + i * 50, 300));
    expect(run(obs).some(Boolean)).toBe(false);
  });

  it('never flags sharp corners or reversals of the whole hand', () => {
    const obs: PenObservation[] = [];
    for (let i = 0; i < 20; i++) obs.push(hand(i * 33, 100 + i * 20, 300));
    for (let i = 0; i < 20; i++) obs.push(hand((20 + i) * 33, 500 - i * 20, 300)); // reversal
    for (let i = 0; i < 20; i++) obs.push(hand((40 + i) * 33, 100, 300 + i * 20)); // 90° turn
    expect(run(obs).some(Boolean)).toBe(false);
  });

  it('flags an isolated pen jump that the palm does not share, without contaminating history', () => {
    const obs: PenObservation[] = Array.from({ length: 15 }, (_, i) => hand(i * 33, 300 + i * 5, 300));
    const glitch: PenObservation = { t: 15 * 33, pen: { x: 300 + 75 + 90, y: 300 - 60 }, palm: { x: 300 + 75 + 40, y: 420 }, palmSize: 150 };
    const after = Array.from({ length: 10 }, (_, i) => hand((16 + i) * 33, 300 + (16 + i) * 5, 300));
    const flags = run([...obs, glitch, ...after]);
    expect(flags[15]).toBe(true);
    expect(flags.filter(Boolean)).toHaveLength(1);
  });

  it('flags a multi-landmark jump with an inconsistent palm size', () => {
    const obs: PenObservation[] = Array.from({ length: 10 }, (_, i) => hand(i * 33, 300, 300));
    const swapped = hand(330, 520, 260, 90); // another hand: far away and smaller
    const flags = run([...obs, swapped]);
    expect(flags[10]).toBe(true);
  });

  it('scales thresholds with elapsed time so a longer interval is not an outlier by itself', () => {
    const d = new DiscontinuityDetector(cfg);
    const a = hand(0, 300, 300);
    const b = hand(33, 310, 300);
    d.accept(a, 0);
    d.accept(b, d.check(b).residual);
    const later = { ...hand(233, 330, 330), pen: { x: 330 + 8, y: 330 } };
    expect(d.check(later).outlier).toBe(false);
  });
});
