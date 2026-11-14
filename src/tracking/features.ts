/**
 * Per-hand gesture features (plan §7, §8.1 steps 1 and 3, §9).
 *
 * Pen position and gesture evidence are computed separately: the pen is the
 * thumb/index tip midpoint in image coordinates, while pinch and fist
 * evidence come from per-hand world landmarks (meters, origin at the hand's
 * centre). World landmarks are only compared within one hand, never across
 * hands. All thresholds are configurable seeds, validated on synthetic and
 * real-model fixtures (tests/unit/features.test.ts).
 */
import { cameraPoint, type CameraPoint } from '../core/coords';
import { cameraPixelDistance } from '../input/mapping';
import { FINGERS, LM } from './landmarks';
import type { HandPayload } from './protocol';

export interface FeatureConfig {
  /** Plausible wrist→middle-MCP length range, meters. */
  readonly minPalmScaleM: number;
  readonly maxPalmScaleM: number;
  /** Minimum wrist→middle-MCP length in camera pixels. */
  readonly minPalmSizePx: number;
  /** A finger counts as curled when its MCP+PIP+DIP bend exceeds this, degrees... */
  readonly curlBendDeg: number;
  /** ...and its tip is within this many palm lengths of the palm centre. */
  readonly curlTipPalmRatio: number;
  /** Pinch pose: index tip at least this many palm lengths from the palm centre. */
  readonly pinchIndexReachRatio: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  minPalmScaleM: 0.03,
  maxPalmScaleM: 0.25,
  minPalmSizePx: 8,
  curlBendDeg: 150,
  curlTipPalmRatio: 0.95,
  pinchIndexReachRatio: 0.8,
};

export interface FingerCurl {
  readonly bendDeg: number;
  readonly tipPalmRatio: number;
  readonly curled: boolean;
}

export interface HandFeatures {
  readonly valid: boolean;
  readonly invalidReason: string | null;
  /** Thumb-tip/index-tip distance ÷ wrist/middle-MCP distance (world). */
  readonly pinchRatio: number;
  /** Thumb/index proximity comes from a pinch, not from a closed fist. */
  readonly pinchPose: boolean;
  readonly fist: boolean;
  readonly fingers: readonly FingerCurl[];
  /** Thumb/index tip midpoint, unmirrored normalized camera coordinates. */
  readonly pen: CameraPoint;
  /** Palm centre (wrist + four MCPs), normalized camera coordinates. */
  readonly palm: CameraPoint;
  /** Wrist→middle-MCP distance, camera pixels. */
  readonly palmSizePx: number;
  /** Wrist→middle-MCP distance, meters. */
  readonly palmScaleM: number;
}

type Vec3 = readonly [number, number, number];

function at(values: readonly number[], index: number): Vec3 {
  return [values[index * 3]!, values[index * 3 + 1]!, values[index * 3 + 2]!];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Angle between two bone vectors in degrees (0 = straight continuation). */
function bend(a: Vec3, b: Vec3): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

const PALM_POINTS = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const;

function palmCentre3(values: readonly number[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of PALM_POINTS) {
    x += values[i * 3]!;
    y += values[i * 3 + 1]!;
    z += values[i * 3 + 2]!;
  }
  const n = PALM_POINTS.length;
  return [x / n, y / n, z / n];
}

export function fingerCurls(world: readonly number[], palmScaleM: number, config: FeatureConfig): FingerCurl[] {
  const wrist = at(world, LM.WRIST);
  const centre = palmCentre3(world);
  return FINGERS.map(([mcp, pip, dip, tip]) => {
    const pMcp = at(world, mcp);
    const pPip = at(world, pip);
    const pDip = at(world, dip);
    const pTip = at(world, tip);
    const bendDeg =
      bend(sub(pMcp, wrist), sub(pPip, pMcp)) + bend(sub(pPip, pMcp), sub(pDip, pPip)) + bend(sub(pDip, pPip), sub(pTip, pDip));
    const tipPalmRatio = palmScaleM > 0 ? norm(sub(pTip, centre)) / palmScaleM : Number.POSITIVE_INFINITY;
    return { bendDeg, tipPalmRatio, curled: bendDeg >= config.curlBendDeg && tipPalmRatio <= config.curlTipPalmRatio };
  });
}

export function extractFeatures(
  hand: HandPayload,
  cameraWidth: number,
  cameraHeight: number,
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): HandFeatures {
  const lm = hand.landmarks;
  const world = hand.world;
  const pen = cameraPoint(
    (lm[LM.THUMB_TIP * 3]! + lm[LM.INDEX_TIP * 3]!) / 2,
    (lm[LM.THUMB_TIP * 3 + 1]! + lm[LM.INDEX_TIP * 3 + 1]!) / 2,
  );
  let px = 0;
  let py = 0;
  for (const i of PALM_POINTS) {
    px += lm[i * 3]!;
    py += lm[i * 3 + 1]!;
  }
  const palm = cameraPoint(px / PALM_POINTS.length, py / PALM_POINTS.length);
  const palmSizePx = cameraPixelDistance(
    lm[LM.WRIST * 3]!,
    lm[LM.WRIST * 3 + 1]!,
    lm[LM.MIDDLE_MCP * 3]!,
    lm[LM.MIDDLE_MCP * 3 + 1]!,
    cameraWidth,
    cameraHeight,
  );
  const palmScaleM = norm(sub(at(world, LM.MIDDLE_MCP), at(world, LM.WRIST)));
  const pinchRatio = palmScaleM > 0 ? norm(sub(at(world, LM.THUMB_TIP), at(world, LM.INDEX_TIP))) / palmScaleM : Number.POSITIVE_INFINITY;
  const fingers = fingerCurls(world, palmScaleM, config);
  // A raised thumb with four curled fingers is a thumbs-up, not an erase
  // gesture. Measure in world space so the check is rotation invariant.
  const thumbToMiddle = palmScaleM > 0
    ? norm(sub(at(world, LM.THUMB_TIP), at(world, LM.MIDDLE_MCP))) / palmScaleM
    : Number.POSITIVE_INFINITY;
  const fist = fingers.every((f) => f.curled) && thumbToMiddle <= 0.75;
  const index = fingers[0]!;
  const pinchPose = !index.curled && index.tipPalmRatio >= config.pinchIndexReachRatio;

  let invalidReason: string | null = null;
  if (![pen.x, pen.y, palm.x, palm.y, palmSizePx, palmScaleM, pinchRatio].every(Number.isFinite)) {
    invalidReason = 'non-finite geometry';
  } else if (palmScaleM < config.minPalmScaleM || palmScaleM > config.maxPalmScaleM) {
    invalidReason = 'implausible palm scale';
  } else if (palmSizePx < config.minPalmSizePx) {
    invalidReason = 'hand too small';
  }
  return {
    valid: invalidReason === null,
    invalidReason,
    pinchRatio,
    pinchPose,
    fist,
    fingers,
    pen,
    palm,
    palmSizePx,
    palmScaleM,
  };
}
