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
 *             interrupt, for control pinches and fist erasing.
 *   writeArmed - a valid thumb/middle release has been observed for writing.
 *   pinched - hysteresis state (down below pinchDownRatio with a plausible
 *             pinch pose, up above pinchUpRatio).
 *   held    - this pinch was already used or blocked; it cannot start another
 *             action until the hand is observed released.
 */
import type { GestureConfig } from '../app/config';
import { distance, type SurfacePoint } from '../core/coords';
import type { WritingProximity } from '../tracking/features';

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
  readonly writingProximity: WritingProximity | null;
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

type WritingGesture = 'aligned' | 'proximity';

interface StrokeSample {
  readonly at: SurfacePoint;
  readonly t: number;
}

export type Mode =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'hover' }
  | {
      readonly kind: 'write-candidate';
      readonly owner: TrackId;
      readonly points: readonly StrokeSample[];
      readonly space: WritingProximity['space'];
      readonly gesture: WritingGesture;
    }
  | {
      readonly kind: 'drawing';
      readonly owner: TrackId;
      readonly onsetT: number;
      readonly last: SurfacePoint;
      readonly lastT: number;
      readonly space: WritingProximity['space'];
      readonly gesture: WritingGesture;
      readonly pathLength: number;
    }
  | { readonly kind: 'transforming'; readonly a: TrackId; readonly b: TrackId; readonly aSpace: WritingProximity['space']; readonly bSpace: WritingProximity['space']; readonly aGesture: WritingGesture; readonly bGesture: WritingGesture }
  | { readonly kind: 'erase-arming'; readonly owner: TrackId }
  | { readonly kind: 'erasing'; readonly owner: TrackId }
  | { readonly kind: 'ui-candidate'; readonly owner: TrackId; readonly control: string; readonly onsetT: number; readonly samples: number }
  | { readonly kind: 'ui-capture'; readonly owner: TrackId }
  | { readonly kind: 'await-release'; readonly waiting: readonly TrackId[]; readonly writing?: true };

export interface TrackFlags {
  readonly armed: boolean;
  readonly pinched: boolean;
  readonly held: boolean;
  readonly fistSince: number | null;
  readonly writeArmed: boolean;
  readonly writeSince: number | null;
  readonly lastWriteSample: number | null;
  readonly writeSpace: WritingProximity['space'] | null;
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
    case 'write-candidate':
      return 'Hover';
    case 'drawing':
      return 'Draw';
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
    case 'write-candidate':
    case 'drawing':
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
    return this.tracks.get(id) ?? {
      armed: false, pinched: false, held: false, fistSince: null,
      writeArmed: false, writeSince: null, lastWriteSample: null, writeSpace: null,
    };
  }

  hold(id: TrackId): void {
    this.tracks.set(id, { ...this.flags(id), held: true });
  }

  disarm(id: TrackId): void {
    this.tracks.set(id, { ...this.flags(id), armed: false, held: true, writeArmed: false, writeSince: null });
  }

  blockWriting(id: TrackId): void {
    this.tracks.set(id, { ...this.flags(id), writeArmed: false, writeSince: null });
  }
}

function startingGesture(proximity: WritingProximity, ratio: number): WritingGesture | null {
  if (proximity.aligned === true) return 'aligned';
  return proximity.ratio <= ratio ? 'proximity' : null;
}

function isWritingReleased(proximity: WritingProximity, ratio: number, gesture?: WritingGesture): boolean {
  if (gesture === 'aligned') return proximity.aligned !== true;
  if (gesture === 'proximity') return proximity.ratio >= ratio;
  return proximity.aligned !== true && proximity.ratio >= ratio;
}

function updateFlags(b: Builder, hand: HandSample, t: number): void {
  const g = b.config;
  const prev = b.flags(hand.id);
  if (!hand.usable) {
    // No evidence this frame: keep pinch state, break fist continuity.
    b.tracks.set(hand.id, { ...prev, fistSince: null, writeArmed: false, writeSince: null });
    return;
  }
  let pinched = prev.pinched;
  if (pinched && hand.pinchRatio > g.pinchUpRatio) pinched = false;
  else if (!pinched && hand.pinchRatio < g.pinchDownRatio && hand.pinchPose) pinched = true;
  const openHand = !pinched && Number.isFinite(hand.pinchRatio) && hand.pinchRatio > g.pinchUpRatio && !hand.fist;
  const fistSince = hand.fist && !pinched ? (prev.fistSince ?? t) : null;
  const proximity = hand.writingProximity;
  const released = !hand.fist && proximity !== null && isWritingReleased(proximity, g.writeReleaseRatio);
  const continuous = proximity !== null && proximity.space === prev.writeSpace &&
    prev.lastWriteSample !== null && t > prev.lastWriteSample && t - prev.lastWriteSample <= g.staleResultMs;
  const writeArmed = released || (continuous && prev.writeArmed && onBoard(hand) && !hand.fist);
  const withinStart = writeArmed && proximity !== null && startingGesture(proximity, g.writeStartRatio) !== null && !hand.fist && onBoard(hand);
  b.tracks.set(hand.id, {
    armed: prev.armed || openHand,
    pinched,
    held: pinched ? prev.held : false,
    fistSince,
    writeArmed,
    writeSince: withinStart ? (prev.writeSince ?? t) : null,
    lastWriteSample: proximity === null ? null : t,
    writeSpace: proximity?.space ?? null,
  });
}

