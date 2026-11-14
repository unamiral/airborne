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

function setup() {
  const controller = new BoardController(DEFAULT_CONFIG);
  let now = 0;
  const hands = new HandInput({
    config: () => DEFAULT_CONFIG,
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
  const feed = (pose = POSES.open, x = 600, y = 300) => {
    t += 33;
    now = t + 20;
    const cam = surfaceToCamera(x, y);
    hands.handleResult(t, [handAt(pose, { penU: cam.u, penV: cam.v, seed: t })], t);
  };
  return { hands, controller, feed, setNow: (n: number) => (now = n), time: () => t };
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

  it('switches to draw while pinching, and the label reflects the mode', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed();
    expect(s.hands.label).toBe('Hover');
    for (let i = 0; i < 3; i++) s.feed(POSES.pinch(0.1), 600 + i * 4);
    expect(s.hands.label).toBe('Draw');
    expect(s.hands.cursors()[0]!.mode).toBe('draw');
  });

  it('shows no live cursor and reports tracking lost once results go stale', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed();
    s.hands.checkLoss(s.time() + 20 + 150);
    expect(s.hands.label).toBe('Tracking lost');
    expect(s.hands.cursors()).toEqual([]);
  });

  it('marks a hand that appeared pinched as blocked until it opens', () => {
    const s = setup();
    s.feed(POSES.pinch(0.1));
    expect(s.hands.cursors()[0]!.mode).toBe('blocked');
    s.feed(POSES.open);
    expect(s.hands.cursors()[0]!.mode).toBe('hover');
  });

  it('treats stale results as loss rather than fresh input', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.feed();
    for (let i = 0; i < 3; i++) s.feed(POSES.pinch(0.1));
    // A result observed 150 ms ago arrives now: rejected as stale.
    s.setNow(s.time() + 400);
    s.hands.handleResult(s.time() + 33, [handAt(POSES.pinch(0.1), { penU: 0.5, penV: 0.5 })], s.time() + 250);
    expect(s.hands.label).toBe('Tracking lost');
  });
});
