/**
 * Validated application configuration (plan §9, §16).
 *
 * Every numeric tunable carries a unit and documented bounds. Values are seed
 * values from the plan unless a docs/decisions entry records an evidence-based
 * change. All updates go through `validateConfig`, and recordings embed
 * CONFIG_VERSION plus the full config.
 */

export const CONFIG_VERSION = 1;

export type StabilizerPreset = 'light' | 'balanced' | 'steady';

export interface OneEuroParams {
  /** Minimum cutoff frequency, Hz. Lower = less jitter, more lag at low speed. */
  readonly minCutoffHz: number;
  /** Speed coefficient for CSS-pixel input, 1/(CSS px). */
  readonly beta: number;
  /** Cutoff for the derivative estimate, Hz. */
  readonly derivativeCutoffHz: number;
}

/**
 * Plan §8.3 seed values (kept for comparison in the signal report).
 */
export const SEED_STABILIZER_PRESETS: Readonly<Record<StabilizerPreset, OneEuroParams>> = {
  light: { minCutoffHz: 2.5, beta: 0.03, derivativeCutoffHz: 1.0 },
  balanced: { minCutoffHz: 1.5, beta: 0.02, derivativeCutoffHz: 1.0 },
  steady: { minCutoffHz: 0.8, beta: 0.015, derivativeCutoffHz: 1.0 },
};

/**
 * Tuned on the synthetic suite (docs/signal-report.md, ADR 0003): the 1 Hz
 * derivative cutoff made the speed estimate react too slowly on curves (lag
 * up to 37 ms, p95 shape error up to 4.9 px at 30 Hz / 1 px noise). With a
 * 2 Hz derivative cutoff, Balanced meets every Balanced gate on the standard
 * suite at 30 Hz and also improves held-out traces. Not validated on real
 * camera traces or by users yet.
 */
export const STABILIZER_PRESETS: Readonly<Record<StabilizerPreset, OneEuroParams>> = {
  light: { minCutoffHz: 3.0, beta: 0.04, derivativeCutoffHz: 2.0 },
  balanced: { minCutoffHz: 2.0, beta: 0.03, derivativeCutoffHz: 2.0 },
  steady: { minCutoffHz: 1.0, beta: 0.02, derivativeCutoffHz: 2.0 },
};

export interface GestureConfig {
  /** Thumb-tip/index-tip world distance divided by wrist/middle-MCP distance. */
  readonly pinchDownRatio: number;
  /** Hysteresis release ratio; must exceed pinchDownRatio. */
  readonly pinchUpRatio: number;
  /** Minimum candidate duration before a pinch is confirmed, ms. */
  readonly confirmMs: number;
  /** Minimum valid pinched samples before confirmation, count. */
  readonly confirmSamples: number;
  /**
   * While drawing, samples whose ratio is between the down and up thresholds
   * are held back for at most this long, ms. They are discarded if the pinch
   * then opens (no opening-finger tails) and appended otherwise.
   */
  readonly releaseHoldMs: number;
  /** Window after onset in which a second pinching hand cancels the stroke, ms. */
  readonly twoHandJoinWindowMs: number;
  /** Path length below which a first-hand stroke may be rolled back, CSS px. */
  readonly transformRollbackPathPx: number;
  /** Minimum two-hand separation for zoom, CSS px. */
  readonly minTransformSeparationPx: number;
  /** Continuous fist duration required before erasing, ms. */
  readonly fistArmMs: number;
  /** Fist gesture enabled (an explicit eraser tool is always available). */
  readonly fistEraseEnabled: boolean;
  /** Longest tracking gap that may be reconnected during drawing, ms. */
  readonly shortDropoutMs: number;
  /** Maximum distance between last trusted and returning pen point, CSS px. */
  readonly reconnectDistancePx: number;
  /** Results older than this since frame observation are treated as loss, ms. */
  readonly staleResultMs: number;
  /** Absent tracks expire after this long, ms. */
  readonly trackExpiryMs: number;
}

