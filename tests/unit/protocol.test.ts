import { describe, expect, it } from 'vitest';
import { LANDMARK_VALUES, PROTOCOL_VERSION, parseWorkerMessage } from '../../src/tracking/protocol';

const hand = () => ({
  landmarks: Array.from({ length: LANDMARK_VALUES }, (_, i): number => (i % 3 === 2 ? 0 : 0.5)),
  world: Array.from({ length: LANDMARK_VALUES }, () => 0.01),
  handedness: 'Left',
  handednessScore: 0.9,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  epoch: 1,
  seq: 3,
  sourceTimeMs: 1000,
  inferenceMs: 12,
  hands: [hand()],
  ...overrides,
});

describe('worker protocol validation', () => {
  it('accepts a well-formed result', () => {
    const parsed = parseWorkerMessage(result());
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'result') {
      expect(parsed.message.hands).toHaveLength(1);
      expect(parsed.message.hands[0]!.handedness).toBe('Left');
    }
  });

  it('rejects a result with any non-finite landmark', () => {
    const bad = hand();
    bad.landmarks[10] = Number.NaN;
    expect(parseWorkerMessage(result({ hands: [bad] })).ok).toBe(false);
    const inf = hand();
    inf.world[0] = Number.POSITIVE_INFINITY;
    expect(parseWorkerMessage(result({ hands: [inf] })).ok).toBe(false);
  });

  it('rejects wrong landmark counts, extra hands, and bad identifiers', () => {
    const short = hand();
    short.landmarks.pop();
    expect(parseWorkerMessage(result({ hands: [short] })).ok).toBe(false);
    expect(parseWorkerMessage(result({ hands: [hand(), hand(), hand()] })).ok).toBe(false);
    expect(parseWorkerMessage(result({ seq: -1 })).ok).toBe(false);
    expect(parseWorkerMessage(result({ epoch: 1.5 })).ok).toBe(false);
    expect(parseWorkerMessage(result({ sourceTimeMs: Number.NaN })).ok).toBe(false);
    const handed = hand();
    handed.handedness = 'Both';
    expect(parseWorkerMessage(result({ hands: [handed] })).ok).toBe(false);
  });

  it('rejects unknown and untyped messages', () => {
    expect(parseWorkerMessage({ type: 'surprise' }).ok).toBe(false);
    expect(parseWorkerMessage(null).ok).toBe(false);
    expect(parseWorkerMessage('ready').ok).toBe(false);
  });

  it('validates ready and init-error messages', () => {
    const ready = {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      backend: 'GPU',
      timings: { modelFetchMs: 1, modelVerifyMs: 1, createMs: 1, warmupMs: [1, 2] },
    };
    expect(parseWorkerMessage(ready).ok).toBe(true);
    expect(parseWorkerMessage({ ...ready, protocol: PROTOCOL_VERSION + 1 }).ok).toBe(false);
    expect(parseWorkerMessage({ ...ready, backend: 'TPU' }).ok).toBe(false);
    expect(parseWorkerMessage({ type: 'init-error', code: 'model-integrity', delegate: 'CPU', message: 'x' }).ok).toBe(true);
    expect(parseWorkerMessage({ type: 'init-error', code: 'nope', delegate: 'CPU' }).ok).toBe(false);
  });
});