/** A hand that may start a new action with this pinch. */
function canStartControl(b: Builder, hand: HandSample): boolean {
  const f = b.flags(hand.id);
  return hand.usable && f.armed && f.pinched && !f.held;
}

function onBoard(hand: HandSample): boolean {
  return hand.inReach && hand.region.kind === 'board';
}

/** Closes whatever interaction is active, preserving valid ink. */
function closeInteraction(b: Builder, mode: Mode): void {
  switch (mode.kind) {
    case 'drawing':
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
    case 'write-candidate':
    case 'ui-candidate':
    case 'ui-capture':
    case 'await-release':
    case 'hover':
    case 'disabled':
      return;
  }
}

function startFromHover(b: Builder, hands: readonly HandSample[], t: number): Mode {
  const control = hands.find((h) => h.region.kind === 'control' && canStartControl(b, h));
  if (control?.region.kind === 'control') {
    b.hold(control.id);
    return { kind: 'ui-candidate', owner: control.id, control: control.region.id, onsetT: t, samples: 1 };
  }
  const writer = hands.filter((h) => b.flags(h.id).writeSince !== null).sort((a, b) => a.id - b.id)[0];
  if (writer !== undefined && writer.writingProximity !== null) {
    const gesture = startingGesture(writer.writingProximity, b.config.writeStartRatio);
    if (gesture !== null) {
      return { kind: 'write-candidate', owner: writer.id, points: [{ at: writer.pen, t }], space: writer.writingProximity.space, gesture };
    }
  }
  // Consume a pinch begun away from controls so dragging onto one cannot click.
  holdOthers(b, hands, []);
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

function secondHandJoins(b: Builder, hands: readonly HandSample[], owner: TrackId, t: number): HandSample | undefined {
  return hands.find((h) => {
    const since = b.flags(h.id).writeSince;
    return h.id !== owner && since !== null && t - since >= b.config.writeConfirmMs;
  });
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
    const starter = hands.find((h) => h.region.kind === 'control' && canStartControl(b, h));
    if (starter !== undefined) {
      b.hold(starter.id);
      if (starter.region.kind === 'control') {
        next = { kind: 'ui-candidate', owner: starter.id, control: starter.region.id, onsetT: t, samples: 1 };
      }
    }
    holdOthers(b, hands, []);
  }
  return { state: { mode: next, tracks: b.tracks, paused: true }, intents: b.intents };
}

