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

  it('is isotropic: equal camera-pixel motion gives equal surface motion on both axes', () => {
    const a = m.toSurface(0.5, 0.5).point;
    const bx = m.toSurface(0.5 - 10 / 640, 0.5).point; // 10 camera px horizontally
    const by = m.toSurface(0.5, 0.5 + 10 / 480).point; // 10 camera px vertically
    expect(Math.abs(bx.x - a.x)).toBeCloseTo(Math.abs(by.y - a.y), 9);
    expect(m.cameraLengthToSurface(10)).toBeCloseTo(Math.abs(bx.x - a.x), 9);
  });

  it('uses the central reach fraction of camera width when the surface is wider than the camera', () => {
    expect(m.rect.u1 - m.rect.u0).toBeCloseTo(0.7, 9);
    // Height follows the surface aspect: 448 px wide * 720/1280 = 252 px of 480.
    expect(m.rect.v1 - m.rect.v0).toBeCloseTo(252 / 480, 9);
  });

  it('fits by height for tall surfaces and 16:9 cameras', () => {
    const tall = new SurfaceMapping({ cameraWidth: 1280, cameraHeight: 720, surfaceWidth: 600, surfaceHeight: 900, reach: 0.7 });
    expect(tall.rect.v1 - tall.rect.v0).toBeCloseTo(0.7, 9);
    const w = (tall.rect.u1 - tall.rect.u0) * 1280;
    const h = (tall.rect.v1 - tall.rect.v0) * 720;
    expect(w / h).toBeCloseTo(600 / 900, 9);
  });

  it('reports out-of-reach positions without clamping them to the edge', () => {
    const out = m.toSurface(0.02, 0.5);
    expect(out.inReach).toBe(false);
    expect(out.point.x).toBeGreaterThan(1280);
    expect(m.toSurface(0.5, 0.5).inReach).toBe(true);
  });

  it('honours the reach setting range', () => {
    const near = new SurfaceMapping({ cameraWidth: 640, cameraHeight: 480, surfaceWidth: 1280, surfaceHeight: 720, reach: 0.5 });
    const far = new SurfaceMapping({ cameraWidth: 640, cameraHeight: 480, surfaceWidth: 1280, surfaceHeight: 720, reach: 0.9 });
    expect(near.scale).toBeGreaterThan(far.scale);
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
