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

  it('places the pen at the thumb/index tip midpoint', () => {
    const f = at(POSES.pinch(0.2), { penU: 0.3, penV: 0.6 });
    expect(f.pen.x).toBeCloseTo(0.3, 9);
    expect(f.pen.y).toBeCloseTo(0.6, 9);
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
