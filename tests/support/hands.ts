/**
 * Synthetic 21-landmark hands for feature, pipeline, and replay tests.
 *
 * A simple kinematic model in meters (wrist→middle-MCP = 9 cm) with finger
 * flexion, a thumb that can be placed for a pinch, and a global rotation. The
 * image landmarks are an orthographic projection positioned so that the pen
 * point (thumb/index tip midpoint) lands at a requested camera location.
 * This is a test model, not a claim about real hand anatomy or detector output.
 */
import type { HandPayload, Handedness } from '../../src/tracking/protocol';
import { gaussian, rng } from './synthetic';

type V3 = [number, number, number];

export interface Curl {
  readonly mcp: number;
  readonly pip: number;
  readonly dip: number;
}

export interface Pose {
  readonly index: Curl;
  readonly middle: Curl;
  readonly ring: Curl;
  readonly pinky: Curl;
  /** 'open' thumb, 'fist' thumb across the fingers, or a pinch with this ratio to the index tip. */
  readonly thumb: 'open' | 'fist' | { readonly pinchRatio: number };
  /** Degrees. */
  readonly roll?: number;
  readonly pitch?: number;
  readonly yaw?: number;
}

const straight: Curl = { mcp: 8, pip: 8, dip: 5 };
const relaxed: Curl = { mcp: 25, pip: 30, dip: 15 };
const curled: Curl = { mcp: 85, pip: 100, dip: 60 };
const half: Curl = { mcp: 50, pip: 55, dip: 30 };
const pinchIndex: Curl = { mcp: 35, pip: 40, dip: 20 };

export const POSES = {
  open: { index: straight, middle: straight, ring: straight, pinky: straight, thumb: 'open' } as Pose,
  relaxed: { index: relaxed, middle: relaxed, ring: relaxed, pinky: relaxed, thumb: 'open' } as Pose,
  pinch: (ratio = 0.12): Pose => ({ index: pinchIndex, middle: relaxed, ring: relaxed, pinky: relaxed, thumb: { pinchRatio: ratio } }),
  /** Pinch while the other fingers are curled. */
  tightPinch: (ratio = 0.12): Pose => ({ index: pinchIndex, middle: curled, ring: curled, pinky: curled, thumb: { pinchRatio: ratio } }),
  fist: { index: curled, middle: curled, ring: curled, pinky: curled, thumb: 'fist' } as Pose,
  halfCurl: { index: half, middle: half, ring: half, pinky: half, thumb: 'open' } as Pose,
  pointing: { index: straight, middle: curled, ring: curled, pinky: curled, thumb: 'fist' } as Pose,
} as const;

export function withRotation(pose: Pose, roll: number, pitch = 0, yaw = 0): Pose {
  return { ...pose, roll, pitch, yaw };
}

const PALM = 0.09;
const MCP: Record<'index' | 'middle' | 'ring' | 'pinky', V3> = {
  index: [-0.025, -0.085, 0],
  middle: [0, -PALM, 0],
  ring: [0.022, -0.083, 0],
  pinky: [0.042, -0.072, 0],
};
const BONES: Record<'index' | 'middle' | 'ring' | 'pinky', V3> = {
  index: [0.04, 0.024, 0.02],
  middle: [0.045, 0.028, 0.021],
  ring: [0.042, 0.026, 0.02],
  pinky: [0.032, 0.019, 0.018],
};

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

function finger(base: V3, bones: V3, c: Curl): V3[] {
  // Flexion rotates the bone direction (initially -y) toward -z (toward the camera).
  const pts: V3[] = [base];
  let angle = 0;
  let p = base;
  const angles = [c.mcp, c.pip, c.dip];
  for (let i = 0; i < 3; i++) {
    angle += (angles[i]! * Math.PI) / 180;
    const dir: V3 = [0, -Math.cos(angle), -Math.sin(angle)];
    p = add(p, scale(dir, bones[i]!));
    pts.push(p);
  }
  return pts;
}

