import { describe, expect, it } from 'vitest';
import { SurfaceMapping, cameraPixelDistance } from '../../src/input/mapping';
import { containFit } from '../../src/ui/preview';

describe('camera → surface mapping (F06)', () => {
  const m = new SurfaceMapping({ cameraWidth: 640, cameraHeight: 480, surfaceWidth: 1280, surfaceHeight: 720, reach: 0.7 });

  it('maps the reach rectangle corners and centre, mirroring exactly once', () => {
    const { u0, u1, v0, v1 } = m.rect;
    // Camera-left (u0) is the user's right after mirroring: surface right edge.
    expect(m.toSurface(u0, v0).point.x).toBeCloseTo(1280, 9);
    expect(m.toSurface(u1, v0).point.x).toBeCloseTo(0, 9);
    expect(m.toSurface(u1, v0).point.y).toBeCloseTo(0, 9);
    expect(m.toSurface(u0, v1).point.y).toBeCloseTo(720, 9);
    const c = m.toSurface(0.5, 0.5).point;
    expect(c.x).toBeCloseTo(640, 9);
    expect(c.y).toBeCloseTo(360, 9);
  });

  it('moves the cursor right when the hand moves to the user’s right (camera left)', () => {
    expect(m.toSurface(0.4, 0.5).point.x).toBeGreaterThan(m.toSurface(0.6, 0.5).point.x);
  });

  it('maps every camera corner onto the surface at every sensitivity', () => {
    for (const reach of [0.5, 0.7, 0.9]) {
      const mapping = new SurfaceMapping({ cameraWidth: 640, cameraHeight: 480, surfaceWidth: 1280, surfaceHeight: 720, reach });
      expect(mapping.rect).toEqual({ u0: 0, u1: 1, v0: 0, v1: 1 });
      for (const [u, v, x, y] of [[0, 0, 1280, 0], [1, 0, 0, 0], [0, 1, 1280, 720], [1, 1, 0, 720]]) {
        const result = mapping.toSurface(u!, v!);
        expect(result.inReach).toBe(true);
        expect(result.point.x).toBeCloseTo(x!, 9);
        expect(result.point.y).toBeCloseTo(y!, 9);
      }
    }
  });

  it('changes sensitivity near the centre without changing the capture area', () => {
    const low = new SurfaceMapping({ cameraWidth: 640, cameraHeight: 480, surfaceWidth: 1280, surfaceHeight: 720, reach: 0.9 });
    const high = new SurfaceMapping({ cameraWidth: 640, cameraHeight: 480, surfaceWidth: 1280, surfaceHeight: 720, reach: 0.5 });
    expect(Math.abs(low.toSurface(0.45, 0.5).point.x - 640)).toBeLessThan(Math.abs(high.toSurface(0.45, 0.5).point.x - 640));
    expect(low.toSurface(-0.01, 0.5).inReach).toBe(false);
    expect(low.toSurface(0.5, 1.01).inReach).toBe(false);
    expect(() => new SurfaceMapping({ cameraWidth: 0, cameraHeight: 480, surfaceWidth: 1, surfaceHeight: 1, reach: 0.7 })).toThrow();
  });

  it('measures image distances in actual camera pixels', () => {
    expect(cameraPixelDistance(0, 0, 0.1, 0, 640, 480)).toBeCloseTo(64, 9);
    expect(cameraPixelDistance(0, 0, 0, 0.1, 640, 480)).toBeCloseTo(48, 9);
  });
});

describe('preview letterboxing', () => {
  it('fits 4:3 video into a 4:3 box exactly and letterboxes 16:9', () => {
    expect(containFit(640, 480, 120, 90)).toEqual({ scale: 120 / 640, offsetX: 0, offsetY: 0 });
    const f = containFit(1280, 720, 120, 90);
    expect(f.scale).toBeCloseTo(120 / 1280, 9);
    expect(f.offsetX).toBe(0);
    expect(f.offsetY).toBeCloseTo((90 - 720 * (120 / 1280)) / 2, 9);
    expect(containFit(0, 0, 10, 10).scale).toBe(0);
  });
});
