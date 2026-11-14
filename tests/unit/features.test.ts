import { describe, expect, it } from 'vitest';
import { extractFeatures } from '../../src/tracking/features';
import { LANDMARK_VALUES } from '../../src/tracking/protocol';
import { POSES, handAt, withRotation, type Pose } from '../support/hands';

const at = (pose: Pose, extra: Parameters<typeof handAt>[1] = { penU: 0.5, penV: 0.5 }) =>
  extractFeatures(handAt(pose, extra), extra.cameraWidth ?? 640, extra.cameraHeight ?? 480);

describe('hand features', () => {
  it('measures pinch ratio from world landmarks within one hand', () => {
    expect(at(POSES.pinch(0.12)).pinchRatio).toBeCloseTo(0.12, 3);
    expect(at(POSES.pinch(0.3)).pinchRatio).toBeCloseTo(0.3, 3);
    expect(at(POSES.open).pinchRatio).toBeGreaterThan(0.4);
  });

  it('places the pen at the index fingertip', () => {
    const f = at(POSES.pinch(0.2), { penU: 0.3, penV: 0.6 });
    expect(f.pen.x).toBeCloseTo(0.3, 9);
    expect(f.pen.y).toBeCloseTo(0.6, 9);
  });

  it('measures a nonzero gap in palm lengths for both hands at different distances and angles', () => {
    for (const handedness of ['Left', 'Right'] as const) {
      for (const palmPx of [24, 60, 115]) {
        for (const [roll, pitch, yaw] of [[0, 0, 0], [55, 20, 30], [-45, 54, 20]] as const) {
          const pose = withRotation(POSES.writing(), roll, pitch, yaw);
          const options = { penU: 0.5, penV: 0.5, palmPx, handedness };
          const proximity = at(pose, options).writingProximity;
          expect(proximity?.space).toBe('world');
          expect(proximity?.ratio).toBeCloseTo(0.24, 6);
          // Changing index flexion does not affect activation.
          expect(at({ ...pose, index: POSES.relaxed.index }, options).writingProximity?.ratio).toBeCloseTo(0.24, 6);
        }
      }
    }
  });

  it('recognizes extended digits pointing together with the other fingers extended', () => {
    for (const handedness of ['Left', 'Right'] as const) {
      const pose = withRotation(POSES.aligned, 45, 25, -20);
      const options = { penU: 0.5, penV: 0.5, palmPx: 35, handedness };
      const features = at(pose, options);
      expect(features.writingProximity?.aligned).toBe(true);
      expect(features.writingProximity?.ratio).toBeGreaterThan(0.55);
      expect(at({ ...pose, thumb: 'open' }, options).writingProximity?.aligned).toBe(false);
      expect(at({ ...pose, middle: POSES.fist.middle }, options).writingProximity?.aligned).toBe(false);
      expect(at({ ...pose, index: POSES.fist.index }, options).writingProximity?.aligned).toBe(false);
      const hand = handAt(POSES.aligned, options);
      expect(extractFeatures({ ...hand, world: [] }, 640, 480).writingProximity?.aligned).toBe(true);
    }
  });

  it('uses aspect-corrected image distances when world data is unavailable', () => {
    for (const [cameraWidth, cameraHeight] of [[640, 480], [1280, 720]] as const) {
      for (const palmPx of [24, 115]) {
        const hand = handAt(POSES.writing(), { penU: 0.5, penV: 0.5, palmPx, cameraWidth, cameraHeight });
        const result = extractFeatures({ ...hand, world: [] }, cameraWidth, cameraHeight);
        expect(result.valid).toBe(true);
        expect(result.writingProximity?.space).toBe('image');
        expect(result.writingProximity?.ratio).toBeCloseTo(0.24 * Math.hypot(0.85, 0.5) / Math.hypot(0.85, 0.5, 0.15), 6);
        const flatWorld = hand.world.map(() => 0);
        expect(extractFeatures({ ...hand, world: flatWorld }, cameraWidth, cameraHeight).writingProximity?.space).toBe('image');
        const clipped = [...hand.landmarks];
        clipped[4 * 3] = -0.01;
        expect(extractFeatures({ ...hand, landmarks: clipped, world: [] }, cameraWidth, cameraHeight).writingProximity).toBeNull();
      }
    }
  });

  it('recognizes extended hands through roll, pitch and yaw while excluding writing and fists', () => {
    for (const [roll, pitch, yaw] of [[0, 0, 0], [35, -20, 30], [-25, 35, -60], [10, 0, 75]] as const) {
      expect(at(withRotation(POSES.open, roll, pitch, yaw)).extended).toBe(true);
      expect(at(withRotation(POSES.writing(), roll, pitch, yaw)).extended).toBe(false);
      expect(at(withRotation(POSES.fist, roll, pitch, yaw)).extended).toBe(false);
      expect(at(withRotation(POSES.fist, roll, pitch, yaw)).fist).toBe(true);
    }
  });

  it('accepts a plausible pinch pose and rejects thumb/index proximity inside a fist', () => {
    expect(at(POSES.pinch()).pinchPose).toBe(true);
    expect(at(POSES.tightPinch()).pinchPose).toBe(true);
    const fist = at(POSES.fist);
    expect(fist.fist).toBe(true);
    expect(fist.pinchPose).toBe(false);
  });

  it('detects fists from bend angles and tip-to-palm distance, robust to rotation', () => {
    for (const [roll, pitch, yaw] of [
      [0, 0, 0],
      [45, 0, 0],
      [90, 0, 0],
      [-60, 30, 0],
      [0, 50, 40],
      [180, 0, 0],
    ] as const) {
      expect(at(withRotation(POSES.fist, roll, pitch, yaw)).fist, `fist ${roll}/${pitch}/${yaw}`).toBe(true);
      expect(at(withRotation(POSES.open, roll, pitch, yaw)).fist, `open ${roll}/${pitch}/${yaw}`).toBe(false);
      expect(at(withRotation(POSES.pinch(), roll, pitch, yaw)).fist, `pinch ${roll}/${pitch}/${yaw}`).toBe(false);
    }
  });

  it('does not call partial curls, pointing, or pinching hands a fist', () => {
    expect(at(POSES.halfCurl).fist).toBe(false);
    expect(at(POSES.relaxed).fist).toBe(false);
    expect(at(POSES.pointing).fist).toBe(false);
    expect(at(POSES.tightPinch()).fist).toBe(false);
  });

  it('measures palm size in actual camera pixels for 4:3 and 16:9 frames', () => {
    const a = at(POSES.open, { penU: 0.5, penV: 0.5, palmPx: 70, cameraWidth: 640, cameraHeight: 480 });
    const b = at(POSES.open, { penU: 0.5, penV: 0.5, palmPx: 70, cameraWidth: 1280, cameraHeight: 720 });
    expect(a.palmSizePx).toBeCloseTo(70, 6);
    expect(b.palmSizePx).toBeCloseTo(70, 6);
    expect(a.palmScaleM).toBeCloseTo(0.09, 6);
  });

  it('flags degenerate or implausible hands as invalid', () => {
    const flat = { landmarks: new Array<number>(LANDMARK_VALUES).fill(0.5), world: new Array<number>(LANDMARK_VALUES).fill(0), handedness: 'Left' as const, handednessScore: 1 };
    const f = extractFeatures(flat, 640, 480);
    expect(f.valid).toBe(false);
    const tiny = at(POSES.open, { penU: 0.5, penV: 0.5, palmPx: 3 });
    expect(tiny.valid).toBe(false);
    expect(tiny.invalidReason).toBe('hand too small');
  });
});
