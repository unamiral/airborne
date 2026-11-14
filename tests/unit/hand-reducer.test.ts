import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GestureConfig } from '../../src/app/config';
import { surfacePoint } from '../../src/core/coords';
import {
  initialReducerState,
  modeLabel,
  reduce,
  type HandSample,
  type Intent,
  type ReducerInput,
  type ReducerState,
} from '../../src/input/hand-reducer';
import { rng } from '../support/synthetic';

const OPEN = 0.8;
const PINCH = 0.12;
const BAND = 0.32; // between down (0.25) and up (0.40)

interface H extends Partial<Omit<HandSample, 'pen'>> {
  x?: number;
  y?: number;
  ratio?: number;
}

function sample(id: number, h: H = {}): HandSample {
  return {
    id,
    usable: h.usable ?? true,
    ambiguous: h.ambiguous ?? false,
    pinchRatio: h.ratio ?? OPEN,
    pinchPose: h.pinchPose ?? true,
    fist: h.fist ?? false,
    pen: surfacePoint(h.x ?? 500, h.y ?? 300),
    inReach: h.inReach ?? true,
    region: h.region ?? { kind: 'board' },
  };
}

class Sim {
  state: ReducerState = initialReducerState();
  t = 0;
  readonly log: Intent[] = [];

  constructor(readonly config: GestureConfig = DEFAULT_CONFIG.gesture) {}

  send(input: ReducerInput): Intent[] {
    const step = reduce(this.state, input, this.config);
    this.state = step.state;
    this.log.push(...step.intents);
    return [...step.intents];
  }

  frame(hands: HandSample[], dt = 33, expired: number[] = []): Intent[] {
    this.t += dt;
    return this.send({ kind: 'frame', t: this.t, hands, expired });
  }

  kinds(intents = this.log): string[] {
    return intents.map((i) => i.kind);
  }

  /** Open hand observed (arms the track). */
  arm(id = 1, h: H = {}): void {
    this.frame([sample(id, { ...h, ratio: OPEN })]);
  }
}

