import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, STABILIZER_PRESETS } from '../../src/app/config';
import { predictOffset, type PredictionContext, type TimedPoint } from '../../src/signal/prediction';
import { filterSamples } from '../support/signal-eval';
import { corner, line, polyline, sample, type Path } from '../support/synthetic';

const on = { ...DEFAULT_CONFIG.prediction, enabled: true };

function ctx(samples: TimedPoint[], extra: Partial<PredictionContext> = {}): PredictionContext {
  return { samples, strokeSamples: 10, resultAgeMs: 20, displayWaitMs: 8, medianIntervalMs: 33, trustworthy: true, ...extra };
}

const steady = (speedPxPerMs: number): TimedPoint[] => [0, 33, 66].map((t) => ({ t, x: t * speedPxPerMs, y: 0 }));

describe('transient prediction (F13)', () => {
  it('is off by default', () => {
    expect(DEFAULT_CONFIG.prediction.enabled).toBe(false);
    expect(predictOffset(ctx(steady(0.5)), DEFAULT_CONFIG.prediction)).toEqual({ dx: 0, dy: 0 });
  });

  it('bounds the horizon by min(maxHorizon, interval/2) and the distance by maxDistance', () => {
    // 0.25 px/ms; horizon min(20 + 8, 16, 16.5) = 16 ms → 4 px.
    const a = predictOffset(ctx(steady(0.25)), on);
    expect(a.dx).toBeCloseTo(4, 9);
    // Very fast: clamped to maxDistancePx.
    const b = predictOffset(ctx(steady(2)), on);
    expect(Math.hypot(b.dx, b.dy)).toBeCloseTo(on.maxDistancePx, 9);
    // A short sample interval halves the horizon cap (fresh result).
    const c = predictOffset(ctx(steady(0.3), { medianIntervalMs: 16, resultAgeMs: 10 }), on);
    expect(c.dx).toBeCloseTo(0.3 * 8, 9);
  });

  it('predicts nothing for the first two samples, slow motion, untrustworthy, or stale results', () => {
    expect(predictOffset(ctx(steady(0.5), { strokeSamples: 2 }), on).dx).toBe(0);
    expect(predictOffset(ctx(steady(0.02)), on).dx).toBe(0);
    expect(predictOffset(ctx(steady(0.5), { trustworthy: false }), on).dx).toBe(0);
    expect(predictOffset(ctx(steady(0.5), { resultAgeMs: 40 }), on).dx).toBe(0);
  });

  it('fades out at turns and when decelerating toward a stop', () => {
    const turn: TimedPoint[] = [
      { t: 0, x: 0, y: 0 },
      { t: 33, x: 10, y: 0 },
      { t: 66, x: 10, y: 10 },
    ];
    expect(predictOffset(ctx(turn), on)).toEqual({ dx: 0, dy: 0 });
    const braking: TimedPoint[] = [
      { t: 0, x: 0, y: 0 },
      { t: 33, x: 12, y: 0 },
      { t: 66, x: 18, y: 0 },
    ];
    expect(predictOffset(ctx(braking), on)).toEqual({ dx: 0, dy: 0 });
  });

  it('overshoots stops and corners by at most 3 px on the synthetic suite (30 Hz, Balanced)', () => {
    const paths: Path[] = [
      line(400, 0, 1500),
      line(800, 0, 1000),
      corner(45),
      corner(90),
      corner(135),
      polyline('stop-and-go', [{ x: 300, y: 300 }, { x: 500, y: 300 }, { x: 700, y: 300 }], 400, 300),
    ];
    let worst = 0;
    for (const [i, path] of paths.entries()) {
      const { observed } = sample(path, { rateHz: 30, noisePx: 1, seed: 50 + i, jitter: 0.1 });
      const filtered = filterSamples(observed, STABILIZER_PRESETS.balanced);
      for (let k = 3; k < filtered.length; k++) {
        const recent = filtered.slice(k - 3, k + 1).map((s) => ({ t: s.t, x: s.x, y: s.y }));
        const o = predictOffset(ctx(recent, { strokeSamples: k + 1 }), on);
        const tip = { x: filtered[k]!.x + o.dx, y: filtered[k]!.y + o.dy };
        // Overshoot: how far the predicted tip lies beyond the true pen position
        // at the time the frame would be shown (now + horizon), past turns/stops.
        const horizon = Math.min(20 + 8, 16, 33 / 2);
        const truth = path.at(filtered[k]!.t + horizon);
        const truthNow = path.at(filtered[k]!.t);
        const predictedTravel = Math.hypot(tip.x - filtered[k]!.x, tip.y - filtered[k]!.y);
        const trueTravel = Math.hypot(truth.x - truthNow.x, truth.y - truthNow.y);
        const err = Math.hypot(tip.x - truth.x, tip.y - truth.y);
        if (predictedTravel > trueTravel) worst = Math.max(worst, Math.min(err, predictedTravel - trueTravel));
      }
    }
    expect(worst).toBeLessThanOrEqual(3);
  });
});
