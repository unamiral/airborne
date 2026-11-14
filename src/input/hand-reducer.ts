/**
 * Hand gesture reducer (plan §9). Pure and deterministic: every transition
 * depends only on the previous state, the input, and the configuration.
 * No clocks, DOM, or timers; time comes from source timestamps in the input.
 *
 * Consumes one accepted tracking result at a time, in order, and emits
 * intents in interaction-surface coordinates. The board controller turns
 * intents into document edits; the reducer never touches the document.
 *
 * Track flags (per application track id):
 *   armed   - an open hand has been observed since acquisition or the last
 *             interrupt; required before any action (no lines when a hand
 *             enters the camera already pinched).
 *   pinched - hysteresis state (down below pinchDownRatio with a plausible
 *             pinch pose, up above pinchUpRatio).
 *   held    - this pinch was already used or blocked; it cannot start another
 *             action until the hand is observed released.
 */
import type { GestureConfig } from '../app/config';
import { distance, type SurfacePoint } from '../core/coords';

export type TrackId = number;

export type Region =
  | { readonly kind: 'board' }
  | { readonly kind: 'control'; readonly id: string }
  | { readonly kind: 'strip' }
  | { readonly kind: 'outside' };

export interface HandSample {
  readonly id: TrackId;
  /** Valid features, fresh result, not an outlier, identity not ambiguous. */
  readonly usable: boolean;
  readonly ambiguous: boolean;
  readonly pinchRatio: number;
  readonly pinchPose: boolean;
  readonly fist: boolean;
  /** Filtered pen position. */
  readonly pen: SurfacePoint;
  readonly inReach: boolean;
  readonly region: Region;
}

export type InterruptReason = 'pause' | 'blur' | 'hidden' | 'resize' | 'source' | 'stop' | 'settings' | 'escape';

export type ReducerInput =
  | { readonly kind: 'frame'; readonly t: number; readonly hands: readonly HandSample[]; readonly expired: readonly TrackId[] }
  /** No fresh result (stale/lost): every track is unobserved at time t. */
  | { readonly kind: 'loss'; readonly t: number }
  | { readonly kind: 'interrupt'; readonly reason: InterruptReason; readonly pause: boolean }
  | { readonly kind: 'resume' }
  /** New identity space (source change): forget all tracks. */
  | { readonly kind: 'reset' };

export type Intent =
  | { readonly kind: 'stroke-begin'; readonly owner: TrackId; readonly at: SurfacePoint; readonly t: number }
  | { readonly kind: 'stroke-point'; readonly at: SurfacePoint; readonly t: number }
  /** Held-back samples shown provisionally; replaces any previous preview. */
  | { readonly kind: 'stroke-preview'; readonly points: readonly SurfacePoint[] }
  | { readonly kind: 'stroke-confirm' }
  | { readonly kind: 'stroke-commit' }
  | { readonly kind: 'stroke-cancel' }
  | { readonly kind: 'transform-begin'; readonly a: SurfacePoint; readonly b: SurfacePoint }
  | { readonly kind: 'transform-update'; readonly a: SurfacePoint; readonly b: SurfacePoint }
  | { readonly kind: 'transform-end' }
  | { readonly kind: 'erase-arming'; readonly at: SurfacePoint; readonly progress: number }
  | { readonly kind: 'erase-cancel' }
  | { readonly kind: 'erase-begin'; readonly at: SurfacePoint }
  | { readonly kind: 'erase-move'; readonly at: SurfacePoint }
  | { readonly kind: 'erase-end' }
  | { readonly kind: 'control-activate'; readonly id: string };

interface Pending {
  readonly at: SurfacePoint;
  readonly t: number;
}

export type Mode =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'hover' }
  | {
      readonly kind: 'pinch-candidate';
      readonly owner: TrackId;
      readonly onsetT: number;
      readonly samples: number;
      readonly last: SurfacePoint;
      readonly pathLength: number;
    }
  | {
      readonly kind: 'drawing';
      readonly owner: TrackId;
      readonly onsetT: number;
      readonly last: SurfacePoint;
      readonly lastT: number;
      readonly pathLength: number;
      readonly pending: readonly Pending[];
    }
  | {
      readonly kind: 'suspended';
      readonly owner: TrackId;
      readonly onsetT: number;
      readonly last: SurfacePoint;
      readonly lastT: number;
      readonly pathLength: number;
    }
  | { readonly kind: 'transforming'; readonly a: TrackId; readonly b: TrackId }
  | { readonly kind: 'erase-arming'; readonly owner: TrackId }
  | { readonly kind: 'erasing'; readonly owner: TrackId }
  | { readonly kind: 'ui-candidate'; readonly owner: TrackId; readonly control: string; readonly onsetT: number; readonly samples: number }
  | { readonly kind: 'ui-capture'; readonly owner: TrackId }
  | { readonly kind: 'await-release'; readonly waiting: readonly TrackId[] };

