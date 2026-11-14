/**
 * Per-hand gesture features (plan §7, §8.1 steps 1 and 3, §9).
 *
 * Pen position and gesture evidence are computed separately: the pen is the
 * index fingertip in image coordinates, while pose, pinch and fist
 * evidence come from per-hand world landmarks (meters, origin at the hand's
 * centre). World landmarks are only compared within one hand, never across
 * hands. All thresholds are configurable seeds, validated on synthetic and
 * real-model fixtures (tests/unit/features.test.ts).
 */
import { cameraPoint, type CameraPoint } from '../core/coords';
import { cameraPixelDistance } from '../input/mapping';
import type { FrameCorner } from '../input/snapshot-frame';
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

export interface WritingProximity {
  readonly ratio: number;
  readonly space: 'world' | 'image';
  /** Thumb, index and middle extended and directed forward together. */
  readonly aligned?: boolean;
}

export interface HandFeatures {
  readonly valid: boolean;
  readonly invalidReason: string | null;
  /** Thumb-tip/index-tip distance ÷ wrist/middle-MCP distance (world). */
  readonly pinchRatio: number;
  /** Thumb/index proximity comes from a pinch, not from a closed fist. */
  readonly pinchPose: boolean;
  readonly fist: boolean;
  readonly extended: boolean;
  readonly frameCorner: FrameCorner | undefined;
  /** Unit palm normal in camera axes. Its sign is irrelevant to the clap test. */
  readonly palmNormal: Vec3 | null;
  readonly writingProximity: WritingProximity | null;
  readonly fingers: readonly FingerCurl[];
  /** Index fingertip, unmirrored normalized camera coordinates. */
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

function palmNormal(world: readonly number[]): Vec3 | null {
  const [ax, ay, az] = sub(at(world, LM.PINKY_MCP), at(world, LM.INDEX_MCP));
  const [bx, by, bz] = sub(at(world, LM.MIDDLE_MCP), at(world, LM.WRIST));
  const normal: Vec3 = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  const length = norm(normal);
  return length > 0 ? [normal[0] / length, normal[1] / length, normal[2] / length] : null;
}

/** Angle between two bone vectors in degrees (0 = straight continuation). */
function bend(a: Vec3, b: Vec3): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/** Detect three extended, forward-pointing digits. Ring and pinky are ignored. */
function alignedWritingPose(point: (index: number) => Vec3, palmLength: number): boolean {
  const digit = (joints: readonly number[]): Vec3 | null => {
    let length = 0;
    for (let i = 1; i < joints.length; i++) length += norm(sub(point(joints[i]!), point(joints[i - 1]!)));
    const direction = sub(point(joints[joints.length - 1]!), point(joints[0]!));
    const reach = norm(direction);
    // Reject foreshortened or crumpled landmark chains.
    return reach >= 0.22 * palmLength && reach >= 0.88 * length ? direction : null;
  };
  const index = digit([LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP]);
  const middle = digit([LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP]);
  const thumb = digit([LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP]);
  if (index === null || middle === null || thumb === null) return false;
  const forward = sub(point(LM.MIDDLE_MCP), point(LM.WRIST));
  return bend(forward, thumb) <= 50 && bend(forward, index) <= 45 && bend(forward, middle) <= 45 &&
    bend(index, middle) <= 30 && bend(index, thumb) <= 35 && bend(middle, thumb) <= 35;
}

/** Thumb and index form a visible L while the remaining fingers fold back. */
function frameCorner(hand: HandPayload, width: number, height: number, palmSize: number, palmScale: number, fingers: readonly FingerCurl[]): FrameCorner | undefined {
  const index = fingers[0];
  if (index === undefined || index.curled || index.bendDeg > 95 || index.tipPalmRatio < 0.95 ||
      fingers.slice(1).filter((finger) => finger.bendDeg >= 115 && finger.tipPalmRatio <= 1.15).length < 2) return undefined;
  const thumbLength = norm(sub(at(hand.world, LM.THUMB_TIP), at(hand.world, LM.THUMB_MCP)));
  if (thumbLength < 0.34 * palmScale) return undefined;

  const point = (joint: number) => ({ x: hand.landmarks[joint * 3]! * width, y: hand.landmarks[joint * 3 + 1]! * height });
  const indexBase = point(LM.INDEX_MCP);
  const thumbBase = point(LM.THUMB_MCP);
  const indexTip = point(LM.INDEX_TIP);
  const thumbTip = point(LM.THUMB_TIP);
  const vector = (from: typeof indexBase, to: typeof indexBase) => ({ x: to.x - from.x, y: to.y - from.y });
  const i = vector(indexBase, indexTip);
  const u = vector(thumbBase, thumbTip);
  const il = Math.hypot(i.x, i.y);
  const ul = Math.hypot(u.x, u.y);
  if (il < 0.42 * palmSize || ul < 0.24 * palmSize || Math.abs(i.x * u.x + i.y * u.y) > 0.58 * il * ul) return undefined;
  return {
    origin: { x: (indexBase.x + thumbBase.x) / 2, y: (indexBase.y + thumbBase.y) / 2 },
    index: { x: i.x / il, y: i.y / il },
    thumb: { x: u.x / ul, y: u.y / ul },
    size: palmSize,
  };
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
  const pen = cameraPoint(lm[LM.INDEX_TIP * 3]!, lm[LM.INDEX_TIP * 3 + 1]!);
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
  const hasWorldPalm = palmScaleM >= config.minPalmScaleM && palmScaleM <= config.maxPalmScaleM;
  const worldPinch = norm(sub(at(world, LM.THUMB_TIP), at(world, LM.INDEX_TIP)));
  const pinchRatio = hasWorldPalm && Number.isFinite(worldPinch) ? worldPinch / palmScaleM : Infinity;
  const fingers = Number.isFinite(pinchRatio) ? fingerCurls(world, palmScaleM, config) : [];
  // A raised thumb with four curled fingers is a thumbs-up, not an erase
  // gesture. Measure in world space so the check is rotation invariant.
  const thumbToMiddle = palmScaleM > 0
    ? norm(sub(at(world, LM.THUMB_TIP), at(world, LM.MIDDLE_MCP))) / palmScaleM
    : Number.POSITIVE_INFINITY;
  // One occluded tip can be noisy when the knuckles face forward. Require
  // three fully curled fingers and strong evidence of curl from the fourth.
  const fist = fingers.filter((f) => f.curled).length >= 3 && fingers.every((f) =>
    f.bendDeg >= config.curlBendDeg - 25 && f.tipPalmRatio <= config.curlTipPalmRatio + 0.15
  ) && thumbToMiddle <= 0.75;
  const centre = palmCentre3(world);
  const extended = hasWorldPalm && FINGERS.every(([mcp, pip, dip, tip]) => {
    const base = at(world, mcp), first = at(world, pip), second = at(world, dip), end = at(world, tip);
    const length = norm(sub(first, base)) + norm(sub(second, first)) + norm(sub(end, second));
    return length > 0 && norm(sub(end, base)) >= 0.93 * length &&
      norm(sub(end, centre)) >= 0.75 * palmScaleM;
  });
  const index = fingers[0];
  const pinchPose = index !== undefined && !index.curled && index.tipPalmRatio >= config.pinchIndexReachRatio;

  let invalidReason: string | null = null;
  if (![pen.x, pen.y, palm.x, palm.y, palmSizePx].every(Number.isFinite)) {
    invalidReason = 'non-finite geometry';
  } else if (palmSizePx < config.minPalmSizePx) {
    invalidReason = 'hand too small';
  }

  let writingProximity: WritingProximity | null = null;
  if (invalidReason === null) {
    const worldDistance = norm(sub(at(world, LM.THUMB_TIP), at(world, LM.MIDDLE_TIP)));
    if (hasWorldPalm && Number.isFinite(worldDistance) && worldDistance <= 3 * palmScaleM) {
      writingProximity = {
        ratio: worldDistance / palmScaleM,
        space: 'world',
        aligned: alignedWritingPose((index) => at(world, index), palmScaleM),
      };
    } else {
      // Image distances use pixel aspect, including the palm denominator.
      // Avoid using truncated tips for a projection-only estimate.
      const [tx, ty] = at(lm, LM.THUMB_TIP);
      const [mx, my] = at(lm, LM.MIDDLE_TIP);
      if ([tx, ty, mx, my].every((value) => value >= 0 && value <= 1)) {
        const imageDistance = cameraPixelDistance(tx, ty, mx, my, cameraWidth, cameraHeight);
        writingProximity = {
          ratio: imageDistance / palmSizePx,
          space: 'image',
          aligned: alignedWritingPose((index) => {
            const [x, y] = at(lm, index);
            return [x * cameraWidth, y * cameraHeight, 0];
          }, palmSizePx),
        };
      }
    }
  }
  return {
    valid: invalidReason === null,
    invalidReason,
    pinchRatio,
    pinchPose,
    writingProximity,
    fist,
    extended,
    frameCorner: !fist && invalidReason === null ? frameCorner(hand, cameraWidth, cameraHeight, palmSizePx, palmScaleM, fingers) : undefined,
    palmNormal: hasWorldPalm && !fist && fingers.filter((f) => f.bendDeg < 120 && f.tipPalmRatio > 0.7).length >= 3 ? palmNormal(world) : null,
    fingers,
    pen,
    palm,
    palmSizePx,
    palmScaleM,
  };
}
