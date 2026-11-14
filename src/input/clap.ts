import { distance, type XY } from '../core/coords';
import type { HandSample, TrackId } from './hand-reducer';

export interface ClapHand {
  readonly center: XY;
  readonly size: number;
  readonly normal: XY;
}

interface ClapApproach {
  readonly a: TrackId;
  readonly b: TrackId;
  readonly first: ClapHand;
  readonly second: ClapHand;
  readonly axis: XY;
  readonly started: number;
  readonly lastSeen: number;
  readonly nearContact: boolean;
}

export interface ClapState {
  readonly approach: ClapApproach | null;
  readonly cooldownUntil: number;
}

export const INITIAL_CLAP: ClapState = { approach: null, cooldownUntil: 0 };
const OPEN_GAP = 1.65;
const CONTACT_GAP = 1.1;
const MAX_APPROACH_MS = 240;
const COOLDOWN_MS = 650;

export function clapHandsSeparated(a: HandSample, b: HandSample): boolean {
  return a.clap !== undefined && b.clap !== undefined &&
    distance(a.clap.center, b.clap.center) >= OPEN_GAP * (a.clap.size + b.clap.size) / 2;
}

function alongPalm(hand: ClapHand, axis: XY): number {
  return Math.abs(hand.normal.x * axis.x + hand.normal.y * axis.y);
}

export function observeClap(state: ClapState, hands: readonly HandSample[], t: number, maxGapMs: number): {
  readonly state: ClapState;
  readonly fired: boolean;
  readonly approaching: boolean;
} {
  const [a, b] = hands;
  const first = a?.clap;
  const second = b?.clap;
  const previous = state.approach;
  const stopped = { state: { ...state, approach: null }, fired: false, approaching: false };
  const fired = { state: { approach: null, cooldownUntil: t + COOLDOWN_MS }, fired: true, approaching: false };
  if (t < state.cooldownUntil) return stopped;
  const fresh = previous !== null && t > previous.lastSeen &&
    t - previous.lastSeen <= maxGapMs && t - previous.started <= MAX_APPROACH_MS;
  const usable = (hand: HandSample): boolean => hand.palmUsable ?? hand.usable;

  if (!a || !b || !first || !second || !usable(a) || !usable(b)) {
    // A webcam often loses one hand as the palms overlap. Count that final
    // frame only after a fast, two-sided approach already reached near contact.
    const samePair = hands.length > 0 && hands.every((hand) => hand.id === previous?.a || hand.id === previous?.b);
    return fresh && samePair && previous.nearContact ? fired : stopped;
  }

  const size = (first.size + second.size) / 2;
  const separation = distance(first.center, second.center);
  const gap = separation / size;
  if (Math.min(first.size, second.size) < size * 0.73) return stopped;

  if (fresh && previous.a === a.id && previous.b === b.id) {
    const { x, y } = previous.axis;
    const inward = (from: XY, to: XY): number => ((to.x - from.x) * x + (to.y - from.y) * y) / size;
    const motionA = inward(previous.first.center, first.center);
    const motionB = inward(second.center, previous.second.center);
    const speed = (motionA + motionB) / (t - previous.started);
    const approaching = motionA >= 0.08 && motionB >= 0.08 && speed >= 0.006;
    const facing = Math.min(alongPalm(first, previous.axis), alongPalm(second, previous.axis));
    const strongApproach = approaching && motionA >= 0.22 && motionB >= 0.22 && facing >= 0.32;
    if (strongApproach && gap <= CONTACT_GAP) return fired;

    if (approaching || gap < OPEN_GAP) {
      const nearContact = strongApproach && gap <= 1.35 && speed >= 0.008;
      return { state: { ...state, approach: { ...previous, lastSeen: t, nearContact } }, fired: false, approaching };
    }
  }

  if (gap < OPEN_GAP) return stopped;
  const axis = { x: (second.center.x - first.center.x) / separation, y: (second.center.y - first.center.y) / separation };
  if (Math.min(alongPalm(first, axis), alongPalm(second, axis)) < 0.48) return stopped;
  return {
    state: { ...state, approach: { a: a.id, b: b.id, first, second, axis, started: t, lastSeen: t, nearContact: false } },
    fired: false,
    approaching: false,
  };
}
