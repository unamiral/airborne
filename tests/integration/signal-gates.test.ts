/**
 * F11 signal-quality gates for the Balanced preset (plan §14), on the
 * standard synthetic suite at 30 Hz. The full matrix (presets, 15/30/60 Hz,
 * 1/2/4 px noise, held-out traces) is in docs/signal-report.md.
 */
import { describe, expect, it } from 'vitest';
import { STABILIZER_PRESETS } from '../../src/app/config';
import { corners, moving, stationaryNoise } from '../support/signal-eval';

const balanced = STABILIZER_PRESETS.balanced;

describe('Balanced stabilizer gates (synthetic, 30 Hz)', () => {
  it('reduces stationary radial RMS error by at least 50% on the 2 px noise fixture', () => {
    expect(stationaryNoise(balanced, 2, 30).reduction).toBeGreaterThanOrEqual(0.5);
  });

  it('adds at most 25 ms median lag on the moving traces (2 px noise)', () => {
    const lags = moving(balanced, 30, 2).map((m) => m.lagMs).sort((a, b) => a - b);
    expect(lags[Math.floor(lags.length / 2)]).toBeLessThanOrEqual(25);
  });

  it('keeps lag-compensated p95 shape error at most 3 px on each standard path (1 px noise)', () => {
    for (const m of moving(balanced, 30, 1)) expect(m.p95ShapeErrorPx, m.name).toBeLessThanOrEqual(3);
  });

  it('keeps standard corner vertices within 4 px (1 px noise)', () => {
    for (const c of corners(balanced, 30, 1)) expect(c.vertexDisplacementPx, `${c.angleDeg}°`).toBeLessThanOrEqual(4);
  });
});