export interface TrackFlags {
  readonly armed: boolean;
  readonly pinched: boolean;
  readonly held: boolean;
  readonly fistSince: number | null;
}

export interface ReducerState {
  readonly mode: Mode;
  readonly tracks: ReadonlyMap<TrackId, TrackFlags>;
  readonly paused: boolean;
}

export interface Step {
  readonly state: ReducerState;
  readonly intents: readonly Intent[];
}

export function initialReducerState(paused = false): ReducerState {
  return { mode: paused ? { kind: 'disabled' } : { kind: 'hover' }, tracks: new Map(), paused };
}

/** Coarse mode label for the UI (plan §4). */
export type ModeLabel = 'Hover' | 'Draw' | 'Move' | 'Eraser readying' | 'Erase' | 'Paused' | 'Tracking lost' | 'Controls';

export function modeLabel(state: ReducerState): ModeLabel {
  switch (state.mode.kind) {
    case 'disabled':
      return 'Paused';
    case 'hover':
    case 'await-release':
      return 'Hover';
    case 'pinch-candidate':
    case 'drawing':
      return 'Draw';
    case 'suspended':
      return 'Tracking lost';
    case 'transforming':
      return 'Move';
    case 'erase-arming':
      return 'Eraser readying';
    case 'erasing':
      return 'Erase';
    case 'ui-candidate':
    case 'ui-capture':
      return 'Controls';
  }
}

/** Owner track ids of the current interaction (for cursor emphasis). */
export function owners(mode: Mode): readonly TrackId[] {
  switch (mode.kind) {
    case 'pinch-candidate':
    case 'drawing':
    case 'suspended':
    case 'erase-arming':
    case 'erasing':
    case 'ui-candidate':
    case 'ui-capture':
      return [mode.owner];
    case 'transforming':
      return [mode.a, mode.b];
    case 'await-release':
      return mode.waiting;
    case 'disabled':
    case 'hover':
      return [];
  }
}

// ---------------------------------------------------------------------------

class Builder {
  readonly intents: Intent[] = [];
  readonly tracks: Map<TrackId, TrackFlags>;

  constructor(
    tracks: ReadonlyMap<TrackId, TrackFlags>,
    readonly config: GestureConfig,
  ) {
    this.tracks = new Map(tracks);
  }

  emit(intent: Intent): void {
    this.intents.push(intent);
  }

  flags(id: TrackId): TrackFlags {
    return this.tracks.get(id) ?? { armed: false, pinched: false, held: false, fistSince: null };
  }

  hold(id: TrackId): void {
    this.tracks.set(id, { ...this.flags(id), held: true });
  }

  disarm(id: TrackId): void {
    this.tracks.set(id, { ...this.flags(id), armed: false, held: true });
  }
}

function updateFlags(b: Builder, hand: HandSample, t: number): void {
  const g = b.config;
  const prev = b.flags(hand.id);
  if (!hand.usable) {
    // No evidence this frame: keep pinch state, break fist continuity.
    b.tracks.set(hand.id, { ...prev, fistSince: null });
    return;
  }
  let pinched = prev.pinched;
  if (pinched && hand.pinchRatio > g.pinchUpRatio) pinched = false;
  else if (!pinched && hand.pinchRatio < g.pinchDownRatio && hand.pinchPose) pinched = true;
  const openHand = !pinched && hand.pinchRatio > g.pinchUpRatio && !hand.fist;
  const fistSince = hand.fist && !pinched ? (prev.fistSince ?? t) : null;
  b.tracks.set(hand.id, {
    armed: prev.armed || openHand,
    pinched,
    held: pinched ? prev.held : false,
    fistSince,
  });
}

/** A hand that may start a new action with this pinch. */
function canStart(b: Builder, hand: HandSample): boolean {
  const f = b.flags(hand.id);
  return hand.usable && f.armed && f.pinched && !f.held;
}

