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
import { INITIAL_CLAP, clapHandsSeparated, observeClap, type ClapHand, type ClapState } from './clap';
import { INITIAL_FRAME, observeSnapshotFrame, type FrameCorner, type SnapshotFrameState } from './snapshot-frame';

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
  readonly extended?: boolean;
  readonly palm?: SurfacePoint;
  readonly palmUsable?: boolean;
  readonly palmRegion?: Region;
  readonly clap?: ClapHand | undefined;
  readonly frameCorner?: FrameCorner | undefined;
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
  | { readonly kind: 'snapshot' }
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
  | { readonly kind: 'transforming'; readonly a: TrackId; readonly b: TrackId; readonly lastT: number; readonly needsRebase?: true }
  | { readonly kind: 'erase-arming'; readonly owner: TrackId }
  | { readonly kind: 'erasing'; readonly owner: TrackId }
  | { readonly kind: 'ui-candidate'; readonly owner: TrackId; readonly control: string; readonly onsetT: number; readonly samples: number }
  | { readonly kind: 'ui-capture'; readonly owner: TrackId }
  | { readonly kind: 'await-release'; readonly waiting: readonly TrackId[]; readonly writing?: true; readonly extended?: true; readonly afterClap?: true };

export interface TrackFlags {
  readonly armed: boolean;
  readonly pinched: boolean;
  readonly held: boolean;
  readonly fistSince: number | null;
  readonly lastFistSample: number | null;
  readonly extendedSince: number | null;
  readonly lastExtendedSample: number | null;
  readonly writeArmed: boolean;
  readonly writeSince: number | null;
  readonly lastWriteSample: number | null;
  readonly writeSpace: WritingProximity['space'] | null;
}

export interface ReducerState {
  readonly mode: Mode;
  readonly tracks: ReadonlyMap<TrackId, TrackFlags>;
  readonly paused: boolean;
  readonly clap: ClapState;
  readonly snapshotFrame: SnapshotFrameState;
}

export interface Step {
  readonly state: ReducerState;
  readonly intents: readonly Intent[];
}

export function initialReducerState(paused = false): ReducerState {
  return { mode: paused ? { kind: 'disabled' } : { kind: 'hover' }, tracks: new Map(), paused, clap: INITIAL_CLAP, snapshotFrame: INITIAL_FRAME };
}

/** Coarse mode label for the UI (plan §4). */
export type ModeLabel = 'Hover' | 'Draw' | 'Move' | 'Eraser readying' | 'Erase' | 'Paused' | 'Tracking lost' | 'Controls' | 'Hold frame to save' | 'Release frame';

