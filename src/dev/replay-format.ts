/**
 * Replay record contract (plan §5 "Replay record", §14 fixtures). Used by
 * development recording/replay and by tests; never bundled in production.
 *
 * A record holds tracking results downstream of inference: replay exercises
 * identity, features, filtering, the gesture reducer and the board, but not
 * the detector or the camera.
 */
import { CONFIG_VERSION, migrateConfig, validateConfig, type AppConfig } from '../app/config';
import { LANDMARK_VALUES, type HandPayload } from '../tracking/protocol';

export const REPLAY_SCHEMA_VERSION = 1;

export type ReplaySource = 'synthetic' | 'recorded' | 'model-on-image';

export interface ReplayFrame {
  /** Source timeline, ms; strictly increasing. */
  readonly t: number;
  /**
   * Software result age when recorded (main-thread receive minus frame
   * observation), ms. Synthetic fixtures use a nominal value.
   */
  readonly ageMs: number;
  readonly hands: readonly HandPayload[];
}

/** Outcome assertions checked by the replay harness. */
export interface ReplayExpectations {
  readonly strokes?: number;
  readonly dots?: number;
  readonly erasedStrokes?: number;
  readonly transforms?: number;
  /** Ordered reducer event kinds that must appear as a subsequence. */
  readonly events?: readonly string[];
  /** Event kinds that must never appear. */
  readonly forbiddenEvents?: readonly string[];
}

export interface ReplayRecord {
  readonly schema: number;
  readonly source: ReplaySource;
  readonly createdAt: string;
  readonly scenario: { readonly name: string; readonly description: string; readonly tags: readonly string[] };
  readonly camera: { readonly width: number; readonly height: number };
  /** Interaction surface (CSS px) and control-strip width used when recording. */
  readonly surface: { readonly width: number; readonly height: number; readonly stripWidth: number };
  readonly configVersion: number;
  readonly config: AppConfig;
  readonly backend: { readonly delegate: string; readonly mediapipeVersion: string; readonly modelSha256: string };
  readonly frames: readonly ReplayFrame[];
  readonly expected: ReplayExpectations;
}

export interface ReplayLimits {
  readonly maxFrames: number;
  readonly maxDurationMs: number;
}

/** Bounded so a corrupt or huge file cannot exhaust memory during replay. */
export const DEFAULT_REPLAY_LIMITS: ReplayLimits = { maxFrames: 60 * 60 * 10, maxDurationMs: 10 * 60 * 1000 };

