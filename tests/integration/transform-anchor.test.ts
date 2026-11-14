/**
 * F15 anchor precision through the full replay path (features → filter →
 * reducer → controller): the world point under the hands' midpoint at
 * transform start stays under the current midpoint on every update while the
 * separation is usable (< 1 CSS px), for zoom in, zoom out, and pure pan.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/app/config';
import { BoardController } from '../../src/board/controller';
import { toBoard, toWorld } from '../../src/board/view';
import { boardPoint, type SurfacePoint, type WorldPoint } from '../../src/core/coords';
import { runReplay } from '../../src/dev/replay-runner';
import { handsAtRest, extendMove, scenario, SURFACE } from '../support/scenarios';

const toBoardPt = (p: SurfacePoint) => boardPoint(p.x - SURFACE.stripWidth, p.y);

describe('two-hand transform anchor in replay (F15)', () => {
  const cases = [
    { label: 'zoom out', a: [430, 340], b: [900, 400] },
    { label: 'zoom in', a: [600, 350], b: [700, 370] },
    { label: 'pan only', a: [560, 300], b: [860, 300] },
  ] as const;
  for (const c of cases) {
    it(`${c.label}: anchor error < 1 px on every update`, () => {
      const record = scenario(c.label, [
        { phases: [handsAtRest(300, 500, 360), extendMove(700, 500, 360, c.a[0], c.a[1]), handsAtRest(200, c.a[0], c.a[1])] },
        { phases: [handsAtRest(300, 800, 360), extendMove(700, 800, 360, c.b[0], c.b[1]), handsAtRest(200, c.b[0], c.b[1])], handedness: 'Left' },
      ], { strokes: 0 });
      const controller = new BoardController(DEFAULT_CONFIG);
      let anchor: WorldPoint | null = null;
      let worst = 0;
      let updates = 0;
      runReplay(record, {
        controller,
        onFrame: (_i, intents) => {
          for (const intent of intents) {
            const a = 'a' in intent ? toBoardPt(intent.a) : null;
            const b = 'b' in intent ? toBoardPt(intent.b) : null;
            if (a === null || b === null) continue;
            const mid = boardPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
            if (intent.kind === 'transform-begin') anchor = toWorld(controller.view, mid);
            if (intent.kind === 'transform-update' && anchor !== null && Math.hypot(a.x - b.x, a.y - b.y) >= 40) {
              const shown = toBoard(controller.view, anchor);
              worst = Math.max(worst, Math.hypot(shown.x - mid.x, shown.y - mid.y));
              updates++;
            }
          }
        },
      });
      expect(controller.doc.strokeCount).toBe(0);
      expect(updates).toBeGreaterThan(10);
      expect(worst).toBeLessThan(1);
    });
  }
});
