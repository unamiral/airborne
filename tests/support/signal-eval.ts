/**
 * Signal-quality evaluation of the pen filter on the synthetic suite
 * (plan §14 "Balanced-mode initial signal acceptance targets"). Shared by
 * tests/integration/signal-gates.test.ts and scripts/signal-report.ts.
 */
import type { OneEuroParams } from '../../src/app/config';
import { PointFilter } from '../../src/signal/one-euro';
import {
  bestLag,
  circle,
  corner,
  line,
  percentileOf,
  polyline,
  rmsError,
  sample,
  shapeErrors,
  sine,
  stationary,
  vertexDisplacement,
  type Path,
  type Sample,
} from './synthetic';

export function filterSamples(samples: readonly Sample[], params: OneEuroParams): Sample[] {
  const f = new PointFilter(params, 10);
  const out: Sample[] = [];
  for (const s of samples) {
    const p = f.filter(s.x, s.y, s.t / 1000);
    if (p !== null) out.push({ t: s.t, x: p.x, y: p.y });
  }
  return out;
}

export interface StationaryResult {
  readonly noisePx: number;
  readonly rateHz: number;
  readonly rawRms: number;
  readonly filteredRms: number;
  readonly reduction: number;
}

export function stationaryNoise(params: OneEuroParams, noisePx: number, rateHz: number, seed = 1): StationaryResult {
  const path = stationary(4000);
  const { observed } = sample(path, { rateHz, noisePx, seed, jitter: 0.1 });
  const filtered = filterSamples(observed, params);
  const truth = (t: number) => path.at(t);
  const rawRms = rmsError(observed, truth, 500);
  const filteredRms = rmsError(filtered, truth, 500);
  return { noisePx, rateHz, rawRms, filteredRms, reduction: 1 - filteredRms / rawRms };
}

export interface MovingResult {
  readonly name: string;
  readonly speed: number;
  readonly lagMs: number;
  readonly p95ShapeErrorPx: number;
}

export function movingPaths(): Array<{ path: Path; speed: number }> {
  return [
    { path: line(100), speed: 100 },
    { path: line(400), speed: 400 },
    { path: line(800, 0, 1200), speed: 800 },
    { path: circle(20, 1000), speed: (2 * Math.PI * 20) / 1 },
    { path: circle(50, 2000), speed: (2 * Math.PI * 50) / 2 },
    { path: circle(100, 2500), speed: (2 * Math.PI * 100) / 2.5 },
    { path: sine(40, 200, 250), speed: 250 },
  ];
}

export function moving(params: OneEuroParams, rateHz: number, noisePx: number, seed = 3): MovingResult[] {
  return movingPaths().map(({ path, speed }, i) => {
    const { observed } = sample(path, { rateHz, noisePx, seed: seed + i, jitter: 0.1 });
    const filtered = filterSamples(observed, params);
    const lagMs = bestLag(filtered, path);
    // Exclude the first 150 ms (onset transient) from the shape statistic.
    const errs = shapeErrors(filtered, path, lagMs, 150);
    return { name: path.name, speed: Math.round(speed), lagMs, p95ShapeErrorPx: percentileOf(errs, 95) };
  });
}

export interface CornerResult {
  readonly angleDeg: number;
  readonly vertexDisplacementPx: number;
  readonly rawVertexDisplacementPx: number;
}

export function corners(params: OneEuroParams, rateHz: number, noisePx: number, seed = 11): CornerResult[] {
  return [45, 90, 135].map((angle, i) => {
    const path = corner(angle);
    const { observed } = sample(path, { rateHz, noisePx, seed: seed + i, jitter: 0.1 });
    const filtered = filterSamples(observed, params);
    return {
      angleDeg: angle,
      vertexDisplacementPx: Math.max(...vertexDisplacement(filtered, path)),
      rawVertexDisplacementPx: Math.max(...vertexDisplacement(observed, path)),
    };
  });
}

export function zigzag(): Path {
  const pts = [];
  for (let i = 0; i < 7; i++) pts.push({ x: 400 + i * 60, y: i % 2 === 0 ? 300 : 380 });
  return polyline('zigzag', pts, 300);
}