function onBoard(hand: HandSample): boolean {
  return hand.inReach && hand.region.kind === 'board';
}

/** Closes whatever interaction is active, preserving valid ink. */
function closeInteraction(b: Builder, mode: Mode): void {
  switch (mode.kind) {
    case 'pinch-candidate':
      b.emit({ kind: 'stroke-cancel' });
      return;
    case 'drawing':
    case 'suspended':
      b.emit({ kind: 'stroke-commit' });
      return;
    case 'transforming':
      b.emit({ kind: 'transform-end' });
      return;
    case 'erase-arming':
      b.emit({ kind: 'erase-cancel' });
      return;
    case 'erasing':
      b.emit({ kind: 'erase-end' });
      return;
    case 'ui-candidate':
    case 'ui-capture':
    case 'await-release':
    case 'hover':
    case 'disabled':
      return;
  }
}

function startFromHover(b: Builder, hands: readonly HandSample[], t: number): Mode {
  const starters = hands.filter((h) => canStart(b, h)).sort((x, y) => x.id - y.id);
  const [first, second] = starters;
  if (first !== undefined && second !== undefined && onBoard(first) && onBoard(second)) {
    b.hold(first.id);
    b.hold(second.id);
    b.emit({ kind: 'transform-begin', a: first.pen, b: second.pen });
    return { kind: 'transforming', a: first.id, b: second.id };
  }
  if (first !== undefined) {
    b.hold(first.id);
    const region = first.region;
    if (region.kind === 'control') {
      return { kind: 'ui-candidate', owner: first.id, control: region.id, onsetT: t, samples: 1 };
    }
    if (onBoard(first)) {
      b.emit({ kind: 'stroke-begin', owner: first.id, at: first.pen, t });
      return { kind: 'pinch-candidate', owner: first.id, onsetT: t, samples: 1, last: first.pen, pathLength: 0 };
    }
    // Pinch on the strip background, outside, or out of reach: absorbed.
    return { kind: 'hover' };
  }
  if (b.config.fistEraseEnabled) {
    const fist = hands
      .filter((h) => h.usable && h.fist && b.flags(h.id).armed && !b.flags(h.id).pinched && onBoard(h))
      .sort((x, y) => x.id - y.id)[0];
    if (fist !== undefined) {
      const since = b.flags(fist.id).fistSince ?? t;
      b.emit({ kind: 'erase-arming', at: fist.pen, progress: Math.min(1, (t - since) / b.config.fistArmMs) });
      return { kind: 'erase-arming', owner: fist.id };
    }
  }
  return { kind: 'hover' };
}

/** Other hands' new pinches during an exclusive action are consumed. */
function holdOthers(b: Builder, hands: readonly HandSample[], except: readonly TrackId[]): void {
  for (const h of hands) {
    if (!except.includes(h.id) && b.flags(h.id).pinched) b.hold(h.id);
  }
}

function secondHandJoins(b: Builder, hands: readonly HandSample[], owner: TrackId): HandSample | undefined {
  return hands.find((h) => h.id !== owner && canStart(b, h) && onBoard(h));
}

/**
 * While paused, the board is never edited, but controls stay operable so a
 * hand can press Resume. Only control presses start; everything else is held.
 */
function pausedStep(
  b: Builder,
  state: ReducerState,
  hands: readonly HandSample[],
  byId: ReadonlyMap<TrackId, HandSample>,
  t: number,
  known: (id: TrackId) => boolean,
): Step {
  const mode = state.mode;
  let next: Mode = mode;
  if (mode.kind === 'ui-candidate' || mode.kind === 'ui-capture') {
    const o = byId.get(mode.owner);
    const f = b.flags(mode.owner);
    if (!known(mode.owner) || (o !== undefined && o.usable && !f.pinched)) {
      next = { kind: 'disabled' };
    } else if (mode.kind === 'ui-candidate' && o !== undefined && o.usable) {
      const samples = mode.samples + 1;
      if (samples >= b.config.confirmSamples && t - mode.onsetT >= b.config.confirmMs) {
        b.emit({ kind: 'control-activate', id: mode.control });
        next = { kind: 'ui-capture', owner: mode.owner };
      } else {
        next = { ...mode, samples };
      }
    } else if (mode.kind === 'ui-candidate' && (o === undefined || !o.usable)) {
      next = { kind: 'disabled' };
    }
  } else {
    const starter = hands.filter((h) => canStart(b, h)).sort((x, y) => x.id - y.id)[0];
    if (starter !== undefined) {
      b.hold(starter.id);
      if (starter.region.kind === 'control') {
        next = { kind: 'ui-candidate', owner: starter.id, control: starter.region.id, onsetT: t, samples: 1 };
      }
    }
  }
  return { state: { mode: next, tracks: b.tracks, paused: true }, intents: b.intents };
}