describe('pinch drawing (F09, F10)', () => {
  it('starts a provisional stroke at the onset sample and confirms after 2 samples and 20 ms', () => {
    const s = new Sim();
    s.arm();
    const first = s.frame([sample(1, { ratio: PINCH, x: 100, y: 100 })]);
    expect(first).toEqual([{ kind: 'stroke-begin', owner: 1, at: surfacePoint(100, 100), t: s.t }]);
    expect(modeLabel(s.state)).toBe('Draw');
    const second = s.frame([sample(1, { ratio: PINCH, x: 105, y: 100 })]);
    expect(second.map((i) => i.kind)).toEqual(['stroke-point', 'stroke-confirm']);
    expect(s.state.mode.kind).toBe('drawing');
  });

  it('confirms by time and sample count, not render frames (60 Hz needs a third sample)', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH })], 16);
    expect(s.frame([sample(1, { ratio: PINCH })], 16).map((i) => i.kind)).toEqual(['stroke-point']);
    expect(s.frame([sample(1, { ratio: PINCH })], 16).map((i) => i.kind)).toEqual(['stroke-point', 'stroke-confirm']);
  });

  it('discards a one-sample false pinch without touching committed content', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.frame([sample(1, { ratio: OPEN })]).map((i) => i.kind)).toEqual(['stroke-cancel']);
    expect(s.kinds()).not.toContain('stroke-commit');
  });

  it('turns a short validated tap into a committed stroke (a dot)', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH, x: 200, y: 200 })]);
    s.frame([sample(1, { ratio: PINCH, x: 200.2, y: 200.1 })]);
    expect(s.frame([sample(1, { ratio: OPEN, x: 230, y: 180 })]).map((i) => i.kind)).toEqual(['stroke-commit']);
    // The opened hand's position (230,180) is never appended.
    const points = s.log.filter((i) => i.kind === 'stroke-point' || i.kind === 'stroke-begin');
    expect(points).toHaveLength(2);
  });

  it('ignores a hand that appears already pinched until it is seen open', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: PINCH })]);
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.log).toEqual([]);
    s.frame([sample(1, { ratio: OPEN })]);
    expect(s.frame([sample(1, { ratio: PINCH })]).map((i) => i.kind)).toEqual(['stroke-begin']);
  });

  it('uses hysteresis: ratios between thresholds do not end the stroke', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH })]);
    s.frame([sample(1, { ratio: PINCH })]);
    for (const r of [0.24, 0.3, 0.26, 0.38, 0.2, 0.39, 0.22]) s.frame([sample(1, { ratio: r, x: 500 + s.t / 10 })], 33);
    expect(s.kinds()).not.toContain('stroke-commit');
    expect(s.frame([sample(1, { ratio: 0.41 })]).map((i) => i.kind)).toContain('stroke-commit');
  });

  it('holds samples in the hysteresis band and drops them on release (no opening tail)', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH, x: 100 })]);
    s.frame([sample(1, { ratio: PINCH, x: 110 })]);
    s.frame([sample(1, { ratio: PINCH, x: 120 })]);
    const opening = s.frame([sample(1, { ratio: BAND, x: 128, y: 290 })]);
    expect(opening).toEqual([{ kind: 'stroke-preview', points: [surfacePoint(128, 290)] }]);
    const released = s.frame([sample(1, { ratio: 0.6, x: 140, y: 270 })]);
    expect(released.map((i) => i.kind)).toEqual(['stroke-commit']);
    const appended = s.log.filter((i) => i.kind === 'stroke-point').map((i) => (i as { at: { x: number } }).at.x);
    expect(appended).toEqual([110, 120]);
  });

  it('flushes held samples when the pinch tightens again or lingers in the band', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH, x: 100 })]);
    s.frame([sample(1, { ratio: PINCH, x: 110 })]);
    s.frame([sample(1, { ratio: BAND, x: 120 })]);
    const back = s.frame([sample(1, { ratio: PINCH, x: 130 })]);
    expect(back.map((i) => i.kind)).toEqual(['stroke-point', 'stroke-preview', 'stroke-point']);
    // Lingering light pinch: flushed after releaseHoldMs.
    for (let i = 0; i < 6; i++) s.frame([sample(1, { ratio: BAND, x: 140 + i * 10 })]);
    const xs = s.log.filter((i) => i.kind === 'stroke-point').map((i) => (i as { at: { x: number } }).at.x);
    expect(xs).toContain(140);
    expect(s.kinds()).not.toContain('stroke-commit');
  });

  it('requires a plausible pinch pose: thumb near index inside a fist does not draw', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH, pinchPose: false })]);
    s.frame([sample(1, { ratio: PINCH, pinchPose: false })]);
    expect(s.log).toEqual([]);
  });
});