function rotate(p: V3, rollDeg: number, pitchDeg: number, yawDeg: number): V3 {
  const r = (rollDeg * Math.PI) / 180;
  const pi = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  // roll about z
  let [a, b, c] = p;
  [a, b] = [a * Math.cos(r) - b * Math.sin(r), a * Math.sin(r) + b * Math.cos(r)];
  // pitch about x
  [b, c] = [b * Math.cos(pi) - c * Math.sin(pi), b * Math.sin(pi) + c * Math.cos(pi)];
  // yaw about y
  [a, c] = [a * Math.cos(y) + c * Math.sin(y), -a * Math.sin(y) + c * Math.cos(y)];
  return [a, b, c];
}

/** World landmarks (meters) for a pose, wrist at the origin, before rotation. */
export function worldPose(pose: Pose): V3[] {
  const out: V3[] = new Array<V3>(21);
  out[0] = [0, 0, 0];
  const names = ['index', 'middle', 'ring', 'pinky'] as const;
  const starts = [5, 9, 13, 17];
  names.forEach((n, k) => {
    const pts = finger(MCP[n], BONES[n], pose[n]);
    pts.forEach((p, j) => {
      out[starts[k]! + j] = p;
    });
  });
  const indexTip = out[8]!;
  const cmc: V3 = [-0.02, -0.025, 0];
  const mcp: V3 = [-0.042, -0.045, -0.012];
  let tip: V3;
  if (pose.thumb === 'open') {
    tip = [-0.075, -0.08, -0.02];
  } else if (pose.thumb === 'fist') {
    tip = [-0.004, -0.072, -0.042];
  } else {
    // Thumb tip exactly pinchRatio * palm length from the index tip.
    const dir: V3 = [-0.85, 0.5, -0.15];
    tip = add(indexTip, scale(dir, (pose.thumb.pinchRatio * PALM) / Math.hypot(...dir)));
  }
  const ip = add(scale(add(mcp, tip), 0.5), [-0.008, 0.004, -0.006]);
  out[1] = cmc;
  out[2] = mcp;
  out[3] = ip;
  out[4] = tip;
  return out.map((p) => rotate(p, pose.roll ?? 0, pose.pitch ?? 0, pose.yaw ?? 0));
}

export interface PlaceOptions {
  /** Desired pen point (thumb/index midpoint), normalized unmirrored camera coords. */
  readonly penU: number;
  readonly penV: number;
  /** Wrist→middle-MCP length in camera pixels (before rotation foreshortening). */
  readonly palmPx?: number;
  readonly cameraWidth?: number;
  readonly cameraHeight?: number;
  readonly noisePx?: number;
  readonly worldNoiseM?: number;
  readonly seed?: number;
  readonly handedness?: Handedness;
}

export function handAt(pose: Pose, o: PlaceOptions): HandPayload {
  const cw = o.cameraWidth ?? 640;
  const ch = o.cameraHeight ?? 480;
  const s = (o.palmPx ?? 70) / PALM;
  const world = worldPose(pose);
  const penWorld = scale(add(world[4]!, world[8]!), 0.5);
  const random = rng(o.seed ?? 1);
  const g = gaussian(random);
  const n = o.noisePx ?? 0;
  const wn = o.worldNoiseM ?? 0;
  const landmarks: number[] = [];
  const worldOut: number[] = [];
  // Translate world landmarks to be centred like MediaPipe's (origin near the hand centre).
  const centre = scale(world.reduce((acc, p) => add(acc, p), [0, 0, 0] as V3), 1 / 21);
  for (const p of world) {
    const dx = (p[0] - penWorld[0]) * s;
    const dy = (p[1] - penWorld[1]) * s;
    landmarks.push(o.penU + (dx + g() * n) / cw, o.penV + (dy + g() * n) / ch, (p[2] * s) / cw);
    worldOut.push(p[0] - centre[0] + g() * wn, p[1] - centre[1] + g() * wn, p[2] - centre[2] + g() * wn);
  }
  return { landmarks, world: worldOut, handedness: o.handedness ?? 'Right', handednessScore: 0.95 };
}