export type ReplayParse = { readonly ok: true; readonly record: ReplayRecord } | { readonly ok: false; readonly errors: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPositive = (v: unknown): v is number => isFinite(v) && v > 0;

function parseHands(value: unknown, where: string, errors: string[]): HandPayload[] {
  if (!Array.isArray(value) || value.length > 2) {
    errors.push(`${where}: hands must be an array of at most 2`);
    return [];
  }
  const hands: HandPayload[] = [];
  value.forEach((h: unknown, i) => {
    if (!isRecord(h)) {
      errors.push(`${where}.hands[${i}]: expected an object`);
      return;
    }
    const ok = (arr: unknown): arr is number[] =>
      Array.isArray(arr) && arr.length === LANDMARK_VALUES && arr.every((n) => isFinite(n));
    if (!ok(h.landmarks) || !ok(h.world)) {
      errors.push(`${where}.hands[${i}]: landmarks/world must be ${LANDMARK_VALUES} finite numbers`);
      return;
    }
    const handedness = h.handedness === 'Left' || h.handedness === 'Right' ? h.handedness : 'Unknown';
    const score = isFinite(h.handednessScore) ? Math.min(1, Math.max(0, h.handednessScore)) : 0;
    hands.push({ landmarks: h.landmarks, world: h.world, handedness, handednessScore: score });
  });
  return hands;
}

/** Validates a parsed JSON value as a replay record. */
export function parseReplay(value: unknown, limits: ReplayLimits = DEFAULT_REPLAY_LIMITS): ReplayParse {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['replay: expected an object'] };
  if (value.schema !== REPLAY_SCHEMA_VERSION) {
    return { ok: false, errors: [`replay: unsupported schema ${String(value.schema)} (expected ${REPLAY_SCHEMA_VERSION})`] };
  }
  const source = value.source;
  if (source !== 'synthetic' && source !== 'recorded' && source !== 'model-on-image') errors.push('source: invalid');
  const scenario = isRecord(value.scenario) ? value.scenario : null;
  if (scenario === null || typeof scenario.name !== 'string' || scenario.name === '') errors.push('scenario.name: required');
  const camera = isRecord(value.camera) ? value.camera : null;
  if (camera === null || !isPositive(camera.width) || !isPositive(camera.height)) errors.push('camera: width/height required');
  const surface = isRecord(value.surface) ? value.surface : null;
  if (surface === null || !isPositive(surface.width) || !isPositive(surface.height) || !isFinite(surface.stripWidth)) {
    errors.push('surface: width/height/stripWidth required');
  }
  if (value.configVersion !== CONFIG_VERSION && value.configVersion !== 1) {
    errors.push(`configVersion: expected 1..${CONFIG_VERSION}`);
  }
  const config = validateConfig(migrateConfig(value.configVersion, value.config));
  if (!config.ok) errors.push(...config.errors.map((e) => `config.${e}`));
  const backend = isRecord(value.backend) ? value.backend : null;
  if (backend === null || typeof backend.delegate !== 'string' || typeof backend.modelSha256 !== 'string') {
    errors.push('backend: delegate/modelSha256 required');
  }
  const frames: ReplayFrame[] = [];
  if (!Array.isArray(value.frames)) {
    errors.push('frames: expected an array');
  } else if (value.frames.length > limits.maxFrames) {
    errors.push(`frames: ${value.frames.length} exceeds limit ${limits.maxFrames}`);
  } else {
    let last = -Infinity;
    (value.frames as unknown[]).forEach((f, i) => {
      if (!isRecord(f) || !isFinite(f.t) || !isFinite(f.ageMs)) {
        errors.push(`frames[${i}]: t and ageMs must be finite`);
        return;
      }
      if (!(f.t > last)) errors.push(`frames[${i}]: timestamps must strictly increase`);
      last = f.t;
      frames.push({ t: f.t, ageMs: f.ageMs, hands: parseHands(f.hands, `frames[${i}]`, errors) });
    });
    const first = frames[0];
    const final = frames[frames.length - 1];
    if (first !== undefined && final !== undefined && final.t - first.t > limits.maxDurationMs) {
      errors.push(`frames: duration exceeds ${limits.maxDurationMs} ms`);
    }
  }
  const expected = isRecord(value.expected) ? (value.expected as ReplayExpectations) : {};
  if (errors.length > 0 || !config.ok) return { ok: false, errors: errors.slice(0, 20) };
  return {
    ok: true,
    record: {
      schema: REPLAY_SCHEMA_VERSION,
      source: source as ReplaySource,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
      scenario: {
        name: String(scenario!.name),
        description: typeof scenario!.description === 'string' ? scenario!.description : '',
        tags: Array.isArray(scenario!.tags) ? (scenario!.tags as unknown[]).map(String) : [],
      },
      camera: { width: Number(camera!.width), height: Number(camera!.height) },
      surface: { width: Number(surface!.width), height: Number(surface!.height), stripWidth: Number(surface!.stripWidth) },
      configVersion: CONFIG_VERSION,
      config: config.config,
      backend: {
        delegate: String(backend!.delegate),
        mediapipeVersion: typeof backend!.mediapipeVersion === 'string' ? backend!.mediapipeVersion : '',
        modelSha256: String(backend!.modelSha256),
      },
      frames,
      expected,
    },
  };
}