describe('dropout and reacquisition (F19)', () => {
  function drawing(): Sim {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH, x: 100 })]);
    s.frame([sample(1, { ratio: PINCH, x: 104 })]);
    s.frame([sample(1, { ratio: PINCH, x: 108 })]);
    return s;
  }

  it('freezes immediately on loss and reconnects only close, fast, same identity, still pinched', () => {
    const s = drawing();
    expect(s.frame([])).toEqual([]);
    expect(s.state.mode.kind).toBe('suspended');
    expect(modeLabel(s.state)).toBe('Tracking lost');
    const back = s.frame([sample(1, { ratio: PINCH, x: 113 })]); // 66 ms gap, 5 px away
    expect(back.map((i) => i.kind)).toEqual(['stroke-point']);
    expect(s.state.mode.kind).toBe('drawing');
  });

  for (const gap of [100, 250]) {
    it(`closes the stroke after a ${gap} ms gap and does not bridge it`, () => {
      const s = drawing();
      s.frame([], gap - 33);
      const back = s.frame([sample(1, { ratio: PINCH, x: 110 })], 33);
      expect(back.map((i) => i.kind)).toContain('stroke-commit');
      expect(back.map((i) => i.kind)).not.toContain('stroke-point');
      // Still pinched after returning: no new stroke until released.
      s.frame([sample(1, { ratio: PINCH, x: 112 })]);
      expect(s.kinds().filter((k) => k === 'stroke-begin')).toHaveLength(1);
    });
  }

  it('does not reconnect when the hand returns far away', () => {
    const s = drawing();
    s.frame([]);
    const back = s.frame([sample(1, { ratio: PINCH, x: 160 })]);
    expect(back.map((i) => i.kind)).toEqual(['stroke-commit']);
    expect(s.state.mode).toEqual({ kind: 'await-release', waiting: [1] });
  });

  it('ends the stroke when the pinch was released during the gap', () => {
    const s = drawing();
    s.frame([]);
    expect(s.frame([sample(1, { ratio: OPEN, x: 109 })]).map((i) => i.kind)).toEqual(['stroke-commit']);
    expect(s.state.mode.kind).toBe('hover');
  });

  it('ends conservatively on identity ambiguity and requires reacquisition', () => {
    const s = drawing();
    expect(s.frame([sample(1, { ratio: PINCH, ambiguous: true, usable: false })]).map((i) => i.kind)).toEqual(['stroke-commit']);
    s.frame([sample(1, { ratio: OPEN })]);
    s.frame([sample(1, { ratio: OPEN })]);
    expect(s.frame([sample(1, { ratio: PINCH })]).map((i) => i.kind)).toEqual(['stroke-begin']);
  });

  it('treats stale results as loss', () => {
    const s = drawing();
    s.send({ kind: 'loss', t: s.t + 40 });
    expect(s.state.mode.kind).toBe('suspended');
    s.send({ kind: 'loss', t: s.t + 140 });
    expect(s.kinds()).toContain('stroke-commit');
  });

  it('stops at the reach edge instead of clamping a line along it', () => {
    const s = drawing();
    expect(s.frame([sample(1, { ratio: PINCH, x: 900, inReach: false, region: { kind: 'outside' } })]).map((i) => i.kind)).toEqual([
      'stroke-commit',
    ]);
    // Re-entering while still pinched does not restart ink.
    s.frame([sample(1, { ratio: PINCH, x: 500 })]);
    expect(s.kinds().filter((k) => k === 'stroke-begin')).toHaveLength(1);
  });
});

describe('hand-operated controls (F21)', () => {
  const control = { kind: 'control', id: 'undo' } as const;

  it('activates exactly once per pinch that begins over a control', () => {
    const s = new Sim();
    s.arm(1, { region: control });
    s.frame([sample(1, { ratio: PINCH, region: control })]);
    expect(s.frame([sample(1, { ratio: PINCH, region: control })])).toEqual([{ kind: 'control-activate', id: 'undo' }]);
    for (let i = 0; i < 10; i++) s.frame([sample(1, { ratio: PINCH, region: control })]);
    // Dragging onto the board while still pinched never draws.
    for (let i = 0; i < 5; i++) s.frame([sample(1, { ratio: PINCH, region: { kind: 'board' } })]);
    expect(s.kinds()).toEqual(['control-activate']);
    s.frame([sample(1, { ratio: OPEN })]);
    expect(s.state.mode.kind).toBe('hover');
  });

  it('never activates on hover alone, or on a pinch released before confirmation', () => {
    const s = new Sim();
    for (let i = 0; i < 10; i++) s.frame([sample(1, { ratio: OPEN, region: control })]);
    s.frame([sample(1, { ratio: PINCH, region: control })]);
    s.frame([sample(1, { ratio: OPEN, region: control })]);
    expect(s.log).toEqual([]);
  });

  it('a drawing pinch that crosses into the strip cannot activate controls until released', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH })]);
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.frame([sample(1, { ratio: PINCH, region: control })]).map((i) => i.kind)).toEqual(['stroke-commit']);
    for (let i = 0; i < 5; i++) s.frame([sample(1, { ratio: PINCH, region: control })]);
    expect(s.kinds()).not.toContain('control-activate');
  });

  it('a pinch on the strip background is absorbed', () => {
    const s = new Sim();
    s.arm(1, { region: { kind: 'strip' } });
    s.frame([sample(1, { ratio: PINCH, region: { kind: 'strip' } })]);
    s.frame([sample(1, { ratio: PINCH, region: { kind: 'board' } })]);
    expect(s.log).toEqual([]);
  });
});

