/**
 * End-to-end replay through the real pipeline (features → identity → mapping
 * → discontinuity → One Euro → reducer → controller) with synthetic hands.
 * Covers F07, F09, F10, F12, F14, F17, F19, F21 behavior downstream of
 * inference. Synthetic landmarks only: not detector or camera validation.
 */
import { describe, expect, it } from 'vitest';
import type { Stroke } from '../../src/board/stroke';
import { parseReplay, type ReplayRecord } from '../../src/dev/replay-format';
import { runReplay } from '../../src/dev/replay-runner';
import { POSES, withRotation } from '../support/hands';
import { hover, move, pinchAt, pinchMove, scenario, still, type HandScript } from '../support/scenarios';

/** Board-local CSS px of a stroke point (identity view; board starts after the 120 px strip). */
function points(stroke: Stroke): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  stroke.points.forEach((x, y) => out.push({ x: x + 120, y }));
  return out;
}

function extent(stroke: Stroke): number {
  const b = stroke.bounds;
  return Math.max(b.maxX - b.minX, b.maxY - b.minY);
}

function run(record: ReplayRecord) {
  // Round-trip through JSON and the validator, as a stored fixture would be.
  const parsed = parseReplay(JSON.parse(JSON.stringify(record)));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return runReplay(parsed.record);
}

const kinds = (r: ReturnType<typeof run>) => r.intents.map((i) => i.kind);

describe('writing', () => {
  it('draws two separate strokes with hover between them', () => {
    const r = run(
      scenario('two strokes', [
        {
          phases: [
            hover(300, 400, 300),
            pinchMove(600, 400, 300, 700, 350),
            { ms: 300, pose: POSES.open, path: move(700, 350, 720, 400) },
            hover(150, 720, 400),
            pinchMove(500, 720, 400, 900, 400),
            hover(300, 900, 380),
          ],
        },
      ], { strokes: 2 }),
    );
    expect(r.controller.doc.strokeCount).toBe(2);
    expect(r.controller.history.undoDepth).toBe(2);
    const [a, b] = r.controller.doc.strokes;
    // Strokes follow the scripted paths (allowing for filter lag at the ends).
    for (const p of points(a!)) expect(Math.abs(p.y - (300 + ((p.x - 400) / 300) * 50))).toBeLessThan(4);
    for (const p of points(b!)) expect(Math.abs(p.y - 400)).toBeLessThan(4);
  });

  it('starts at the recorded onset rather than a later confirmation point', () => {
    const r = run(scenario('onset', [{ phases: [hover(300, 400, 300), pinchMove(400, 400, 300, 600, 300), hover(200, 600, 300)] }], { strokes: 1 }));
    const first = points(r.controller.doc.strokes[0]!)[0]!;
    expect(Math.abs(first.x - 400)).toBeLessThan(2);
    expect(Math.abs(first.y - 300)).toBeLessThan(2);
  });

  it('stays one stroke under landmark noise (no flicker or stray starts)', () => {
    const r = run(
      scenario('noisy', [{ phases: [hover(300, 400, 300), pinchMove(1500, 400, 300, 900, 450, 0.15), hover(300, 900, 450)] }], { strokes: 1 }, { noisePx: 0.6, worldNoiseM: 0.001 }),
    );
    expect(kinds(r).filter((k) => k === 'stroke-begin')).toHaveLength(1);
    expect(r.controller.doc.strokeCount).toBe(1);
  });
});

describe('dots, punctuation, and release (F10)', () => {
  it('keeps i-dots, decimal points, and a tiny minus sign', () => {
    const r = run(
      scenario('dots', [
        {
          phases: [
            hover(300, 500, 300),
            pinchAt(70, 500, 300),
            { ms: 250, pose: POSES.open, path: move(500, 300, 600, 320) },
            hover(150, 600, 320),
            pinchAt(70, 600, 320),
            { ms: 250, pose: POSES.open, path: move(600, 320, 700, 300) },
            hover(150, 700, 300),
            pinchMove(120, 700, 300, 708, 300),
            hover(250, 720, 300),
          ],
        },
      ], { strokes: 3 }),
    );
    expect(r.controller.doc.strokeCount).toBe(3);
    const [i, dec, minus] = r.controller.doc.strokes;
    expect(extent(i!)).toBeLessThan(2);
    expect(extent(dec!)).toBeLessThan(2);
    expect(extent(minus!)).toBeGreaterThan(3);
    expect(extent(minus!)).toBeLessThan(12);
  });

  it('discards a single-frame false pinch', () => {
    const r = run(scenario('false pinch', [{ phases: [hover(300, 500, 300), pinchAt(33, 500, 300), hover(400, 500, 300)] }], { strokes: 0 }));
    expect(r.controller.doc.strokeCount).toBe(0);
    expect(kinds(r)).toContain('stroke-cancel');
    expect(r.controller.history.undoDepth).toBe(0);
  });

  it('does not add a tail while the fingers open and drift', () => {
    const r = run(
      scenario('release drift', [
        {
          phases: [
            hover(300, 400, 300),
            pinchMove(500, 400, 300, 600, 300),
            { ms: 66, pose: POSES.pinch(0.33), path: move(600, 296, 600, 284) },
            { ms: 200, pose: POSES.open, path: still(600, 270) },
          ],
        },
      ], { strokes: 1 }),
    );
    const pts = points(r.controller.doc.strokes[0]!);
    for (const p of pts) expect(Math.abs(p.y - 300)).toBeLessThan(2.5);
  });
});