function frameStep(state: ReducerState, input: Extract<ReducerInput, { kind: 'frame' }>, config: GestureConfig): Step {
  const b = new Builder(state.tracks, config);
  const { t, hands, expired } = input;
  const byId = new Map(hands.map((h) => [h.id, h]));
  for (const id of expired) b.tracks.delete(id);
  for (const id of b.tracks.keys()) {
    if (!byId.has(id)) b.blockWriting(id);
  }
  const mode = state.mode;
  const allowsWriting = !state.paused && (mode.kind === 'hover' || mode.kind === 'write-candidate' || mode.kind === 'drawing');
  for (const hand of hands) {
    updateFlags(b, hand, t);
    if (!allowsWriting && b.flags(hand.id).writeSince !== null) b.blockWriting(hand.id);
  }
  const known = (id: TrackId): boolean => b.tracks.has(id);

  if (state.paused) return pausedStep(b, state, hands, byId, t, known);

  let next: Mode = mode;
  switch (mode.kind) {
    case 'disabled':
    case 'hover':
      next = startFromHover(b, hands, t);
      break;

    case 'write-candidate': {
      holdOthers(b, hands, []);
      const o = byId.get(mode.owner);
      const proximity = o?.writingProximity ?? null;
      const last = mode.points[mode.points.length - 1]!;
      const first = mode.points[0]!;
      if (o === undefined || !o.usable || proximity === null || proximity.space !== mode.space ||
          t - last.t > config.staleResultMs || !onBoard(o) || o.fist || startingGesture(proximity, config.writeStartRatio) !== mode.gesture) {
        next = { kind: 'hover' };
        break;
      }
      const points = [...mode.points, { at: o.pen, t }];
      if (t - first.t < config.writeConfirmMs) {
        next = { ...mode, points };
        break;
      }
      const joiner = secondHandJoins(b, hands, mode.owner, t);
      const joinerGesture = joiner?.writingProximity ? startingGesture(joiner.writingProximity, config.writeStartRatio) : null;
      if (joiner !== undefined && joiner.writingProximity !== null && joinerGesture !== null) {
        b.emit({ kind: 'transform-begin', a: o.pen, b: joiner.pen });
        next = { kind: 'transforming', a: o.id, b: joiner.id, aSpace: mode.space, bSpace: joiner.writingProximity.space, aGesture: mode.gesture, bGesture: joinerGesture };
        break;
      }
      b.emit({ kind: 'stroke-begin', owner: o.id, at: first.at, t: first.t });
      let pathLength = 0;
      for (let i = 1; i < points.length; i++) {
        const point = points[i]!;
        b.emit({ kind: 'stroke-point', ...point });
        pathLength += distance(points[i - 1]!.at, point.at);
      }
      b.emit({ kind: 'stroke-confirm' });
      next = { kind: 'drawing', owner: o.id, onsetT: first.t, last: o.pen, lastT: t, pathLength, space: mode.space, gesture: mode.gesture };
      break;
    }

    case 'drawing': {
      holdOthers(b, hands, []);
      const o = byId.get(mode.owner);
      const proximity = o?.writingProximity ?? null;
      if (o === undefined || !o.usable || proximity === null || proximity.space !== mode.space || t - mode.lastT > config.staleResultMs) {
        b.emit({ kind: 'stroke-commit' });
        if (known(mode.owner)) b.blockWriting(mode.owner);
        next = { kind: 'hover' };
        break;
      }
      const released = isWritingReleased(proximity, config.writeReleaseRatio, mode.gesture);
      if (released || !onBoard(o) || o.fist) {
        b.emit({ kind: 'stroke-commit' });
        if (!isWritingReleased(proximity, config.writeReleaseRatio)) {
          b.blockWriting(o.id);
          // Crossing into controls must not turn a writing gesture into a click.
          next = { kind: 'await-release', waiting: [o.id], writing: true };
        } else {
          next = { kind: 'hover' };
        }
        break;
      }
      const joiner = secondHandJoins(b, hands, mode.owner, t);
      const joinerGesture = joiner?.writingProximity ? startingGesture(joiner.writingProximity, config.writeStartRatio) : null;
      if (joiner !== undefined && joiner.writingProximity !== null && joinerGesture !== null) {
        const early = t - mode.onsetT <= config.twoHandJoinWindowMs && mode.pathLength <= config.transformRollbackPathPx;
        b.emit({ kind: early ? 'stroke-cancel' : 'stroke-commit' });
        b.emit({ kind: 'transform-begin', a: o.pen, b: joiner.pen });
        next = { kind: 'transforming', a: o.id, b: joiner.id, aSpace: mode.space, bSpace: joiner.writingProximity.space, aGesture: mode.gesture, bGesture: joinerGesture };
        break;
      }
      b.emit({ kind: 'stroke-point', at: o.pen, t });
      next = { ...mode, last: o.pen, lastT: t, pathLength: mode.pathLength + distance(mode.last, o.pen) };
      break;
    }

    case 'transforming': {
      holdOthers(b, hands, [mode.a, mode.b]);
      const sa = byId.get(mode.a);
      const sb = byId.get(mode.b);
      const ok = (hand: HandSample | undefined, space: WritingProximity['space'], gesture: WritingGesture): hand is HandSample =>
        hand !== undefined && hand.usable && hand.inReach && !hand.fist &&
        hand.writingProximity?.space === space && !isWritingReleased(hand.writingProximity, config.writeReleaseRatio, gesture);
      if (ok(sa, mode.aSpace, mode.aGesture) && ok(sb, mode.bSpace, mode.bGesture)) {
        b.emit({ kind: 'transform-update', a: sa.pen, b: sb.pen });
      } else {
        b.emit({ kind: 'transform-end' });
        if (sa?.ambiguous === true) b.disarm(mode.a);
        if (sb?.ambiguous === true) b.disarm(mode.b);
        next = { kind: 'await-release', waiting: [mode.a, mode.b].filter(known), writing: true };
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
        if (o === undefined || !o.usable) return true;
        if (mode.writing) return o.writingProximity === null || !isWritingReleased(o.writingProximity, config.writeReleaseRatio);
        return b.flags(id).pinched;
      });
      next = waiting.length === 0 ? { kind: 'hover' } : { ...mode, waiting };
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