describe('two-hand arbitration (F14)', () => {
  it('cancels an early, short first stroke and starts transforming', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    const join = s.frame([sample(1, { ratio: PINCH, x: 303 }), sample(2, { ratio: PINCH, x: 700 })]);
    expect(join.map((i) => i.kind)).toEqual(['stroke-cancel', 'transform-begin']);
    expect(s.kinds()).not.toContain('stroke-commit');
  });

  it('keeps intentional writing when the second hand joins late', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    for (let i = 0; i < 12; i++) s.frame([sample(1, { ratio: PINCH, x: 300 + i * 6 }), sample(2, { ratio: OPEN, x: 700 })]);
    const join = s.frame([sample(1, { ratio: PINCH, x: 372 }), sample(2, { ratio: PINCH, x: 700 })]);
    expect(join.map((i) => i.kind)).toEqual(['stroke-commit', 'transform-begin']);
  });

  it('starts transforming directly when both hands pinch in the same result', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    expect(s.frame([sample(1, { ratio: PINCH, x: 300 }), sample(2, { ratio: PINCH, x: 700 })]).map((i) => i.kind)).toEqual([
      'transform-begin',
    ]);
    expect(modeLabel(s.state)).toBe('Move');
    expect(s.frame([sample(1, { ratio: PINCH, x: 290 }), sample(2, { ratio: PINCH, x: 720 })]).map((i) => i.kind)).toEqual([
      'transform-update',
    ]);
  });

  it('freezes and waits for both hands to release after losing one; missing hands are not releases', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, x: 300 }), sample(2, { ratio: PINCH, x: 700 })]);
    expect(s.frame([sample(1, { ratio: PINCH, x: 300 })]).map((i) => i.kind)).toEqual(['transform-end']);
    expect(s.state.mode).toEqual({ kind: 'await-release', waiting: [1, 2] });
    s.frame([sample(1, { ratio: OPEN, x: 300 })]);
    s.frame([sample(1, { ratio: PINCH, x: 300 })]);
    expect(s.kinds()).not.toContain('stroke-begin');
  });

  it('resumes one-handed use after the other hand leaves entirely (expiry, not release)', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, x: 300 }), sample(2, { ratio: PINCH, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, x: 300 })]);
    s.frame([sample(1, { ratio: OPEN, x: 300 })]);
    // Hand 2 expires after 250 ms absent: ownership ends.
    s.frame([sample(1, { ratio: OPEN, x: 300 })], 250, [2]);
    expect(s.state.mode.kind).toBe('hover');
    expect(s.frame([sample(1, { ratio: PINCH, x: 300 })]).map((i) => i.kind)).toEqual(['stroke-begin']);
  });

  it('ignores a second pinching hand that was never seen open (another person entering)', () => {
    const s = new Sim();
    s.arm(1, { x: 300 });
    s.frame([sample(1, { ratio: PINCH, x: 300 })]);
    s.frame([sample(1, { ratio: PINCH, x: 303 }), sample(2, { ratio: PINCH, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, x: 306 }), sample(2, { ratio: PINCH, x: 700 })]);
    expect(s.kinds()).toEqual(['stroke-begin', 'stroke-point', 'stroke-confirm', 'stroke-point']);
  });
});