export interface OutlierConfig {
  /** Enable rejection; when false, the detector only reports. */
  readonly rejectOutliers: boolean;
  /** Residual history length, samples. */
  readonly historySize: number;
  /** Absolute residual floor, CSS px. */
  readonly minResidualPx: number;
  /** Residual floor relative to mapped palm size, ratio. */
  readonly palmResidualRatio: number;
  /** Robust spread multiplier (median + k * MAD). */
  readonly madMultiplier: number;
  /** Palm-size change between consecutive samples counted as inconsistent, ratio. */
  readonly palmScaleJumpRatio: number;
}

export interface PredictionConfig {
  /** Visual-only prediction experiment (plan §8.6). Off until it passes gates. */
  readonly enabled: boolean;
  /** Upper bound on the prediction horizon, ms. */
  readonly maxHorizonMs: number;
  /** Upper bound on the predicted distance, CSS px. */
  readonly maxDistancePx: number;
}

export interface StrokeConfig {
  /** Minimum spacing between retained samples at creation scale, CSS px. */
  readonly minSpacingPx: number;
  /** Direction change that marks a corner vertex, degrees. */
  readonly cornerAngleDeg: number;
  /** Minimum adjacent segment length for corner evaluation, CSS px. */
  readonly cornerMinSegmentPx: number;
}

export interface ViewConfig {
  readonly minScale: number;
  readonly maxScale: number;
}

export interface LimitsConfig {
  readonly undoActions: number;
  /** Retained undo/redo payload, bytes. */
  readonly undoBytes: number;
  /** Normal benchmark workload. */
  readonly normalPoints: number;
  readonly normalStrokes: number;
  /** Hard guard: no new strokes beyond these counts. Existing work is kept. */
  readonly guardPoints: number;
  readonly guardStrokes: number;
}

export interface RenderConfig {
  /** Upper bound on canvas backing-store scale. */
  readonly maxRasterScale: number;
  /** Calculated backing-store budget for all app canvases, bytes. */
  readonly rasterBudgetBytes: number;
  /** App work per cache rebuild chunk, ms. */
  readonly rebuildChunkMs: number;
}

export interface CameraConfig {
  readonly idealWidth: number;
  readonly idealHeight: number;
  readonly idealFrameRate: number;
}

export interface AppConfig {
  readonly version: number;
  readonly stabilizer: StabilizerPreset;
  /** Fraction of the camera frame used as the reach rectangle. */
  readonly reach: number;
  /** Eraser radius on screen, CSS px. */
  readonly eraserRadiusPx: number;
  readonly gesture: GestureConfig;
  readonly outlier: OutlierConfig;
  readonly prediction: PredictionConfig;
  readonly stroke: StrokeConfig;
  readonly view: ViewConfig;
  readonly limits: LimitsConfig;
  readonly render: RenderConfig;
  readonly camera: CameraConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  stabilizer: 'balanced',
  reach: 0.7,
  eraserRadiusPx: 24,
  gesture: {
    pinchDownRatio: 0.25,
    pinchUpRatio: 0.4,
    confirmMs: 20,
    confirmSamples: 2,
    releaseHoldMs: 120,
    twoHandJoinWindowMs: 250,
    transformRollbackPathPx: 16,
    minTransformSeparationPx: 40,
    fistArmMs: 180,
    fistEraseEnabled: true,
    shortDropoutMs: 80,
    reconnectDistancePx: 8,
    staleResultMs: 100,
    trackExpiryMs: 250,
  },
  outlier: {
    rejectOutliers: true,
    historySize: 7,
    minResidualPx: 25,
    palmResidualRatio: 0.5,
    madMultiplier: 6,
    palmScaleJumpRatio: 0.3,
  },
  prediction: {
    enabled: false,
    maxHorizonMs: 16,
    // Plan seed 6 px overshot an instantaneous stop by 3.0 px (gate: 3 px);
    // 5 px keeps the worst synthetic overshoot at 2.5 px. See ADR 0003.
    maxDistancePx: 5,
  },
  stroke: {
    minSpacingPx: 0.5,
    cornerAngleDeg: 60,
    cornerMinSegmentPx: 2,
  },
  view: { minScale: 0.1, maxScale: 10 },
  limits: {
    undoActions: 100,
    undoBytes: 16 * 1024 * 1024,
    normalPoints: 100_000,
    normalStrokes: 500,
    guardPoints: 500_000,
    guardStrokes: 5_000,
  },
  render: {
    maxRasterScale: 2,
    rasterBudgetBytes: 64 * 1024 * 1024,
    rebuildChunkMs: 4,
  },
  camera: { idealWidth: 640, idealHeight: 480, idealFrameRate: 60 },
};

