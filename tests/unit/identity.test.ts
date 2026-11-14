import { describe, expect, it } from 'vitest';
import { DEFAULT_IDENTITY_CONFIG, IdentityTracker, type Detection } from '../../src/tracking/identity';

const det = (x: number, y: number, size = 60, handedness: Detection['handedness'] = 'Unknown'): Detection => ({
  palm: { x, y },
  palmSize: size,
  handedness,
  handednessScore: 0.9,
});

describe('hand identity (F07)', () => {
  it('keeps ids stable when the detector reverses its output order', () => {
    const tr = new IdentityTracker();
    const a0 = tr.update(0, [det(100, 200), det(400, 200)]);
    const [left, right] = a0.trackIds;
    const a1 = tr.update(33, [det(405, 202), det(102, 199)]);
    expect(a1.trackIds).toEqual([right, left]);
    expect(a1.ambiguousTrackIds).toEqual([]);
  });

  it('follows moving hands using bounded velocity prediction', () => {
    const tr = new IdentityTracker();
    const [id] = tr.update(0, [det(100, 200)]).trackIds;
    let x = 100;
    for (let t = 33; t < 600; t += 33) {
      x += 25; // ~750 px/s in camera pixels
      const a = tr.update(t, [det(x, 200)]);
      expect(a.trackIds[0]).toBe(id);
      expect(a.newTrackIds).toEqual([]);
    }
  });

  it('declares ambiguity when crossing hands make both assignments similar', () => {
    const tr = new IdentityTracker();
    tr.update(0, [det(280, 200), det(360, 200)]);
    tr.update(33, [det(300, 200), det(340, 200)]);
    const a = tr.update(66, [det(318, 200), det(322, 200)]);
    expect(a.ambiguousTrackIds.length).toBe(2);
  });

  it('flags a single detection that could belong to either nearby track', () => {
    const tr = new IdentityTracker();
    tr.update(0, [det(300, 200), det(345, 200)]);
    const a = tr.update(33, [det(322, 200)]);
    expect(a.ambiguousTrackIds.length).toBe(2);
  });

  it('treats handedness only as weak evidence', () => {
    const tr = new IdentityTracker();
    const [id] = tr.update(0, [det(100, 200, 60, 'Left')]).trackIds;
    // Handedness flips but the hand is clearly the same one.
    const a = tr.update(33, [det(103, 201, 60, 'Right')]);
    expect(a.trackIds[0]).toBe(id);
  });

  it('starts a new track for an implausible jump or palm-size change (another person)', () => {
    const tr = new IdentityTracker();
    const [id] = tr.update(0, [det(100, 200, 60)]).trackIds;
    const far = tr.update(33, [det(560, 400, 60)]);
    expect(far.trackIds[0]).not.toBe(id);
    expect(far.newTrackIds).toHaveLength(1);
    const tr2 = new IdentityTracker();
    const [id2] = tr2.update(0, [det(100, 200, 60)]).trackIds;
    expect(tr2.update(33, [det(102, 200, 130)]).trackIds[0]).not.toBe(id2);
  });

  it('expires absent tracks after the expiry time and never reuses ids', () => {
    const tr = new IdentityTracker({ ...DEFAULT_IDENTITY_CONFIG, expiryMs: 250 });
    const [id] = tr.update(0, [det(100, 200)]).trackIds;
    expect(tr.update(200, []).expiredTrackIds).toEqual([]);
    expect(tr.update(260, []).expiredTrackIds).toEqual([id]);
    const again = tr.update(290, [det(100, 200)]);
    expect(again.trackIds[0]).not.toBe(id);
  });

  it('reacquires the same hand after a short dropout', () => {
    const tr = new IdentityTracker();
    const [id] = tr.update(0, [det(100, 200)]).trackIds;
    expect(tr.update(100, [det(110, 200)]).trackIds[0]).toBe(id);
  });
});
