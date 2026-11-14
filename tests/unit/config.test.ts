import { describe, expect, it } from 'vitest';
import {
  CONFIG_BOUNDS,
  DEFAULT_CONFIG,
  SEED_STABILIZER_PRESETS,
  STABILIZER_PRESETS,
  patchConfig,
  validateConfig,
} from '../../src/app/config';

describe('configuration validation', () => {
  it('accepts the defaults', () => {
    const result = validateConfig(DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  it('keeps the plan seed values for gesture thresholds', () => {
    const g = DEFAULT_CONFIG.gesture;
    expect(g.pinchDownRatio).toBe(0.25);
    expect(g.pinchUpRatio).toBe(0.4);
    expect(g.confirmMs).toBe(20);
    expect(g.confirmSamples).toBe(2);
    expect(g.twoHandJoinWindowMs).toBe(250);
    expect(g.transformRollbackPathPx).toBe(16);
    expect(g.minTransformSeparationPx).toBe(40);
    expect(g.fistArmMs).toBe(180);
    expect(g.shortDropoutMs).toBe(80);
    expect(g.reconnectDistancePx).toBe(8);
    expect(g.staleResultMs).toBe(100);
    expect(DEFAULT_CONFIG.view).toEqual({ minScale: 0.1, maxScale: 10 });
    expect(SEED_STABILIZER_PRESETS.balanced).toEqual({ minCutoffHz: 1.5, beta: 0.02, derivativeCutoffHz: 1 });
    // Tuned presets keep their ordering: more smoothing means a lower cutoff.
    expect(STABILIZER_PRESETS.light.minCutoffHz).toBeGreaterThan(STABILIZER_PRESETS.balanced.minCutoffHz);
    expect(STABILIZER_PRESETS.balanced.minCutoffHz).toBeGreaterThan(STABILIZER_PRESETS.steady.minCutoffHz);
  });

  it('documents a unit and finite bounds for every numeric parameter', () => {
    for (const section of Object.values(CONFIG_BOUNDS)) {
      for (const spec of Object.values(section)) {
        expect(spec.unit.length).toBeGreaterThan(0);
        expect(spec.min).toBeLessThanOrEqual(spec.max);
      }
    }
    // Every default sits inside its documented bounds (validateConfig ok above),
    // and every numeric default field has a spec.
    for (const [key, value] of Object.entries(DEFAULT_CONFIG.gesture)) {
      if (typeof value === 'number') expect(CONFIG_BOUNDS.gesture).toHaveProperty(key);
    }
  });

  it('rejects out-of-range, non-finite, and wrongly typed values', () => {
    const r1 = patchConfig(DEFAULT_CONFIG, { reach: 0.95 });
    expect(r1.ok).toBe(false);
    const r2 = patchConfig(DEFAULT_CONFIG, { gesture: { fistArmMs: Number.NaN } });
    expect(r2.ok).toBe(false);
    const r3 = patchConfig(DEFAULT_CONFIG, { gesture: { confirmSamples: 2.5 } });
    expect(r3.ok).toBe(false);
    const r4 = validateConfig({ ...DEFAULT_CONFIG, stabilizer: 'extreme' });
    expect(r4.ok).toBe(false);
    const r5 = validateConfig({ ...DEFAULT_CONFIG, version: 99 });
    expect(r5.ok).toBe(false);
    expect(validateConfig(null).ok).toBe(false);
  });

  it('enforces pinch hysteresis (up threshold above down threshold)', () => {
    const result = patchConfig(DEFAULT_CONFIG, { gesture: { pinchDownRatio: 0.4, pinchUpRatio: 0.3 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/hysteresis/);
  });

  it('applies a valid patch without mutating the base', () => {
    const result = patchConfig(DEFAULT_CONFIG, { reach: 0.8, gesture: { fistEraseEnabled: false } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.reach).toBe(0.8);
      expect(result.config.gesture.fistEraseEnabled).toBe(false);
      expect(result.config.gesture.pinchDownRatio).toBe(0.25);
    }
    expect(DEFAULT_CONFIG.reach).toBe(0.7);
  });
});