export function modeLabel(state: ReducerState): ModeLabel {
  if (state.snapshotFrame.latched) return 'Release frame';
  if (state.snapshotFrame.held !== null) return 'Hold frame to save';
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
      armed: false, pinched: false, held: false, fistSince: null, lastFistSample: null,
      extendedSince: null, lastExtendedSample: null, writeArmed: false, writeSince: null, lastWriteSample: null, writeSpace: null,
    };
  }

  hold(id: TrackId): void {
    this.tracks.set(id, { ...this.flags(id), held: true });
  }

  disarm(id: TrackId): void {
    this.tracks.set(id, { ...this.flags(id), armed: false, held: true, fistSince: null, lastFistSample: null, extendedSince: null, lastExtendedSample: null, writeArmed: false, writeSince: null });
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
  if (!(hand.palmUsable ?? hand.usable)) {
    // No evidence this frame: keep pinch state, break fist continuity.
    b.tracks.set(hand.id, { ...prev, fistSince: null, lastFistSample: null, extendedSince: null, lastExtendedSample: null, writeArmed: false, writeSince: null });
    return;
  }
  let pinched = prev.pinched;
  if (pinched && hand.pinchRatio > g.pinchUpRatio) pinched = false;
  else if (!pinched && hand.pinchRatio < g.pinchDownRatio && hand.pinchPose) pinched = true;
  const openHand = !pinched && Number.isFinite(hand.pinchRatio) && hand.pinchRatio > g.pinchUpRatio && !hand.fist;
  const fist = hand.fist && palmOnBoard(hand);
  const fistContinuous = prev.lastFistSample !== null && t > prev.lastFistSample &&
    t - prev.lastFistSample <= g.staleResultMs;
  const fistSince = fist ? (fistContinuous ? prev.fistSince ?? t : t) : null;
  const extended = canTransform(hand);
  const extendedSince = extended && prev.lastExtendedSample !== null && t > prev.lastExtendedSample &&
    t - prev.lastExtendedSample <= g.staleResultMs ? prev.extendedSince ?? t : t;
  const proximity = hand.writingProximity;
  const released = hand.usable && !hand.fist && proximity !== null && isWritingReleased(proximity, g.writeReleaseRatio);
  const continuous = proximity !== null && proximity.space === prev.writeSpace &&
    prev.lastWriteSample !== null && t > prev.lastWriteSample && t - prev.lastWriteSample <= g.staleResultMs;
  const writeArmed = released || (hand.usable && continuous && prev.writeArmed && onBoard(hand) && !hand.fist);
  const withinStart = writeArmed && proximity !== null && startingGesture(proximity, g.writeStartRatio) !== null && !hand.fist && onBoard(hand);
  b.tracks.set(hand.id, {
    armed: prev.armed || openHand,
    pinched,
    held: pinched ? prev.held : false,
    fistSince,
    lastFistSample: fist ? t : null,
    extendedSince: extended ? extendedSince : null,
    lastExtendedSample: extended ? t : null,
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

function palmPoint(hand: HandSample): SurfacePoint {
  return hand.palm ?? hand.pen;
}

function palmOnBoard(hand: HandSample): boolean {
  return hand.palmRegion === undefined ? onBoard(hand) : hand.palmRegion.kind === 'board';
}

function canTransform(hand: HandSample | undefined): hand is HandSample {
  return hand !== undefined && (hand.palmUsable ?? hand.usable) && hand.extended === true && !hand.fist && palmOnBoard(hand);
}

function beginTransform(b: Builder, a: HandSample, other: HandSample, t: number): Mode {
  b.emit({ kind: 'transform-begin', a: palmPoint(a), b: palmPoint(other) });
  return { kind: 'transforming', a: a.id, b: other.id, lastT: t };
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

function startFromHover(b: Builder, hands: readonly HandSample[], pair: readonly HandSample[], t: number): Mode {
  const control = hands.find((h) => h.region.kind === 'control' && canStartControl(b, h));
  if (control?.region.kind === 'control') {
    b.hold(control.id);
    return { kind: 'ui-candidate', owner: control.id, control: control.region.id, onsetT: t, samples: 1 };
  }
  if (pair.length === 2) return beginTransform(b, pair[0]!, pair[1]!, t);
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
      .filter((h) => (h.palmUsable ?? h.usable) && h.fist && b.flags(h.id).armed && palmOnBoard(h))
      .sort((x, y) => x.id - y.id)[0];
    if (fist !== undefined) {
      const since = b.flags(fist.id).fistSince ?? t;
      b.emit({ kind: 'erase-arming', at: palmPoint(fist), progress: Math.min(1, (t - since) / b.config.fistArmMs) });
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
  return { state: { mode: next, tracks: b.tracks, paused: true, clap: INITIAL_CLAP, snapshotFrame: INITIAL_FRAME }, intents: b.intents };
}

function frameStep(state: ReducerState, input: Extract<ReducerInput, { kind: 'frame' }>, config: GestureConfig): Step {
  const b = new Builder(state.tracks, config);
  const { t, hands, expired } = input;
  const byId = new Map(hands.map((h) => [h.id, h]));
  for (const id of expired) b.tracks.delete(id);
  for (const id of b.tracks.keys()) {
    if (!byId.has(id)) {
      b.blockWriting(id);
      b.tracks.set(id, { ...b.flags(id), fistSince: null, lastFistSample: null, extendedSince: null, lastExtendedSample: null });
    }
  }
  const mode = state.mode;
  const allowsWriting = !state.paused && (mode.kind === 'hover' || mode.kind === 'write-candidate' || mode.kind === 'drawing');
  for (const hand of hands) {
    updateFlags(b, hand, t);
    if (!allowsWriting && b.flags(hand.id).writeSince !== null) b.blockWriting(hand.id);
  }
  const known = (id: TrackId): boolean => b.tracks.has(id);

  if (state.paused) return pausedStep(b, state, hands, byId, t, known);

  const ordered = hands.length === 2 && hands[0]!.id > hands[1]!.id ? [hands[1]!, hands[0]!] : hands;
  const framing = mode.kind === 'ui-candidate' || mode.kind === 'ui-capture'
    ? { state: INITIAL_FRAME, fired: false }
    : observeSnapshotFrame(state.snapshotFrame, ordered, t, config.staleResultMs);
  if (framing.state.held !== null) {
    closeInteraction(b, mode);
    for (const hand of hands) b.blockWriting(hand.id);
    holdOthers(b, hands, []);
    if (framing.fired) b.emit({ kind: 'snapshot' });
    return {
      state: { mode: { kind: 'hover' }, tracks: b.tracks, paused: false, clap: INITIAL_CLAP, snapshotFrame: framing.state },
      intents: b.intents,
    };
  }

  const clapAllowed = mode.kind === 'hover' || mode.kind === 'transforming' ||
    (mode.kind === 'await-release' && mode.extended === true);
  const clap = clapAllowed
    ? observeClap(state.clap, ordered, t, config.staleResultMs)
    : { state: { ...state.clap, approach: null }, fired: false, approaching: false };
  if (clap.fired) {
    closeInteraction(b, mode);
    b.emit({ kind: 'snapshot' });
    const waiting = mode.kind === 'transforming' ? [mode.a, mode.b] :
      mode.kind === 'await-release' ? mode.waiting : hands.map((h) => h.id);
    const next: Mode = { kind: 'await-release', waiting, extended: true, afterClap: true };
    return { state: { mode: next, tracks: b.tracks, paused: false, clap: clap.state, snapshotFrame: framing.state }, intents: b.intents };
  }
  const pair = clap.approaching || t < clap.state.cooldownUntil ? [] : hands.filter((h) => {
    const since = b.flags(h.id).extendedSince;
    return canTransform(h) && since !== null && t - since >= config.writeConfirmMs;
  });

  let next: Mode = mode;
  switch (mode.kind) {
    case 'disabled':
    case 'hover':
      next = startFromHover(b, hands, pair, t);
      break;

    case 'write-candidate': {
      // Give simultaneous extended hands time to claim the transform before
      // provisional writing is committed.
      if (pair.length === 2) {
        next = beginTransform(b, pair[0]!, pair[1]!, t);
        break;
      }
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
      if (pair.length === 2 && pair.some((h) => h.id === mode.owner) &&
          t - mode.lastT <= config.staleResultMs) {
        const early = t - mode.onsetT <= config.twoHandJoinWindowMs && mode.pathLength <= config.transformRollbackPathPx;
        b.emit({ kind: early ? 'stroke-cancel' : 'stroke-commit' });
        next = beginTransform(b, pair[0]!, pair[1]!, t);
        break;
      }
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
        if (!o.fist && !isWritingReleased(proximity, config.writeReleaseRatio)) {
          b.blockWriting(o.id);
          // Crossing into controls must not turn a writing gesture into a click.
          next = { kind: 'await-release', waiting: [o.id], writing: true };
        } else {
          next = { kind: 'hover' };
        }
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
      if (canTransform(sa) && canTransform(sb) && t - mode.lastT <= config.staleResultMs) {
        if (clap.approaching) {
          next = { ...mode, lastT: t, needsRebase: true };
        } else if (mode.needsRebase === true) {
          b.emit({ kind: 'transform-end' });
          next = beginTransform(b, sa, sb, t);
        } else {
          b.emit({ kind: 'transform-update', a: palmPoint(sa), b: palmPoint(sb) });
          next = { ...mode, lastT: t };
        }
      } else if (sa !== undefined && sb !== undefined &&
          (sa.palmUsable ?? sa.usable) && (sb.palmUsable ?? sb.usable) &&
          !sa.fist && !sb.fist && palmOnBoard(sa) && palmOnBoard(sb) &&
          t - mode.lastT <= Math.min(config.staleResultMs, 70)) {
        // A brief pose-estimation flicker leaves the last stable view in place.
        next = { ...mode, needsRebase: true };
      } else {
        b.emit({ kind: 'transform-end' });
        if (sa?.ambiguous === true) b.disarm(mode.a);
        if (sb?.ambiguous === true) b.disarm(mode.b);
        next = { kind: 'await-release', waiting: [mode.a, mode.b].filter(known), extended: true };
      }
      break;
    }

    case 'erase-arming': {
      holdOthers(b, hands, [mode.owner]);
      const o = byId.get(mode.owner);
      const f = b.flags(mode.owner);
      if (o !== undefined && (o.palmUsable ?? o.usable) && o.fist && palmOnBoard(o) && f.fistSince !== null && b.config.fistEraseEnabled) {
        const progress = (t - f.fistSince) / b.config.fistArmMs;
        if (progress >= 1) {
          b.emit({ kind: 'erase-begin', at: palmPoint(o) });
          next = { kind: 'erasing', owner: mode.owner };
        } else {
          b.emit({ kind: 'erase-arming', at: palmPoint(o), progress });
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
      if (o !== undefined && (o.palmUsable ?? o.usable) && o.fist && palmOnBoard(o)) {
        b.emit({ kind: 'erase-move', at: palmPoint(o) });
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
      if (mode.extended) {
        // Both hands must be present and extended to retain the transform.
        // After a visible release, allow a fresh two-hand gesture.
        for (const h of hands) b.blockWriting(h.id);
        const [a, other] = mode.waiting.map((id) => byId.get(id));
        const released = mode.waiting.some((id) => {
          const hand = byId.get(id);
          return !known(id) || (hand !== undefined && (hand.palmUsable ?? hand.usable) && hand.extended !== true);
        });
        if (released || (mode.afterClap && a !== undefined && other !== undefined && (a.palmUsable ?? a.usable) && (other.palmUsable ?? other.usable) && clapHandsSeparated(a, other))) {
          next = { kind: 'hover' };
        }
        break;
      }
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
  return { state: { mode: next, tracks: b.tracks, paused: false, clap: clap.state, snapshotFrame: framing.state }, intents: b.intents };
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
        state: { mode: paused ? { kind: 'disabled' } : { kind: 'hover' }, tracks: b.tracks, paused, clap: INITIAL_CLAP, snapshotFrame: INITIAL_FRAME },
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
        state: { mode: state.paused ? { kind: 'disabled' } : { kind: 'hover' }, tracks: new Map(), paused: state.paused, clap: INITIAL_CLAP, snapshotFrame: INITIAL_FRAME },
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