function frameStep(state: ReducerState, input: Extract<ReducerInput, { kind: 'frame' }>, config: GestureConfig): Step {
  const b = new Builder(state.tracks, config);
  const { t, hands, expired } = input;
  for (const id of expired) b.tracks.delete(id);
  for (const hand of hands) updateFlags(b, hand, t);
  const byId = new Map(hands.map((h) => [h.id, h]));
  const known = (id: TrackId): boolean => b.tracks.has(id);

  const mode = state.mode;
  if (state.paused) return pausedStep(b, state, hands, byId, t, known);

  let next: Mode = mode;
  switch (mode.kind) {
    case 'disabled':
    case 'hover':
      next = startFromHover(b, hands, t);
      break;

    case 'pinch-candidate': {
      const o = byId.get(mode.owner);
      const f = b.flags(mode.owner);
      const joiner = secondHandJoins(b, hands, mode.owner);
      if (joiner !== undefined && o !== undefined && o.usable && f.pinched && onBoard(o)) {
        b.emit({ kind: 'stroke-cancel' });
        b.hold(joiner.id);
        b.emit({ kind: 'transform-begin', a: o.pen, b: joiner.pen });
        next = { kind: 'transforming', a: mode.owner, b: joiner.id };
      } else if (o === undefined || !o.usable) {
        b.emit({ kind: 'stroke-cancel' });
        if (o?.ambiguous === true) b.disarm(mode.owner);
        next = known(mode.owner) ? { kind: 'await-release', waiting: [mode.owner] } : { kind: 'hover' };
      } else if (!f.pinched) {
        b.emit({ kind: 'stroke-cancel' });
        next = { kind: 'hover' };
      } else if (!onBoard(o)) {
        b.emit({ kind: 'stroke-cancel' });
        next = { kind: 'await-release', waiting: [mode.owner] };
      } else {
        b.emit({ kind: 'stroke-point', at: o.pen, t });
        const samples = mode.samples + 1;
        const pathLength = mode.pathLength + distance(mode.last, o.pen);
        if (samples >= b.config.confirmSamples && t - mode.onsetT >= b.config.confirmMs) {
          b.emit({ kind: 'stroke-confirm' });
          next = { kind: 'drawing', owner: mode.owner, onsetT: mode.onsetT, last: o.pen, lastT: t, pathLength, pending: [] };
        } else {
          next = { ...mode, samples, last: o.pen, pathLength };
        }
      }
      if (next.kind !== 'transforming') holdOthers(b, hands, [mode.owner]);
      break;
    }

    case 'drawing': {
      const o = byId.get(mode.owner);
      const f = b.flags(mode.owner);
      const joiner = secondHandJoins(b, hands, mode.owner);
      if (joiner !== undefined && o !== undefined && o.usable && f.pinched && onBoard(o)) {
        const early = t - mode.onsetT <= b.config.twoHandJoinWindowMs && mode.pathLength <= b.config.transformRollbackPathPx;
        if (mode.pending.length > 0) b.emit({ kind: 'stroke-preview', points: [] });
        b.emit({ kind: early ? 'stroke-cancel' : 'stroke-commit' });
        b.hold(joiner.id);
        b.emit({ kind: 'transform-begin', a: o.pen, b: joiner.pen });
        next = { kind: 'transforming', a: mode.owner, b: joiner.id };
        break;
      }
      holdOthers(b, hands, [mode.owner]);
      if (o === undefined || (!o.usable && !o.ambiguous)) {
        // Missing, invalid, or a suspected discontinuity: freeze the endpoint.
        if (mode.pending.length > 0) b.emit({ kind: 'stroke-preview', points: [] });
        next = {
          kind: 'suspended',
          owner: mode.owner,
          onsetT: mode.onsetT,
          last: mode.last,
          lastT: mode.lastT,
          pathLength: mode.pathLength,
        };
        break;
      }
      if (o.ambiguous) {
        b.emit({ kind: 'stroke-commit' });
        b.disarm(mode.owner);
        next = { kind: 'await-release', waiting: [mode.owner] };
        break;
      }
      if (!onBoard(o)) {
        // Crossing onto the strip or out of reach ends ink at the last valid
        // board sample; controls stay inactive until this pinch is released.
        b.emit({ kind: 'stroke-commit' });
        next = f.pinched ? { kind: 'await-release', waiting: [mode.owner] } : { kind: 'hover' };
        break;
      }
      if (!f.pinched) {
        // First reliable sample above the up threshold: stop immediately and
        // discard held-back opening samples (no release tails).
        b.emit({ kind: 'stroke-commit' });
        next = { kind: 'hover' };
        break;
      }
      let pending = mode.pending;
      let last = mode.last;
      let lastT = mode.lastT;
      let pathLength = mode.pathLength;
      const append = (p: Pending): void => {
        b.emit({ kind: 'stroke-point', at: p.at, t: p.t });
        pathLength += distance(last, p.at);
        last = p.at;
        lastT = p.t;
      };
      if (o.pinchRatio < b.config.pinchDownRatio) {
        pending.forEach(append);
        if (pending.length > 0) b.emit({ kind: 'stroke-preview', points: [] });
        pending = [];
        append({ at: o.pen, t });
      } else {
        // Inside the hysteresis band: possibly the hand starting to open.
        pending = [...pending, { at: o.pen, t }];
        if (t - pending[0]!.t > b.config.releaseHoldMs) {
          pending.forEach(append);
          pending = [];
        }
        b.emit({ kind: 'stroke-preview', points: pending.map((p) => p.at) });
      }
      next = { ...mode, last, lastT, pathLength, pending };
      break;
    }

    case 'suspended': {
      holdOthers(b, hands, [mode.owner]);
      const o = byId.get(mode.owner);
      const f = b.flags(mode.owner);
      if (t - mode.lastT > b.config.shortDropoutMs || !known(mode.owner)) {
        b.emit({ kind: 'stroke-commit' });
        next = known(mode.owner) ? { kind: 'await-release', waiting: [mode.owner] } : { kind: 'hover' };
      } else if (o === undefined || (!o.usable && !o.ambiguous)) {
        next = mode;
      } else if (o.ambiguous) {
        b.emit({ kind: 'stroke-commit' });
        b.disarm(mode.owner);
        next = { kind: 'await-release', waiting: [mode.owner] };
      } else if (f.pinched && onBoard(o) && distance(o.pen, mode.last) <= b.config.reconnectDistancePx) {
        b.emit({ kind: 'stroke-point', at: o.pen, t });
        next = {
          kind: 'drawing',
          owner: mode.owner,
          onsetT: mode.onsetT,
          last: o.pen,
          lastT: t,
          pathLength: mode.pathLength + distance(mode.last, o.pen),
          pending: [],
        };
      } else {
        b.emit({ kind: 'stroke-commit' });
        next = f.pinched ? { kind: 'await-release', waiting: [mode.owner] } : { kind: 'hover' };
      }
      break;
    }

    case 'transforming': {
      holdOthers(b, hands, [mode.a, mode.b]);
      const sa = byId.get(mode.a);
      const sb = byId.get(mode.b);
      const ok = (s: HandSample | undefined): s is HandSample => s !== undefined && s.usable && b.flags(s.id).pinched && s.inReach;
      if (ok(sa) && ok(sb)) {
        b.emit({ kind: 'transform-update', a: sa.pen, b: sb.pen });
      } else {
        b.emit({ kind: 'transform-end' });
        if (sa?.ambiguous === true) b.disarm(mode.a);
        if (sb?.ambiguous === true) b.disarm(mode.b);
        next = { kind: 'await-release', waiting: [mode.a, mode.b].filter(known) };
      }
      break;
    }

    case 'erase-arming': {
      holdOthers(b, hands, [mode.owner]);
      const o = byId.get(mode.owner);
      const f = b.flags(mode.owner);
      if (o !== undefined && o.usable && o.fist && !f.pinched && onBoard(o) && f.fistSince !== null && b.config.fistEraseEnabled) {
        const progress = (t - f.fistSince) / b.config.fistArmMs;
        if (progress >= 1) {
          b.emit({ kind: 'erase-begin', at: o.pen });
          next = { kind: 'erasing', owner: mode.owner };
        } else {
          b.emit({ kind: 'erase-arming', at: o.pen, progress });
        }
      } else {
        b.emit({ kind: 'erase-cancel' });
        next = { kind: 'hover' };
      }
      break;
    }

    case 'erasing': {
      holdOthers(b, hands, [mode.owner]);
      const o = byId.get(mode.owner);
      const f = b.flags(mode.owner);
      if (o !== undefined && o.usable && o.fist && !f.pinched && onBoard(o)) {
        b.emit({ kind: 'erase-move', at: o.pen });
      } else {
        b.emit({ kind: 'erase-end' });
        next = { kind: 'hover' };
      }
      break;
    }

    case 'ui-candidate': {
      holdOthers(b, hands, [mode.owner]);
      const o = byId.get(mode.owner);
      const f = b.flags(mode.owner);
      if (o === undefined || !o.usable) {
        if (o?.ambiguous === true) b.disarm(mode.owner);
        next = known(mode.owner) ? { kind: 'await-release', waiting: [mode.owner] } : { kind: 'hover' };
      } else if (!f.pinched) {
        next = { kind: 'hover' };
      } else {
        const samples = mode.samples + 1;
        if (samples >= b.config.confirmSamples && t - mode.onsetT >= b.config.confirmMs) {
          b.emit({ kind: 'control-activate', id: mode.control });
          next = { kind: 'ui-capture', owner: mode.owner };
        } else {
          next = { ...mode, samples };
        }
      }
      break;
    }

    case 'ui-capture': {
      holdOthers(b, hands, [mode.owner]);
      const o = byId.get(mode.owner);
      if (!known(mode.owner)) next = { kind: 'hover' };
      else if (o !== undefined && o.usable && !b.flags(mode.owner).pinched) next = { kind: 'hover' };
      break;
    }

    case 'await-release': {
      holdOthers(b, hands, mode.waiting);
      const waiting = mode.waiting.filter((id) => {
        if (!known(id)) return false; // expired: ownership ends (not a release)
        const o = byId.get(id);
        return !(o !== undefined && o.usable && !b.flags(id).pinched);
      });
      next = waiting.length === 0 ? { kind: 'hover' } : { kind: 'await-release', waiting };
      break;
    }
  }
  return { state: { mode: next, tracks: b.tracks, paused: false }, intents: b.intents };
}

