/**
 * Seeded synthetic signals with known ground truth (plan §14 "Synthetic
 * fixture suite"). Paths are functions of time in surface CSS pixels; a
 * sampler turns them into noisy observations at a given rate.
 */

/** mulberry32: small, fast, deterministic PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(random: () => number): () => number {
  return () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export interface P {
  x: number;
  y: number;
}

/** Ground truth: position at time t (ms) and the path duration. */
export interface Path {
  readonly name: string;
  readonly durationMs: number;
  at(t: number): P;
  /** Vertices that must be preserved (corners, stops), with their times. */
  readonly vertices?: ReadonlyArray<{ t: number; p: P }>;
}

const C = { x: 640, y: 360 };

export function stationary(durationMs = 3000): Path {
  return { name: 'stationary', durationMs, at: () => ({ ...C }) };
}

/** Straight line at `speed` px/s, starting and ending at rest. */
export function line(speed: number, angleDeg = 0, durationMs = 2000): Path {
  const a = (angleDeg * Math.PI) / 180;
  const len = (speed * durationMs) / 1000;
  const start = { x: C.x - (Math.cos(a) * len) / 2, y: C.y - (Math.sin(a) * len) / 2 };
  return {
    name: `line-${speed}`,
    durationMs,
    at: (t) => {
      const d = (speed * Math.min(Math.max(t, 0), durationMs)) / 1000;
      return { x: start.x + Math.cos(a) * d, y: start.y + Math.sin(a) * d };
    },
  };
}

export function circle(radius: number, periodMs: number, durationMs = periodMs * 1.5): Path {
  return {
    name: `circle-r${radius}`,
    durationMs,
    at: (t) => ({ x: C.x + radius * Math.cos((2 * Math.PI * t) / periodMs), y: C.y + radius * Math.sin((2 * Math.PI * t) / periodMs) }),
  };
}

export function sine(amplitude: number, wavelength: number, speed: number, durationMs = 2500): Path {
  return {
    name: `sine-a${amplitude}`,
    durationMs,
    at: (t) => {
      const x = (speed * t) / 1000;
      return { x: C.x - 400 + x, y: C.y + amplitude * Math.sin((2 * Math.PI * x) / wavelength) };
    },
  };
}

/** Polyline through `points` at constant speed (corners, zigzags, reversals). */
export function polyline(name: string, points: readonly P[], speed: number, pauseMs = 0): Path {
  const segs: Array<{ a: P; b: P; t0: number; t1: number }> = [];
  let t = 0;
  const vertices: Array<{ t: number; p: P }> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dur = (Math.hypot(b.x - a.x, b.y - a.y) / speed) * 1000;
    segs.push({ a, b, t0: t, t1: t + dur });
    t += dur;
    if (i + 2 < points.length) {
      vertices.push({ t, p: b });
      t += pauseMs;
    }
  }
  const durationMs = t;
  return {
    name,
    durationMs,
    vertices,
    at: (time) => {
      for (const s of segs) {
        if (time <= s.t1) {
          if (time < s.t0) return { ...s.a };
          const u = (time - s.t0) / Math.max(s.t1 - s.t0, 1e-9);
          return { x: s.a.x + (s.b.x - s.a.x) * u, y: s.a.y + (s.b.y - s.a.y) * u };
        }
      }
      const last = points[points.length - 1]!;
      return { ...last };
    },
  };
}

/**
 * Two arms meeting at a vertex with the given interior angle (45° is a sharp
 * turn back, 135° a gentle bend); the direction change is 180° − angle.
 */
export function corner(angleDeg: number, armPx = 160, speed = 300): Path {
  const theta = (angleDeg * Math.PI) / 180;
  const a = C;
  const v = { x: a.x + armPx, y: a.y };
  const b = { x: v.x - Math.cos(theta) * armPx, y: v.y + Math.sin(theta) * armPx };
  return polyline(`corner-${angleDeg}`, [a, v, b], speed);
}

export interface Sample {
  t: number;
  x: number;
  y: number;
}

export interface SamplerOptions {
  readonly rateHz: number;
  readonly noisePx: number;
  readonly seed: number;
  /** Uniform timing jitter as a fraction of the interval. */
  readonly jitter?: number;
  /** Probability of emitting a duplicate timestamp. */
  readonly duplicateRate?: number;
  /** Time ranges [start, end) in ms with no samples. */
  readonly drops?: ReadonlyArray<readonly [number, number]>;
}

export function sample(path: Path, opts: SamplerOptions): { observed: Sample[]; truth: Sample[] } {
  const random = rng(opts.seed);
  const g = gaussian(random);
  const interval = 1000 / opts.rateHz;
  const observed: Sample[] = [];
  const truth: Sample[] = [];
  for (let k = 0; ; k++) {
    const jitter = (opts.jitter ?? 0) * interval * (random() - 0.5);
    const t = k * interval + jitter;
    if (t > path.durationMs) break;
    if (opts.drops?.some(([a, b]) => t >= a && t < b) === true) continue;
    const p = path.at(t);
    truth.push({ t, ...p });
    observed.push({ t, x: p.x + g() * opts.noisePx, y: p.y + g() * opts.noisePx });
    if ((opts.duplicateRate ?? 0) > 0 && random() < opts.duplicateRate!) {
      observed.push({ t, x: p.x + g() * opts.noisePx, y: p.y + g() * opts.noisePx });
    }
  }
  return { observed, truth };
}

// ---------------------------------------------------------------------------
// Metrics

export function rmsError(samples: readonly Sample[], truth: (t: number) => P, fromMs = 0): number {
  let sum = 0;
  let n = 0;
  for (const s of samples) {
    if (s.t < fromMs) continue;
    const p = truth(s.t);
    sum += (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : Number.NaN;
}

/**
 * Best time shift (ms) aligning filtered output with ground truth: the lag
 * that minimises mean squared error of output(t) vs truth(t - lag).
 */
export function bestLag(output: readonly Sample[], path: Path, maxLagMs = 200, stepMs = 1): number {
  let best = 0;
  let bestErr = Infinity;
  for (let lag = 0; lag <= maxLagMs; lag += stepMs) {
    let sum = 0;
    let n = 0;
    for (const s of output) {
      const tt = s.t - lag;
      if (tt < 0 || tt > path.durationMs) continue;
      const p = path.at(tt);
      sum += (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
      n++;
    }
    const err = n > 0 ? sum / n : Infinity;
    if (err < bestErr) {
      bestErr = err;
      best = lag;
    }
  }
  return best;
}

export function percentileOf(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return s[lo]! + (s[hi]! - s[lo]!) * (rank - lo);
}

/** Spatial error of each output point vs truth shifted by `lagMs`. */
export function shapeErrors(output: readonly Sample[], path: Path, lagMs: number, settleMs = 0): number[] {
  const errs: number[] = [];
  for (const s of output) {
    const tt = s.t - lagMs;
    if (tt < settleMs || tt > path.durationMs) continue;
    const p = path.at(tt);
    errs.push(Math.hypot(s.x - p.x, s.y - p.y));
  }
  return errs;
}

function pointSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const u = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

/**
 * Distance from each ground-truth vertex to the output polyline (not to the
 * nearest sample, which would mostly measure sampling phase).
 */
export function vertexDisplacement(output: readonly P[], path: Path): number[] {
  return (path.vertices ?? []).map(({ p }) => {
    let best = Infinity;
    for (let i = 0; i + 1 < output.length; i++) best = Math.min(best, pointSegment(p, output[i]!, output[i + 1]!));
    return best;
  });
}
