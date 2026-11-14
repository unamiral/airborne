/**
 * F08 hover/cursor and loss behavior at the orchestration level (no DOM):
 * cursor position, diameter, color, and mode; no stale cursor after loss.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/app/config';
import { HandInput } from '../../src/app/hand-input';
import { Metrics } from '../../src/app/metrics';
import { BoardController } from '../../src/board/controller';
import { regionFromLayout } from '../../src/tracking/hand-pipeline';
import { POSES, handAt } from '../support/hands';
import { CAMERA, SURFACE, surfaceToCamera } from '../support/scenarios';

function setup(config = DEFAULT_CONFIG) {
  const controller = new BoardController(config);
  let now = 0;
  const hands = new HandInput({
    config: () => config,
    controller: () => controller,
    activateControl: () => undefined,
    metrics: new Metrics(),
    now: () => now,
    onUpdate: () => undefined,
  });
  const board = { x: SURFACE.stripWidth, y: 0, width: SURFACE.width - SURFACE.stripWidth, height: SURFACE.height };
  hands.setLayout({ width: SURFACE.width, height: SURFACE.height, board, hitTest: regionFromLayout(board, [], SURFACE.width, SURFACE.height) });
  hands.setCamera(CAMERA);
  let t = 0;
  const feed = (pose = POSES.open, x = 600, y = 300, ageMs = 20) => {
    t += 33;
    now = Math.max(now + 1, t + ageMs);
    const cam = surfaceToCamera(x, y);
    hands.handleResult(t, [handAt(pose, { penU: cam.u, penV: cam.v, seed: t })], now - ageMs);
  };
  return { hands, controller, feed, setNow: (n: number) => (now = n), time: () => t, now: () => now };
}

describe('hover cursor (F08)', () => {
  it('follows the filtered pen with the pen color and actual diameter, in board coordinates', () => {
    const s = setup();
    s.controller.setColor('#d93025');
    s.controller.setWidth(6);
    for (let i = 0; i < 10; i++) s.feed();
    const [c] = s.hands.cursors();
    expect(c).toBeDefined();
    expect(c!.mode).toBe('hover');
    expect(c!.color).toBe('#d93025');
    expect(c!.diameter).toBe(6);
    expect(c!.x).toBeCloseTo(600 - SURFACE.stripWidth, 0);
    expect(c!.y).toBeCloseTo(300, 0);
    expect(s.controller.doc.strokeCount).toBe(0); // hover never draws
  });

  it('switches to draw with the writing pose, and the label reflects the mode', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed();
    expect(s.hands.label).toBe('Hover');
    for (let i = 0; i < 3; i++) s.feed(POSES.writing(), 600 + i * 4);
    expect(s.hands.label).toBe('Draw');
    expect(s.hands.cursors()[0]!.mode).toBe('draw');
  });

  it('writes with a non-contact thumb-to-middle gap and stops on separation', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed(POSES.open);
    for (let i = 0; i < 6; i++) s.feed(POSES.pinch(), 600 + i * 4);
    expect(s.controller.doc.strokeCount).toBe(0);
    expect(s.controller.active).toBeNull();
    for (let i = 0; i < 6; i++) s.feed(POSES.writing(), 624 + i * 4);
    expect(s.hands.label).toBe('Draw');
    for (let i = 0; i < 6; i++) s.feed(POSES.open, 650 + i * 4);
    expect(s.controller.doc.strokeCount).toBe(1);
    expect(s.controller.active).toBeNull();
    for (let i = 0; i < 6; i++) s.feed({ ...POSES.pointing, thumb: 'open' }, 700 + i * 4);
    expect(s.controller.doc.strokeCount).toBe(1);
    expect(s.controller.active).toBeNull();
  });

  it('writes with three extended digits and lifts the pen when the thumb angles away', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed(POSES.open);
    s.feed(POSES.aligned, 600);
    expect(s.controller.active).toBeNull();
    for (let i = 1; i <= 5; i++) s.feed(POSES.aligned, 600 + i * 8);
    expect(s.hands.label).toBe('Draw');
    expect(s.hands.cursors()[0]!.x).toBeGreaterThan(600 - SURFACE.stripWidth);
    s.feed(POSES.open, 700);
    expect(s.controller.active).toBeNull();
    expect(s.controller.doc.strokeCount).toBe(1);
    expect(s.controller.doc.strokes[0]!.bounds.maxX).toBeLessThan(650 - SURFACE.stripWidth);
  });

  it('shows no live cursor and reports tracking lost once results go stale', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed();
    s.hands.checkLoss(s.time() + 20 + 150);
    expect(s.hands.label).toBe('Tracking lost');
    expect(s.hands.cursors()).toEqual([]);
  });

  it('marks a hand that appeared in the writing pose as blocked until it opens', () => {
    const s = setup();
    s.feed(POSES.writing());
    expect(s.hands.cursors()[0]!.mode).toBe('blocked');
    s.feed(POSES.open);
    expect(s.hands.cursors()[0]!.mode).toBe('hover');
  });

  it('keeps a stroke through a late delivery and a borderline release reading', () => {
    const s = setup();
    s.feed();
    s.feed(POSES.writing());
    s.feed(POSES.writing());
    s.feed(POSES.writing());
    const active = s.controller.active;
    expect(active).not.toBeNull();

    // The recording had a 100.3 ms result while the hand was still writing,
    // and a 0.524 release reading that fell back below the former threshold.
    s.feed(POSES.writing(), 604, 300, 100.3);
    s.feed(POSES.writing(0.524), 608);
    expect(s.controller.active).toBe(active);
    s.feed(POSES.writing(0.57), 700);
    expect(s.controller.active).toBeNull();
    expect(s.controller.doc.strokeCount).toBe(1);
    expect(s.controller.doc.strokes[0]!.bounds.maxX).toBeLessThan(500);
  });

  it('treats stale results as loss rather than fresh input', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed();
    for (let i = 0; i < 3; i++) s.feed(POSES.writing());
    // A result observed 150 ms ago arrives now: rejected as stale.
    s.setNow(s.time() + 400);
    s.hands.handleResult(s.time() + 33, [handAt(POSES.writing(), { penU: 0.5, penV: 0.5 })], s.time() + 250);
    expect(s.hands.label).toBe('Tracking lost');
  });

  it('offers a bounded visual prediction only while drawing, only when enabled', () => {
    const off = setup();
    for (let i = 0; i < 4; i++) off.feed();
    for (let i = 0; i < 8; i++) off.feed(POSES.writing(), 600 + i * 10);
    expect(off.hands.prediction(off.now(), 8)).toBeNull();
    const config = { ...DEFAULT_CONFIG, prediction: { ...DEFAULT_CONFIG.prediction, enabled: true } };
    const on = setup(config);
    for (let i = 0; i < 4; i++) on.feed();
    for (let i = 0; i < 8; i++) on.feed(POSES.writing(), 600 + i * 10);
    const p = on.hands.prediction(on.now(), 8);
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.dx, p!.dy)).toBeLessThanOrEqual(config.prediction.maxDistancePx + 1e-9);
    expect(p!.dx).toBeGreaterThan(0);
    on.feed(POSES.open, 690);
    expect(on.hands.prediction(on.now(), 8)).toBeNull();
    // Predicted tips never become stroke points.
    const stroke = on.controller.doc.strokes[0]!;
    let maxX = -Infinity;
    stroke.points.forEach((x) => (maxX = Math.max(maxX, x)));
    expect(maxX + SURFACE.stripWidth).toBeLessThanOrEqual(600 + 7 * 10 + 1);
  });
});
