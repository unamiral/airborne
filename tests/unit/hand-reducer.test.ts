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
const NEAR = 0.24;
const FAR = 0.8;
const BAND = 0.42;

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
    writingProximity: h.writingProximity === undefined
      ? { ratio: h.ratio === PINCH ? NEAR : FAR, space: 'world' }
      : h.writingProximity,
    pinchPose: h.pinchPose ?? true,
    fist: h.fist ?? false,
    ...(h.extended === undefined ? {} : { extended: h.extended }),
    ...(h.palm === undefined ? {} : { palm: h.palm }),
    ...(h.palmRegion === undefined ? {} : { palmRegion: h.palmRegion }),
    ...(h.clap === undefined ? {} : { clap: h.clap }),
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

  frame(hands: HandSample[], dt = 50, expired: number[] = []): Intent[] {
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

describe('writing proximity', () => {
  const writer = (ratio: number, x: number, space: 'world' | 'image' = 'world'): HandSample =>
    sample(1, { x, writingProximity: { ratio, space } });

  it('preserves the first fingertip point after 50 ms of continuously close fingertips', () => {
    const s = new Sim();
    s.arm();
    expect(s.frame([writer(NEAR, 100)], 16)).toEqual([]);
    const onsetT = s.t;
    expect(s.frame([writer(NEAR, 104)], 33)).toEqual([]);
    expect(s.frame([writer(NEAR, 108)], 16)).toEqual([]);
    const start = s.frame([writer(NEAR, 109)], 1);
    expect(start).toEqual([
      { kind: 'stroke-begin', owner: 1, at: surfacePoint(100, 300), t: onsetT },
      { kind: 'stroke-point', at: surfacePoint(104, 300), t: onsetT + 33 },
      { kind: 'stroke-point', at: surfacePoint(108, 300), t: onsetT + 49 },
      { kind: 'stroke-point', at: surfacePoint(109, 300), t: onsetT + 50 },
      { kind: 'stroke-confirm' },
    ]);
  });

  it('ignores isolated close samples and restarts timing after leaving the start threshold', () => {
    const s = new Sim();
    s.arm();
    s.frame([writer(NEAR, 100)]);
    s.frame([writer(BAND, 130)], 40);
    s.frame([writer(NEAR, 160)], 20);
    expect(s.frame([writer(NEAR, 164)], 40)).toEqual([]);
    expect(s.frame([writer(NEAR, 166)], 10)[0]).toMatchObject({ kind: 'stroke-begin', at: surfacePoint(160, 300) });
  });

  it('keeps ink continuous in the hysteresis band and stops at release without adding a tail', () => {
    const s = new Sim();
    s.arm();
    s.frame([writer(NEAR, 100)]);
    s.frame([writer(NEAR, 110)]);
    expect(s.kinds(s.frame([writer(BAND, 120)]))).toEqual(['stroke-point']);
    expect(s.kinds(s.frame([writer(DEFAULT_CONFIG.gesture.writeReleaseRatio, 150)]))).toEqual(['stroke-commit']);
    expect(s.frame([writer(BAND, 180)])).toEqual([]);
  });

  it('requires a release after acquisition and ignores the old pinch and fist poses', () => {
    const s = new Sim();
    s.frame([writer(NEAR, 100)]);
    s.frame([writer(NEAR, 100)]);
    s.frame([writer(FAR, 100)]);
    for (let i = 0; i < 4; i++) {
      s.frame([sample(1, { ratio: PINCH, writingProximity: { ratio: FAR, space: 'world' } })]);
      s.frame([sample(1, { fist: true, writingProximity: { ratio: NEAR, space: 'world' } })]);
    }
    expect(s.kinds()).not.toContain('stroke-begin');
  });

  it('can write from the image fallback and ends on a switch of coordinate space', () => {
    const s = new Sim();
    s.frame([writer(FAR, 100, 'image')]);
    s.frame([writer(NEAR, 100, 'image')]);
    expect(s.kinds(s.frame([writer(NEAR, 110, 'image')]))).toContain('stroke-confirm');
    expect(s.kinds(s.frame([writer(NEAR, 120)]))).toEqual(['stroke-commit']);
    expect(s.frame([writer(NEAR, 130)])).toEqual([]);
  });

  it.each(['missing', 'stale', 'unreliable', 'ambiguous', 'long interval'] as const)(
    'commits at the last trusted point on %s tracking and requires release before a new stroke', (loss) => {
      const s = new Sim();
      s.arm();
      s.frame([writer(NEAR, 100)]);
      s.frame([writer(NEAR, 110)]);
      let close: Intent[];
      if (loss === 'missing') close = s.frame([]);
      else if (loss === 'stale') close = s.send({ kind: 'loss', t: s.t + 20 });
      else if (loss === 'unreliable') close = s.frame([sample(1, { usable: false, x: 200 })]);
      else if (loss === 'ambiguous') close = s.frame([sample(1, { usable: false, ambiguous: true, x: 200 })]);
      else close = s.frame([writer(NEAR, 200)], 120);
      expect(s.kinds(close)).toEqual(['stroke-commit']);
      expect(s.frame([writer(NEAR, 220)])).toEqual([]);
      expect(s.frame([writer(NEAR, 230)])).toEqual([]);
      s.frame([writer(FAR, 240)]);
      s.frame([writer(NEAR, 250)]);
      expect(s.frame([writer(NEAR, 260)])[0]).toMatchObject({ kind: 'stroke-begin', at: surfacePoint(250, 300) });
    },
  );
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

  it('a writing gesture that crosses into the strip cannot activate controls until released', () => {
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
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 303 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    const join = s.frame([sample(1, { ratio: PINCH, extended: true, x: 305 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    expect(join.map((i) => i.kind)).toEqual(['stroke-cancel', 'transform-begin']);
    expect(s.kinds()).not.toContain('stroke-commit');
  });

  it('keeps intentional writing when the second hand joins late', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    for (let i = 0; i < 12; i++) s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 + i * 6 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 372 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    const join = s.frame([sample(1, { ratio: PINCH, extended: true, x: 374 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    expect(join.map((i) => i.kind)).toEqual(['stroke-commit', 'transform-begin']);
  });

  it('starts transforming without ink when both hands confirm together', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    expect(s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]).map((i) => i.kind)).toEqual([
      'transform-begin',
    ]);
    expect(modeLabel(s.state)).toBe('Move');
    expect(s.frame([sample(1, { ratio: PINCH, extended: true, x: 290 }), sample(2, { ratio: PINCH, extended: true, x: 720 })]).map((i) => i.kind)).toEqual([
      'transform-update',
    ]);
  });

  it('freezes after losing one hand and waits for a visible release', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    expect(s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 })]).map((i) => i.kind)).toEqual(['transform-end']);
    expect(s.state.mode).toEqual({ kind: 'await-release', waiting: [1, 2], extended: true });
    s.frame([sample(1, { ratio: OPEN, x: 300 })]);
    expect(s.state.mode.kind).toBe('hover');
    expect(s.kinds()).not.toContain('stroke-begin');
  });

  it('resumes one-handed use after the other hand leaves entirely (expiry, not release)', () => {
    const s = new Sim();
    s.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 }), sample(2, { ratio: PINCH, extended: true, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 })]);
    s.frame([sample(1, { ratio: OPEN, x: 300 })]);
    // Hand 2 expires after 250 ms absent: ownership ends.
    s.frame([sample(1, { ratio: OPEN, x: 300 })], 250, [2]);
    expect(s.state.mode.kind).toBe('hover');
    expect(s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 })])).toEqual([]);
    expect(s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 })])[0]?.kind).toBe('stroke-begin');
  });

  it('ignores a second pinching hand that was never seen open (another person entering)', () => {
    const s = new Sim();
    s.arm(1, { x: 300 });
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 300 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 303 }), sample(2, { ratio: PINCH, x: 700 })]);
    s.frame([sample(1, { ratio: PINCH, extended: true, x: 306 }), sample(2, { ratio: PINCH, x: 700 })]);
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
    expect(s.frame([sample(1, { ratio: PINCH })])).toEqual([]);
    expect(s.frame([sample(1, { ratio: PINCH })])[0]?.kind).toBe('stroke-begin');
  });

  it('discards unconfirmed ink and ends transforms on interrupt', () => {
    const a = new Sim();
    a.arm();
    a.frame([sample(1, { ratio: PINCH })]);
    expect(a.send({ kind: 'interrupt', reason: 'blur', pause: true })).toEqual([]);
    const b = new Sim();
    b.frame([sample(1, { ratio: OPEN, x: 300 }), sample(2, { ratio: OPEN, x: 700 })]);
    b.frame([sample(1, { ratio: OPEN, extended: true, x: 300 }), sample(2, { ratio: OPEN, extended: true, x: 700 })]);
    b.frame([sample(1, { ratio: OPEN, extended: true, x: 300 }), sample(2, { ratio: OPEN, extended: true, x: 700 })]);
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

describe('controls while paused', () => {
  const resumeCtl = { kind: 'control', id: 'pause' } as const;

  it('lets a hand press Resume while the board stays uneditable', () => {
    const s = new Sim();
    s.arm();
    s.send({ kind: 'interrupt', reason: 'pause', pause: true });
    // Board pinches do nothing while paused.
    s.frame([sample(1, { ratio: OPEN })]);
    s.frame([sample(1, { ratio: PINCH })]);
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.log).toEqual([]);
    // Release, then pinch over the Resume control.
    s.frame([sample(1, { ratio: OPEN, region: resumeCtl })]);
    s.frame([sample(1, { ratio: PINCH, region: resumeCtl })]);
    expect(s.frame([sample(1, { ratio: PINCH, region: resumeCtl })])).toEqual([{ kind: 'control-activate', id: 'pause' }]);
    s.send({ kind: 'resume' });
    // The pinch that pressed Resume cannot start drawing: it must be released.
    s.frame([sample(1, { ratio: PINCH })]);
    s.frame([sample(1, { ratio: PINCH })]);
    expect(s.kinds()).toEqual(['control-activate']);
    s.frame([sample(1, { ratio: OPEN })]);
    expect(s.frame([sample(1, { ratio: PINCH })])).toEqual([]);
    expect(s.frame([sample(1, { ratio: PINCH })])[0]?.kind).toBe('stroke-begin');
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
          case 'snapshot':
            expect(stroke === 'none' && !erasing && !transforming).toBe(true);
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