describe('fist erasing state machine (F17 subset)', () => {
  it('arms over 180 ms of continuous fist, then erases, and ends when the fist opens', () => {
    const s = new Sim();
    s.arm();
    const progress: number[] = [];
    // 7 frames at 33 ms: the 7th is 198 ms after the first fist sample.
    for (let i = 0; i < 7; i++) {
      for (const intent of s.frame([sample(1, { ratio: 0.3, pinchPose: false, fist: true })])) {
        if (intent.kind === 'erase-arming') progress.push(intent.progress);
      }
    }
    expect(progress[0]).toBe(0);
    expect(progress.every((p, i) => i === 0 || p > progress[i - 1]!)).toBe(true);
    expect(s.kinds()).toContain('erase-begin');
    expect(s.frame([sample(1, { ratio: 0.3, pinchPose: false, fist: true, x: 520 })]).map((i) => i.kind)).toEqual(['erase-move']);
    expect(s.frame([sample(1, { ratio: OPEN })]).map((i) => i.kind)).toEqual(['erase-end']);
  });

  it('cancels arming when the fist breaks, disappears, or reaches the strip', () => {
    for (const breakIt of [
      () => [sample(1, { ratio: OPEN })],
      () => [],
      () => [sample(1, { ratio: 0.3, pinchPose: false, fist: true, region: { kind: 'strip' } })],
    ]) {
      const s = new Sim();
      s.arm();
      s.frame([sample(1, { ratio: 0.3, pinchPose: false, fist: true })]);
      s.frame([sample(1, { ratio: 0.3, pinchPose: false, fist: true })]);
      expect(s.frame(breakIt()).map((i) => i.kind)).toEqual(['erase-cancel']);
      expect(s.kinds()).not.toContain('erase-begin');
    }
  });

  it('stops erasing immediately on a tracking gap and requires re-arming', () => {
    const s = new Sim();
    s.arm();
    for (let i = 0; i < 8; i++) s.frame([sample(1, { ratio: 0.3, pinchPose: false, fist: true })]);
    expect(s.frame([]).map((i) => i.kind)).toEqual(['erase-end']);
    expect(s.frame([sample(1, { ratio: 0.3, pinchPose: false, fist: true })]).map((i) => i.kind)).toEqual(['erase-arming']);
  });

  it('ignores a second hand’s fist while the first hand draws', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN }), sample(2, { ratio: OPEN, x: 700 })]);
    for (let i = 0; i < 10; i++) {
      s.frame([sample(1, { ratio: PINCH, x: 300 + i }), sample(2, { ratio: 0.3, pinchPose: false, fist: true, x: 700 })]);
    }
    expect(s.kinds().some((k) => k.startsWith('erase'))).toBe(false);
  });

  it('can be disabled entirely', () => {
    const s = new Sim({ ...DEFAULT_CONFIG.gesture, fistEraseEnabled: false });
    s.arm();
    for (let i = 0; i < 10; i++) s.frame([sample(1, { ratio: 0.3, pinchPose: false, fist: true })]);
    expect(s.log).toEqual([]);
  });
});