describe('two hands (F14, F15)', () => {
  const twoHands = (secondStart: number, firstMove: number): HandScript[] => [
    { phases: [hover(300, 500, 360), pinchMove(secondStart, 500, 360, 500 + firstMove, 360), pinchMove(600, 500 + firstMove, 360, 420, 360), hover(300, 420, 360)] },
    { phases: [hover(300 + secondStart, 800, 360), pinchMove(600, 800, 360, 880, 360), hover(300, 880, 360)], handedness: 'Left' },
  ];

  it('zooms with both hands and leaves no phantom stroke', () => {
    const r = run(
      scenario('zoom', [
        { phases: [hover(300, 500, 360), pinchMove(600, 500, 360, 420, 360), hover(300, 420, 360)] },
        { phases: [hover(300, 800, 360), pinchMove(600, 800, 360, 880, 360), hover(300, 880, 360)], handedness: 'Left' },
      ], { strokes: 0 }),
    );
    expect(r.controller.doc.strokeCount).toBe(0);
    expect(kinds(r)).toContain('transform-begin');
    expect(r.controller.view.scale).toBeGreaterThan(1.35);
    expect(r.controller.view.scale).toBeLessThan(1.65);
  });

  it('cancels a short first stroke when the second hand joins within the window', () => {
    const r = run(scenario('early join', twoHands(120, 4), { strokes: 0 }));
    expect(kinds(r)).toContain('stroke-cancel');
    expect(kinds(r)).not.toContain('stroke-commit');
    expect(r.controller.doc.strokeCount).toBe(0);
  });

  it('keeps meaningful writing when the second hand joins late', () => {
    const r = run(scenario('late join', twoHands(600, 150), { strokes: 1 }));
    expect(r.controller.doc.strokeCount).toBe(1);
    expect(extent(r.controller.doc.strokes[0]!)).toBeGreaterThan(100);
    expect(kinds(r)).toContain('transform-begin');
  });

  it('ignores a second person’s hand that arrives already pinched', () => {
    const r = run(
      scenario('second person', [
        { phases: [hover(1000, 400, 300)] },
        { start: 300, phases: [pinchMove(500, 900, 300, 950, 320)], palmPx: 55, handedness: 'Left' },
      ], { strokes: 0 }),
    );
    expect(r.controller.doc.strokeCount).toBe(0);
    expect(kinds(r)).not.toContain('transform-begin');
  });
});

describe('erasing (F17, F18)', () => {
  it('erases a stroke with an armed fist sweep as one undoable action', () => {
    const r = run(
      scenario('fist erase', [
        {
          phases: [
            hover(300, 400, 300),
            pinchMove(500, 400, 300, 700, 300),
            hover(400, 450, 250),
            { ms: 700, pose: POSES.fist, path: move(450, 250, 650, 340) },
            hover(300, 650, 340),
          ],
        },
      ], { strokes: 0, erasedStrokes: 1 }),
    );
    expect(kinds(r)).toContain('erase-begin');
    expect(r.controller.doc.strokeCount).toBe(0);
    expect(r.controller.history.undoDepth).toBe(2);
    r.controller.undo();
    expect(r.controller.doc.strokeCount).toBe(1);
  });

  it('a brief fist (shorter than arming) erases nothing', () => {
    const r = run(
      scenario('brief fist', [
        { phases: [hover(300, 400, 300), pinchMove(500, 400, 300, 700, 300), hover(300, 500, 300), { ms: 120, pose: POSES.fist, path: still(550, 300) }, hover(300, 550, 300)] },
      ], { strokes: 1 }),
    );
    expect(r.controller.doc.strokeCount).toBe(1);
    expect(kinds(r)).not.toContain('erase-begin');
  });
});

