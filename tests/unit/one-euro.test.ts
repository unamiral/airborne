import { describe, expect, it } from 'vitest';
import { STABILIZER_PRESETS, type OneEuroParams } from '../../src/app/config';
import { OneEuroFilter, PointFilter, smoothingAlpha } from '../../src/signal/one-euro';
import { OneEuroFilter as Reference } from '../reference/OneEuroFilter';
import { rng } from '../support/synthetic';

const presets: Array<[string, OneEuroParams]> = Object.entries(STABILIZER_PRESETS);

describe('One Euro filter (F11)', () => {
  it('matches the authors’ reference implementation on irregular, strictly increasing timestamps', () => {
    for (const [name, p] of presets) {
      const random = rng(42);
      const mine = new OneEuroFilter(p, 10);
      const ref = new Reference(30, p.minCutoffHz, p.beta, p.derivativeCutoffHz);
      let t = 0;
      let x = 100;
      for (let i = 0; i < 2000; i++) {
        t += 0.008 + random() * 0.05; // 8–58 ms jittered intervals
        x += (random() - 0.5) * 20 + Math.sin(i / 30) * 5;
        const a = mine.filter(x, t);
        const b = ref.filter(x, t);
        expect(a, `${name} sample ${i}`).not.toBeNull();
        expect(Math.abs(a! - b), `${name} sample ${i}`).toBeLessThan(1e-9);
      }
    }
  });

  it('uses the plan’s alpha definition', () => {
    // alpha = 1 / (1 + 1/(2*pi*f*dt))
    expect(smoothingAlpha(1.5, 1 / 30)).toBeCloseTo(1 / (1 + 1 / (2 * Math.PI * 1.5 / 30)), 12);
  });

  it('initializes to the first valid sample, not zero', () => {
    const f = new OneEuroFilter(STABILIZER_PRESETS.balanced);
    expect(f.filter(500, 1)).toBe(500);
    expect(f.value).toBe(500);
  });

  it('rejects duplicate and reversed timestamps without changing state', () => {
    const f = new OneEuroFilter(STABILIZER_PRESETS.balanced);
    f.filter(0, 1);
    const v = f.filter(10, 1.033)!;
    expect(f.filter(50, 1.033)).toBeNull();
    expect(f.filter(50, 1.0)).toBeNull();
    expect(f.value).toBe(v);
    // The next genuine sample behaves as if the rejected ones never happened.
    const g = new OneEuroFilter(STABILIZER_PRESETS.balanced);
    g.filter(0, 1);
    g.filter(10, 1.033);
    expect(f.filter(20, 1.066)).toBeCloseTo(g.filter(20, 1.066)!, 12);
  });

  it('restarts after a large gap instead of smoothing across it', () => {
    const f = new OneEuroFilter(STABILIZER_PRESETS.steady, 0.25);
    f.filter(0, 0);
    f.filter(1, 0.033);
    expect(f.filter(400, 0.5)).toBe(400);
  });

  it('reset forgets history', () => {
    const f = new OneEuroFilter(STABILIZER_PRESETS.balanced);
    f.filter(0, 0);
    f.filter(100, 0.033);
    f.reset();
    expect(f.filter(7, 0.066)).toBe(7);
  });

  it('filters x and y independently with the same parameters (reference behavior)', () => {
    const pf = new PointFilter(STABILIZER_PRESETS.light);
    const fx = new OneEuroFilter(STABILIZER_PRESETS.light);
    const fy = new OneEuroFilter(STABILIZER_PRESETS.light);
    for (let i = 0; i < 50; i++) {
      const t = i / 30;
      const p = pf.filter(i * 3, Math.sin(i), t)!;
      expect(p.x).toBeCloseTo(fx.filter(i * 3, t)!, 12);
      expect(p.y).toBeCloseTo(fy.filter(Math.sin(i), t)!, 12);
    }
    expect(pf.filter(1, 1, 49 / 30)).toBeNull();
  });

  it('orders presets from least to most smoothing on a stationary noisy point', () => {
    const rms: Record<string, number> = {};
    for (const [name, p] of presets) {
      const random = rng(7);
      const f = new OneEuroFilter(p);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 600; i++) {
        const noise = (random() - 0.5) * 6;
        const out = f.filter(noise, i / 30)!;
        if (i > 30) {
          sum += out * out;
          n++;
        }
      }
      rms[name] = Math.sqrt(sum / n);
    }
    expect(rms.light!).toBeGreaterThan(rms.balanced!);
    expect(rms.balanced!).toBeGreaterThan(rms.steady!);
  });
});
