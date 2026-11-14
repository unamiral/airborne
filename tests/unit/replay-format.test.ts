import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, DEFAULT_CONFIG } from '../../src/app/config';
import { REPLAY_SCHEMA_VERSION, parseReplay } from '../../src/dev/replay-format';
import { LANDMARK_VALUES } from '../../src/tracking/protocol';

const hand = () => ({
  landmarks: Array.from({ length: LANDMARK_VALUES }, () => 0.5),
  world: Array.from({ length: LANDMARK_VALUES }, () => 0.01),
  handedness: 'Left',
  handednessScore: 0.8,
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    schema: REPLAY_SCHEMA_VERSION,
    source: 'synthetic',
    createdAt: '2026-11-14T00:00:00Z',
    scenario: { name: 'test', description: 'd', tags: ['a'] },
    camera: { width: 640, height: 480 },
    surface: { width: 1280, height: 720, stripWidth: 120 },
    configVersion: CONFIG_VERSION,
    config: DEFAULT_CONFIG,
    backend: { delegate: 'synthetic', mediapipeVersion: '1.2.3', modelSha256: 'x' },
    frames: [
      { t: 0, ageMs: 20, hands: [hand()] },
      { t: 33, ageMs: 20, hands: [] },
    ],
    expected: { strokes: 0 },
    ...overrides,
  };
}

describe('replay record validation (F32)', () => {
  it('accepts a valid record', () => {
    const parsed = parseReplay(record());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.frames).toHaveLength(2);
      expect(parsed.record.config.gesture.pinchDownRatio).toBe(0.25);
    }
  });

  it('rejects unsupported schema versions', () => {
    const parsed = parseReplay(record({ schema: 2 }));
    expect(parsed.ok).toBe(false);
  });

  it('rejects non-increasing timestamps', () => {
    const parsed = parseReplay(record({ frames: [{ t: 10, ageMs: 1, hands: [] }, { t: 10, ageMs: 1, hands: [] }] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join()).toMatch(/strictly increase/);
  });

  it('rejects corrupt landmarks and too many hands', () => {
    const bad = hand();
    bad.landmarks = bad.landmarks.slice(1);
    expect(parseReplay(record({ frames: [{ t: 0, ageMs: 1, hands: [bad] }] })).ok).toBe(false);
    expect(parseReplay(record({ frames: [{ t: 0, ageMs: 1, hands: [hand(), hand(), hand()] }] })).ok).toBe(false);
  });

  it('migrates a version-1 embedded configuration', () => {
    const { lifecycle: _lifecycle, ...v1 } = { ...DEFAULT_CONFIG, version: 1 };
    const parsed = parseReplay(record({ configVersion: 1, config: v1 }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.record.config.lifecycle.hiddenStopMs).toBe(30_000);
    expect(parseReplay(record({ configVersion: 0, config: v1 })).ok).toBe(false);
  });

  it('rejects invalid embedded configuration', () => {
    const parsed = parseReplay(record({ config: { ...DEFAULT_CONFIG, reach: 3 } }));
    expect(parsed.ok).toBe(false);
  });

  it('enforces size and duration limits', () => {
    const frames = Array.from({ length: 11 }, (_, i) => ({ t: i * 1000, ageMs: 1, hands: [] }));
    expect(parseReplay(record({ frames }), { maxFrames: 10, maxDurationMs: 1e9 }).ok).toBe(false);
    expect(parseReplay(record({ frames }), { maxFrames: 100, maxDurationMs: 5000 }).ok).toBe(false);
  });

  it('rejects garbage input without throwing', () => {
    for (const junk of [null, 42, 'x', [], { schema: 1 }]) expect(parseReplay(junk).ok).toBe(false);
  });
});