describe('fist safety (F17)', () => {
  it('a rotated fist still arms and erases', () => {
    const r = run(
      scenario('rotated fist', [
        {
          phases: [
            hover(300, 400, 300),
            pinchMove(500, 400, 300, 700, 300),
            hover(400, 450, 260),
            { ms: 700, pose: withRotation(POSES.fist, 50, 25, 20), path: move(450, 260, 650, 340) },
            hover(300, 650, 340),
          ],
        },
      ], { strokes: 0 }),
    );
    expect(kinds(r)).toContain('erase-begin');
    expect(r.controller.doc.strokeCount).toBe(0);
  });

  it('partial curls, relaxed hands, and pinches with curled fingers never arm the eraser', () => {
    for (const pose of [POSES.halfCurl, POSES.relaxed, POSES.tightPinch(0.12), POSES.pointing]) {
      const r = run(
        scenario('not a fist', [
          { phases: [hover(300, 400, 300), pinchMove(500, 400, 300, 700, 300), hover(300, 500, 300), { ms: 1500, pose, path: move(500, 280, 600, 320) }, hover(300, 600, 320)] },
        ], {}),
      );
      expect(kinds(r).some((k) => k.startsWith('erase')), JSON.stringify(pose.index)).toBe(false);
      expect(r.controller.doc.strokeCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('dropouts and re-entry (F19)', () => {
  it('reconnects a short gap during slow writing without inventing a curve', () => {
    const r = run(
      scenario('short gap', [{ phases: [hover(300, 400, 300), pinchMove(1500, 400, 300, 490, 300), hover(300, 490, 300)] }], { strokes: 1 }, { gaps: [[900, 966]] }),
    );
    expect(r.controller.doc.strokeCount).toBe(1);
    expect(kinds(r).filter((k) => k === 'stroke-begin')).toHaveLength(1);
  });

  it('ends the stroke after a long gap and does not resume while still pinched', () => {
    const r = run(
      scenario('long gap', [{ phases: [hover(300, 400, 300), pinchMove(1500, 400, 300, 700, 300), hover(300, 700, 300)] }], { strokes: 1 }, { gaps: [[900, 1150]] }),
    );
    expect(kinds(r).filter((k) => k === 'stroke-begin')).toHaveLength(1);
    expect(r.controller.doc.strokeCount).toBe(1);
    // Nothing is drawn after the gap (the hand never released).
    const maxX = Math.max(...points(r.controller.doc.strokes[0]!).map((p) => p.x));
    expect(maxX).toBeLessThan(400 + (300 * 600) / 1500 + 8);
  });

  it('does not restart ink when a pinched hand re-enters after leaving the reach area', () => {
    const r = run(
      scenario('reenter', [
        { phases: [hover(300, 400, 300), pinchMove(400, 400, 300, 600, 300), pinchMove(300, 600, 300, 1400, 300), pinchMove(400, 1400, 300, 700, 320), hover(200, 700, 320)] },
      ], { strokes: 1 }),
    );
    expect(kinds(r).filter((k) => k === 'stroke-begin')).toHaveLength(1);
    expect(r.controller.doc.strokeCount).toBe(1);
  });
});

describe('controls by hand (F21)', () => {
  it('activates a control once and never draws when the held pinch moves onto the board', () => {
    const record = scenario('control', [
      { phases: [hover(300, 60, 200), pinchAt(300, 60, 200), pinchMove(400, 60, 200, 500, 300), hover(300, 500, 300)] },
    ], { strokes: 0 });
    const parsed = parseReplay(JSON.parse(JSON.stringify(record)));
    if (!parsed.ok) throw new Error('invalid');
    const r = runReplay(parsed.record, { controls: [{ id: 'undo', rect: { x: 30, y: 170, width: 60, height: 60 } }] });
    expect(r.activations).toEqual(['undo']);
    expect(r.controller.doc.strokeCount).toBe(0);
  });
});

describe('discontinuities (F12)', () => {
  it('does not stretch ink to an isolated landmark jump', () => {
    const record = scenario('outlier', [{ phases: [hover(300, 400, 300), pinchMove(1200, 400, 300, 520, 300), hover(300, 520, 300)] }], { strokes: 1 });
    // Corrupt one frame: thumb and index tips jump 25 camera px while the palm stays.
    const frames = record.frames.map((f, i) => {
      if (i !== 25 || f.hands.length === 0) return f;
      const h = f.hands[0]!;
      const lm = [...h.landmarks];
      for (const k of [4, 8, 3, 7]) lm[k * 3] = lm[k * 3]! - 25 / 640;
      return { ...f, hands: [{ ...h, landmarks: lm }] };
    });
    const r = run({ ...record, frames });
    for (const s of r.controller.doc.strokes) for (const p of points(s)) expect(Math.abs(p.y - 300)).toBeLessThan(4);
    const xs = r.controller.doc.strokes.flatMap((s) => points(s).map((p) => p.x));
    // The jump moved the pen ~70 surface px to the user's right; no ink goes there.
    expect(Math.max(...xs)).toBeLessThan(530);
  });
});

describe('determinism (F32)', () => {
  it('produces the identical document for identical records', () => {
    const make = () => scenario('det', [{ phases: [hover(300, 400, 300), pinchMove(900, 400, 300, 800, 500), hover(300, 800, 500)] }], { strokes: 1 }, { noisePx: 0.5 });
    const a = run(make());
    const b = run(make());
    const flat = (r: ReturnType<typeof run>) => r.controller.doc.strokes.map((s) => points(s));
    expect(flat(a)).toEqual(flat(b));
    expect(kinds(a)).toEqual(kinds(b));
  });
});
