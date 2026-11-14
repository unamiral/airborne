/**
 * Gesture features on REAL model output: landmarks produced by the pinned
 * MediaPipe model (CPU delegate) on MediaPipe test photos
 * (tests/e2e/bench/real-landmarks.spec.ts writes the fixture). Still images,
 * not camera video; no pinching hands are included in this small set.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/app/config';
import { parseReplay } from '../../src/dev/replay-format';
import { extractFeatures } from '../../src/tracking/features';

const raw = JSON.parse(readFileSync('tests/fixtures/real/model-on-images.json', 'utf8')) as {
  imageSizes: Array<{ width: number; height: number }>;
};
const parsed = parseReplay(raw);
if (!parsed.ok) throw new Error(parsed.errors.join('; '));
const record = parsed.record;

function features(image: string) {
  const i = record.scenario.tags.indexOf(image);
  const size = raw.imageSizes[i]!;
  return record.frames[i]!.hands.map((h) => extractFeatures(h, size.width, size.height));
}

describe('features on real model landmarks', () => {
  it('validates the fixture against the pinned model', () => {
    expect(record.source).toBe('model-on-image');
    expect(record.backend.modelSha256).toMatch(/^fbc2a300/);
  });

  it('classifies the fist photo as a fist and not as a pinch pose', () => {
    const [f] = features('fist.jpg');
    expect(f!.valid).toBe(true);
    expect(f!.fist).toBe(true);
    expect(f!.pinchPose).toBe(false);
  });

  it('does not call open hands, pointing, or a victory sign a fist', () => {
    for (const image of ['right_hands.jpg', 'pointing_up.jpg', 'victory.jpg']) {
      for (const f of features(image)) {
        expect(f.valid, image).toBe(true);
        expect(f.fist, image).toBe(false);
      }
    }
  });

  it('sees open hands as clearly released (ratio above the up threshold)', () => {
    for (const f of features('right_hands.jpg')) expect(f.pinchRatio).toBeGreaterThan(DEFAULT_CONFIG.gesture.pinchUpRatio);
  });

  it('keeps the open-hand, pointing, and victory fixtures outside the default writing start distance', () => {
    for (const image of ['right_hands.jpg', 'pointing_up.jpg', 'victory.jpg']) {
      for (const f of features(image)) {
        expect(f.writingProximity?.ratio, image).toBeGreaterThan(DEFAULT_CONFIG.gesture.writeStartRatio);
        expect(f.writingProximity?.aligned, image).toBe(false);
      }
    }
  });

  it('documents a known consequence: a thumbs-up counts as a fist (four curled fingers)', () => {
    const [f] = features('thumb_up.jpg');
    expect(f!.fist).toBe(true);
  });
});