interface NumericSpec {
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly integer?: boolean;
}

type SpecFor<T> = { readonly [K in keyof T as T[K] extends number ? K : never]: NumericSpec };

/** Documented bounds for every numeric parameter. */
export const CONFIG_BOUNDS: {
  readonly root: { readonly reach: NumericSpec; readonly eraserRadiusPx: NumericSpec };
  readonly gesture: SpecFor<GestureConfig>;
  readonly outlier: SpecFor<OutlierConfig>;
  readonly prediction: SpecFor<PredictionConfig>;
  readonly stroke: SpecFor<StrokeConfig>;
  readonly view: SpecFor<ViewConfig>;
  readonly limits: SpecFor<LimitsConfig>;
  readonly render: SpecFor<RenderConfig>;
  readonly camera: SpecFor<CameraConfig>;
} = {
  root: {
    reach: { min: 0.5, max: 0.9, unit: 'fraction of camera frame' },
    eraserRadiusPx: { min: 8, max: 96, unit: 'CSS px' },
  },
  gesture: {
    pinchDownRatio: { min: 0.05, max: 0.6, unit: 'ratio' },
    pinchUpRatio: { min: 0.1, max: 0.9, unit: 'ratio' },
    confirmMs: { min: 0, max: 200, unit: 'ms' },
    confirmSamples: { min: 1, max: 6, unit: 'samples', integer: true },
    releaseHoldMs: { min: 0, max: 300, unit: 'ms' },
    twoHandJoinWindowMs: { min: 0, max: 1000, unit: 'ms' },
    transformRollbackPathPx: { min: 0, max: 100, unit: 'CSS px' },
    minTransformSeparationPx: { min: 10, max: 200, unit: 'CSS px' },
    fistArmMs: { min: 50, max: 1000, unit: 'ms' },
    shortDropoutMs: { min: 0, max: 250, unit: 'ms' },
    reconnectDistancePx: { min: 0, max: 50, unit: 'CSS px' },
    staleResultMs: { min: 30, max: 500, unit: 'ms' },
    trackExpiryMs: { min: 50, max: 2000, unit: 'ms' },
  },
  outlier: {
    historySize: { min: 3, max: 30, unit: 'samples', integer: true },
    minResidualPx: { min: 1, max: 200, unit: 'CSS px' },
    palmResidualRatio: { min: 0, max: 5, unit: 'ratio' },
    madMultiplier: { min: 1, max: 20, unit: 'MAD' },
    palmScaleJumpRatio: { min: 0.05, max: 2, unit: 'ratio' },
  },
  prediction: {
    maxHorizonMs: { min: 0, max: 50, unit: 'ms' },
    maxDistancePx: { min: 0, max: 30, unit: 'CSS px' },
  },
  stroke: {
    minSpacingPx: { min: 0.1, max: 5, unit: 'CSS px' },
    cornerAngleDeg: { min: 20, max: 170, unit: 'degrees' },
    cornerMinSegmentPx: { min: 0, max: 20, unit: 'CSS px' },
  },
  view: {
    minScale: { min: 0.01, max: 1, unit: 'scale' },
    maxScale: { min: 1, max: 100, unit: 'scale' },
  },
  limits: {
    undoActions: { min: 1, max: 10_000, unit: 'actions', integer: true },
    undoBytes: { min: 1024, max: 1024 ** 3, unit: 'bytes', integer: true },
    normalPoints: { min: 1, max: 10_000_000, unit: 'points', integer: true },
    normalStrokes: { min: 1, max: 1_000_000, unit: 'strokes', integer: true },
    guardPoints: { min: 1, max: 10_000_000, unit: 'points', integer: true },
    guardStrokes: { min: 1, max: 1_000_000, unit: 'strokes', integer: true },
  },
  render: {
    maxRasterScale: { min: 0.5, max: 4, unit: 'scale' },
    rasterBudgetBytes: { min: 4 * 1024 * 1024, max: 1024 ** 3, unit: 'bytes', integer: true },
    rebuildChunkMs: { min: 1, max: 16, unit: 'ms' },
  },
  camera: {
    idealWidth: { min: 160, max: 1920, unit: 'px', integer: true },
    idealHeight: { min: 120, max: 1080, unit: 'px', integer: true },
    idealFrameRate: { min: 10, max: 120, unit: 'fps' },
  },
};