describe('pause and interruption (F25 subset)', () => {
  it('commits valid ink, pauses, ignores hands while paused, and requires release after resume', () => {
    const s = new Sim();
    s.arm();
    s.frame([sample(1, { ratio: PINCH })]);
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.send({ kind: 'interrupt', reason: 'pause', pause: true }).map((i) => i.kind)).toEqual(['stroke-commit']);
    expect(modeLabel(s.state)).toBe('Paused');
    for (let i = 0; i < 5; i++) expect(s.frame([sample(1, { ratio: PINCH })])).toEqual([]);
    s.send({ kind: 'resume' });
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.kinds().filter((k) => k === 'stroke-begin')).toHaveLength(1);
    s.frame([sample(1, { ratio: OPEN })]);
    expect(s.frame([sample(1, { ratio: PINCH })]).map((i) => i.kind)).toEqual(['stroke-begin']);
  });

  it('cancels a provisional stroke and ends erasing/transform on interrupt', () => {
    const a = new Sim();
    a.arm();
    a.frame([sample(1, { ratio: PINCH })]);
    expect(a.send({ kind: 'interrupt', reason: 'blur', pause: true }).map((i) => i.kind)).toEqual(['stroke-cancel']);
    const b = new Sim();
    b.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    b.frame([sample(1, { ratio: PINCH, x: 300 }), sample(2, { ratio: PINCH, x: 700 })]);
    expect(b.send({ kind: 'interrupt', reason: 'resize', pause: false }).map((i) => i.kind)).toEqual(['transform-end']);
  });

  it('reset forgets every track (new source)', () => {
    const s = new Sim();
    s.arm();
    s.send({ kind: 'reset' });
    expect(s.state.tracks.size).toBe(0);
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.log).toEqual([]);
  });
});

describe('determinism and invariants', () => {
  function randomRun(seed: number): Intent[] {
    const random = rng(seed);
    const s = new Sim();
    for (let i = 0; i < 400; i++) {
      const hands: HandSample[] = [];
      for (const id of [1, 2]) {
        if (random() < 0.15) continue;
        const r = random();
        hands.push(
          sample(id, {
            ratio: r < 0.4 ? PINCH : r < 0.5 ? BAND : OPEN,
            fist: random() < 0.1,
            pinchPose: random() > 0.05,
            usable: random() > 0.05,
            x: 200 + random() * 600,
            region: random() < 0.1 ? { kind: 'control', id: 'pen' } : { kind: 'board' },
          }),
        );
      }
      const roll = random();
      if (roll < 0.01) s.send({ kind: 'interrupt', reason: 'pause', pause: true });
      else if (roll < 0.03) s.send({ kind: 'resume' });
      else s.frame(hands, 16 + Math.floor(random() * 40));
    }
    return s.log;
  }

  it('produces identical intents for identical input', () => {
    expect(randomRun(5)).toEqual(randomRun(5));
  });

  it('keeps stroke and erase intents well formed across random sequences', () => {
    for (let seed = 1; seed <= 30; seed++) {
      let stroke: 'none' | 'provisional' | 'confirmed' = 'none';
      let erasing = false;
      let transforming = false;
      for (const intent of randomRun(seed)) {
        switch (intent.kind) {
          case 'stroke-begin':
            expect(stroke, `seed ${seed}`).toBe('none');
            expect(erasing || transforming).toBe(false);
            stroke = 'provisional';
            break;
          case 'stroke-point':
          case 'stroke-preview':
            expect(stroke).not.toBe('none');
            break;
          case 'stroke-confirm':
            expect(stroke).toBe('provisional');
            stroke = 'confirmed';
            break;
          case 'stroke-commit':
            expect(stroke).toBe('confirmed');
            stroke = 'none';
            break;
          case 'stroke-cancel':
            expect(stroke).not.toBe('none');
            stroke = 'none';
            break;
          case 'erase-begin':
            expect(stroke === 'none' && !transforming).toBe(true);
            erasing = true;
            break;
          case 'erase-end':
            expect(erasing).toBe(true);
            erasing = false;
            break;
          case 'erase-move':
            expect(erasing).toBe(true);
            break;
          case 'transform-begin':
            expect(stroke === 'none' && !erasing).toBe(true);
            transforming = true;
            break;
          case 'transform-update':
            expect(transforming).toBe(true);
            break;
          case 'transform-end':
            transforming = false;
            break;
          case 'erase-arming':
          case 'erase-cancel':
          case 'control-activate':
            break;
        }
      }
    }
  });
});
