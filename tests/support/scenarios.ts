/**
 * Scripted hand scenarios → replay records. Each hand follows a timeline of
 * phases (pose + pen path in surface CSS px); positions are converted to
 * camera coordinates with the inverse of the app's mapping, so replay
 * exercises the real pipeline end to end.
 */
import { CONFIG_VERSION, DEFAULT_CONFIG, type AppConfig } from '../../src/app/config';
import { REPLAY_SCHEMA_VERSION, type ReplayExpectations, type ReplayFrame, type ReplayRecord } from '../../src/dev/replay-format';
import type { HandPayload } from '../../src/tracking/protocol';
import { POSES, handAt, type Pose } from './hands';

export const SURFACE = { width: 1280, height: 720, stripWidth: 120 };
export const CAMERA = { width: 640, height: 480 };

export interface Phase {
  /** Duration, ms. */
  readonly ms: number;
  readonly pose: Pose;
  /** Pen position over the phase (u in [0,1]) in surface CSS px. */
  readonly path: (u: number) => { x: number; y: number };
}

export interface HandScript {
  readonly start?: number;
  readonly phases: readonly Phase[];
  readonly palmPx?: number;
  readonly handedness?: 'Left' | 'Right';
}

export const still = (x: number, y: number) => () => ({ x, y });
export const move = (x0: number, y0: number, x1: number, y1: number) => (u: number) => ({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u });

export interface ScenarioOptions {
  readonly rateHz?: number;
  readonly noisePx?: number;
  readonly worldNoiseM?: number;
  readonly seed?: number;
  readonly ageMs?: number;
  /** Frame times (ms) at which every hand is missing (dropouts). */
  readonly gaps?: ReadonlyArray<readonly [number, number]>;
  readonly config?: AppConfig;
  /** Interaction surface; defaults to SURFACE (1280×720, 120 px strip). */
  readonly surface?: { readonly width: number; readonly height: number; readonly stripWidth: number };
}

type Surface = { readonly width: number; readonly height: number; readonly stripWidth: number };

/** Inverse of SurfaceMapping.toSurface (unmirrored normalized camera coords). */
export function surfaceToCamera(x: number, y: number, config: AppConfig = DEFAULT_CONFIG, surface: Surface = SURFACE): { u: number; v: number } {
  const inverse = (value: number): number => {
    const d = 2 * value - 1;
    return (1 + Math.sign(d) * Math.pow(Math.abs(d), 0.7 / config.reach)) / 2;
  };
  return { u: inverse(1 - x / surface.width), v: inverse(y / surface.height) };
}

function handAtTime(script: HandScript, t: number): { pose: Pose; x: number; y: number } | null {
  let t0 = script.start ?? 0;
  if (t < t0) return null;
  for (const phase of script.phases) {
    if (t < t0 + phase.ms) {
      const p = phase.path((t - t0) / phase.ms);
      return { pose: phase.pose, ...p };
    }
    t0 += phase.ms;
  }
  return null;
}

export function scenario(
  name: string,
  hands: readonly HandScript[],
  expected: ReplayExpectations,
  options: ScenarioOptions = {},
): ReplayRecord {
  const config = options.config ?? DEFAULT_CONFIG;
  const interval = 1000 / (options.rateHz ?? 30);
  const end = Math.max(
    ...hands.map((h) => (h.start ?? 0) + h.phases.reduce((sum, p) => sum + p.ms, 0)),
  );
  const frames: ReplayFrame[] = [];
  let seed = options.seed ?? 1;
  for (let t = 0; t <= end + interval; t += interval) {
    if (options.gaps?.some(([a, b]) => t >= a && t < b) === true) continue;
    const payloads: HandPayload[] = [];
    for (const script of hands) {
      const at = handAtTime(script, t);
      if (at === null) continue;
      const cam = surfaceToCamera(at.x, at.y, config, options.surface ?? SURFACE);
      payloads.push(
        handAt(at.pose, {
          penU: cam.u,
          penV: cam.v,
          palmPx: script.palmPx ?? 70,
          noisePx: options.noisePx ?? 0.3,
          worldNoiseM: options.worldNoiseM ?? 0.0004,
          seed: seed++,
          handedness: script.handedness ?? 'Right',
        }),
      );
    }
    frames.push({ t: Math.round(t * 1000) / 1000, ageMs: options.ageMs ?? 30, hands: payloads });
  }
  return {
    schema: REPLAY_SCHEMA_VERSION,
    source: 'synthetic',
    createdAt: '2026-11-14T00:00:00.000Z',
    scenario: { name, description: name, tags: ['synthetic'] },
    camera: CAMERA,
    surface: options.surface ?? SURFACE,
    configVersion: CONFIG_VERSION,
    config,
    backend: { delegate: 'synthetic', mediapipeVersion: 'n/a', modelSha256: 'n/a' },
    frames,
    expected,
  };
}

/** Common phases. */
export const hover = (ms: number, x: number, y: number): Phase => ({ ms, pose: POSES.open, path: still(x, y) });
export const writeMove = (ms: number, x0: number, y0: number, x1: number, y1: number, ratio = 0.24): Phase => ({
  ms,
  pose: POSES.writing(ratio),
  path: move(x0, y0, x1, y1),
});
export const writeAt = (ms: number, x: number, y: number, ratio = 0.24): Phase => ({ ms, pose: POSES.writing(ratio), path: still(x, y) });

export const extendMove = (ms: number, x0: number, y0: number, x1: number, y1: number): Phase => ({
  ms, pose: POSES.open, path: move(x0, y0, x1, y1),
});
export const handsAtRest = (ms: number, x: number, y: number): Phase => ({ ms, pose: { ...POSES.relaxed, middle: POSES.halfCurl.middle }, path: still(x, y) });

/** Edge-on open hands approaching along the palm normals, then separating. */
export function clapScenario(approachMs = 134, yaw = 70): ReplayRecord {
  const clapPose: Pose = { ...POSES.open, yaw };
  return scenario('one clap', [
    { phases: [
      { ms: 300, pose: clapPose, path: still(515, 285) },
      { ms: approachMs, pose: clapPose, path: move(515, 285, 622, 285) },
      { ms: 200, pose: clapPose, path: still(622, 285) },
      { ms: 200, pose: clapPose, path: move(622, 285, 515, 285) },
    ] },
    { handedness: 'Left', phases: [
      { ms: 300, pose: clapPose, path: still(765, 285) },
      { ms: approachMs, pose: clapPose, path: move(765, 285, 658, 285) },
      { ms: 200, pose: clapPose, path: still(658, 285) },
      { ms: 200, pose: clapPose, path: move(658, 285, 765, 285) },
    ] },
  ], { strokes: 0 });
}

export function frameSnapshotScenario(holdMs = 1250, repeated = false): ReplayRecord {
  const pair = (x: number, yaw: number): Phase[] => {
    const pose = { ...POSES.frame, roll: 12, yaw };
    const frame = { ms: holdMs, pose, path: still(x, 280) };
    return [
      hover(200, x, 280), frame,
      ...(repeated ? [handsAtRest(380, x, 280), frame] : []),
      handsAtRest(380, x, 280),
    ];
  };
  return scenario('frame snapshot', [
    { phases: pair(460, 25), handedness: 'Right' },
    { phases: pair(820, -20), handedness: 'Left' },
  ], { strokes: 0 });
}