export function reduce(state: ReducerState, input: ReducerInput, config: GestureConfig): Step {
  switch (input.kind) {
    case 'frame':
      return frameStep(state, input, config);
    case 'loss':
      return frameStep(state, { kind: 'frame', t: input.t, hands: [], expired: [] }, config);
    case 'interrupt': {
      const b = new Builder(state.tracks, config);
      closeInteraction(b, state.mode);
      if (state.mode.kind === 'drawing' && state.mode.pending.length > 0) {
        b.intents.unshift({ kind: 'stroke-preview', points: [] });
      }
      for (const id of [...b.tracks.keys()]) b.disarm(id);
      const paused = input.pause || state.paused;
      return {
        state: { mode: paused ? { kind: 'disabled' } : { kind: 'hover' }, tracks: b.tracks, paused },
        intents: b.intents,
      };
    }
    case 'resume': {
      if (!state.paused) return { state, intents: [] };
      // A hand that pressed Resume keeps its pinch captured until release.
      const keep = state.mode.kind === 'ui-candidate' || state.mode.kind === 'ui-capture';
      return { state: { ...state, mode: keep ? state.mode : { kind: 'hover' }, paused: false }, intents: [] };
    }
    case 'reset': {
      const b = new Builder(new Map(), config);
      closeInteraction(b, state.mode);
      if (state.mode.kind === 'drawing' && state.mode.pending.length > 0) {
        b.intents.unshift({ kind: 'stroke-preview', points: [] });
      }
      return {
        state: { mode: state.paused ? { kind: 'disabled' } : { kind: 'hover' }, tracks: new Map(), paused: state.paused },
        intents: b.intents,
      };
    }
  }
}

/** True when no document-editing interaction is in progress (settings may apply). */
export function isIdle(state: ReducerState): boolean {
  const k = state.mode.kind;
  return k === 'hover' || k === 'disabled' || k === 'await-release';
}
