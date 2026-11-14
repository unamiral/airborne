/**
 * Transient pen-tip prediction (plan §8.6). Visual experiment only, disabled
 * by default: it never affects pinch decisions, hit tests, erasing, control
 * activation, stored geometry, history, or export. The renderer draws it as a
 * disposable tail from the last confirmed endpoint and replaces it each frame.
 *
 *   h = clamp(resultAge + estimatedDisplayWait, 0, min(maxHorizon, medianInterval / 2))
 *   offset = velocity * h, attenuated at slow speeds, turns, and unstable
 *   acceleration, then clamped to maxDistance.
 */
import type { PredictionConfig } from '../app/config';

export interface TimedPoint {
  /** Source time, ms. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

export interface PredictionContext {
  /** Recent filtered, observed samples of the active stroke, oldest first. */
  readonly samples: readonly TimedPoint[];
  /** Valid samples in the stroke so far. */
  readonly strokeSamples: number;
  /** Main-thread age of the newest sample at render time, ms. */
  readonly resultAgeMs: number;
  /** Estimated wait until the frame is displayed, ms (0 when unknown). */
  readonly displayWaitMs: number;
  /** Median interval between accepted samples, ms. */
  readonly medianIntervalMs: number;
  /** False during pinch transitions, ambiguity, or low-quality tracking. */
  readonly trustworthy: boolean;
}

export interface Offset {
  readonly dx: number;
  readonly dy: number;
}

const NONE: Offset = { dx: 0, dy: 0 };
/** Below this speed prediction fades out (CSS px per ms = 60 px/s). */
const SLOW_SPEED = 0.06;
const FULL_SPEED = 0.2;
/** Turn angle where prediction starts fading, and where it is gone (degrees). */
const TURN_START = 20;
const TURN_END = 45;

export function predictOffset(ctx: PredictionContext, config: PredictionConfig): Offset {
  if (!config.enabled || !ctx.trustworthy || ctx.strokeSamples <= 2 || ctx.samples.length < 3) return NONE;
  const n = ctx.samples.length;
  const a = ctx.samples[n - 3]!;
  const b = ctx.samples[n - 2]!;
  const c = ctx.samples[n - 1]!;
  const dt1 = b.t - a.t;
  const dt2 = c.t - b.t;
  if (!(dt1 > 0 && dt2 > 0)) return NONE;
  // A result older than one expected interval is frozen, not extrapolated.
  if (ctx.resultAgeMs > ctx.medianIntervalMs) return NONE;
  const v1x = (b.x - a.x) / dt1;
  const v1y = (b.y - a.y) / dt1;
  const v2x = (c.x - b.x) / dt2;
  const v2y = (c.y - b.y) / dt2;
  const s1 = Math.hypot(v1x, v1y);
  const s2 = Math.hypot(v2x, v2y);
  if (s2 < SLOW_SPEED) return NONE;
  let gain = Math.min(1, (s2 - SLOW_SPEED) / (FULL_SPEED - SLOW_SPEED));
  if (s1 > 0) {
    const cos = (v1x * v2x + v1y * v2y) / (s1 * s2);
    const turn = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    gain *= 1 - Math.min(1, Math.max(0, (turn - TURN_START) / (TURN_END - TURN_START)));
    // Decelerating or unstable speed: do not project past a likely stop.
    const ratio = s2 / s1;
    if (ratio < 0.7 || ratio > 1.6) gain = 0;
  }
  if (gain <= 0) return NONE;
  const horizon = Math.max(0, Math.min(ctx.resultAgeMs + ctx.displayWaitMs, config.maxHorizonMs, ctx.medianIntervalMs / 2));
  let dx = v2x * horizon * gain;
  let dy = v2y * horizon * gain;
  const len = Math.hypot(dx, dy);
  if (len > config.maxDistancePx) {
    dx = (dx / len) * config.maxDistancePx;
    dy = (dy / len) * config.maxDistancePx;
  }
  return { dx, dy };
}