export type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNumbers(
  section: string,
  value: unknown,
  specs: Readonly<Record<string, NumericSpec>>,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${section}: expected an object`);
    return;
  }
  for (const [key, spec] of Object.entries(specs)) {
    const v = value[key];
    const name = section === 'root' ? key : `${section}.${key}`;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${name}: expected a finite number (${spec.unit})`);
    } else if (v < spec.min || v > spec.max) {
      errors.push(`${name}: ${v} is outside [${spec.min}, ${spec.max}] ${spec.unit}`);
    } else if (spec.integer === true && !Number.isInteger(v)) {
      errors.push(`${name}: expected an integer (${spec.unit})`);
    }
  }
}

function checkBoolean(name: string, value: unknown, errors: string[]): void {
  if (typeof value !== 'boolean') errors.push(`${name}: expected a boolean`);
}

/** Validates a complete configuration object, including cross-field rules. */
export function validateConfig(candidate: unknown): ConfigResult {
  const errors: string[] = [];
  if (!isRecord(candidate)) return { ok: false, errors: ['config: expected an object'] };
  if (candidate.version !== CONFIG_VERSION) {
    errors.push(`version: expected ${CONFIG_VERSION}`);
  }
  if (!['light', 'balanced', 'steady'].includes(candidate.stabilizer as string)) {
    errors.push('stabilizer: expected light, balanced, or steady');
  }
  checkNumbers('root', candidate, CONFIG_BOUNDS.root, errors);
  checkNumbers('gesture', candidate.gesture, CONFIG_BOUNDS.gesture, errors);
  checkNumbers('outlier', candidate.outlier, CONFIG_BOUNDS.outlier, errors);
  checkNumbers('prediction', candidate.prediction, CONFIG_BOUNDS.prediction, errors);
  checkNumbers('stroke', candidate.stroke, CONFIG_BOUNDS.stroke, errors);
  checkNumbers('view', candidate.view, CONFIG_BOUNDS.view, errors);
  checkNumbers('limits', candidate.limits, CONFIG_BOUNDS.limits, errors);
  checkNumbers('render', candidate.render, CONFIG_BOUNDS.render, errors);
  checkNumbers('camera', candidate.camera, CONFIG_BOUNDS.camera, errors);
  if (isRecord(candidate.gesture)) {
    checkBoolean('gesture.fistEraseEnabled', candidate.gesture.fistEraseEnabled, errors);
    const g = candidate.gesture;
    if (typeof g.pinchUpRatio === 'number' && typeof g.pinchDownRatio === 'number') {
      if (!(g.pinchUpRatio > g.pinchDownRatio)) {
        errors.push('gesture.pinchUpRatio must exceed gesture.pinchDownRatio (hysteresis)');
      }
    }
  }
  if (isRecord(candidate.outlier)) {
    checkBoolean('outlier.rejectOutliers', candidate.outlier.rejectOutliers, errors);
  }
  if (isRecord(candidate.prediction)) {
    checkBoolean('prediction.enabled', candidate.prediction.enabled, errors);
  }
  if (isRecord(candidate.limits)) {
    const l = candidate.limits;
    if (typeof l.guardPoints === 'number' && typeof l.normalPoints === 'number') {
      if (l.guardPoints < l.normalPoints) errors.push('limits.guardPoints must be >= normalPoints');
    }
    if (typeof l.guardStrokes === 'number' && typeof l.normalStrokes === 'number') {
      if (l.guardStrokes < l.normalStrokes) {
        errors.push('limits.guardStrokes must be >= normalStrokes');
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: candidate as unknown as AppConfig };
}

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Returns a validated copy of `base` with `patch` applied, or the errors. */
export function patchConfig(base: AppConfig, patch: DeepPartial<AppConfig>): ConfigResult {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? { ...current, ...value } : value;
  }
  return validateConfig(merged);
}

export function oneEuroFor(config: AppConfig): OneEuroParams {
  return STABILIZER_PRESETS[config.stabilizer];
}
