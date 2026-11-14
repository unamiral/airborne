import { distance, type XY } from '../core/coords';
import type { HandSample } from './hand-reducer';

export interface FrameCorner {
  readonly origin: XY;
  readonly index: XY;
  readonly thumb: XY;
  readonly size: number;
}

interface HeldFrame {
  readonly a: number;
  readonly b: number;
  readonly since: number;
  readonly lastSeen: number;
}

export interface SnapshotFrameState {
  readonly held: HeldFrame | null;
  readonly latched: boolean;
  readonly releasedAt: number | null;
}

export const INITIAL_FRAME: SnapshotFrameState = { held: null, latched: false, releasedAt: null };
const HOLD_MS = 420;
const RELEASE_MS = 220;

const dot = (a: XY, b: XY): number => a.x * b.x + a.y * b.y;

function formsFrame(a: FrameCorner, b: FrameCorner): boolean {
  const separation = distance(a.origin, b.origin);
  const size = (a.size + b.size) / 2;
  if (separation < 1.55 * size || Math.min(a.size, b.size) < 0.63 * size) return false;
  const across = { x: (b.origin.x - a.origin.x) / separation, y: (b.origin.y - a.origin.y) / separation };
  // Thumbs point inward. Index fingers trace the side edges, either both
  // upward like a viewfinder or in opposite directions at diagonal corners.
  return dot(a.thumb, across) >= 0.28 && dot(b.thumb, across) <= -0.28 &&
    dot(a.thumb, b.thumb) <= -0.4 && Math.abs(dot(a.index, b.index)) >= 0.6;
}

export function observeSnapshotFrame(
  state: SnapshotFrameState,
  hands: readonly HandSample[],
  t: number,
  maxGapMs: number,
): { state: SnapshotFrameState; fired: boolean } {
  const [a, b] = hands;
  const matching = hands.length === 2 && a?.frameCorner !== undefined && b?.frameCorner !== undefined &&
    (a.palmUsable ?? a.usable) && (b.palmUsable ?? b.usable) && formsFrame(a.frameCorner, b.frameCorner);
  if (state.latched) {
    const releasedAt = matching ? null : state.releasedAt ?? t;
    return {
      state: releasedAt !== null && t - releasedAt >= RELEASE_MS ? INITIAL_FRAME : { ...state, releasedAt },
      fired: false,
    };
  }
  if (!matching) {
    // Keep progress across one missed observation, but never capture without
    // seeing both corners again.
    const lastSeen = state.held?.lastSeen;
    const briefGap = lastSeen !== undefined && t > lastSeen && t - lastSeen <= Math.min(maxGapMs, 70);
    return { state: briefGap ? state : INITIAL_FRAME, fired: false };
  }
  const previous = state.held;
  const continuous = previous?.a === a.id && previous.b === b.id && t > previous.lastSeen && t - previous.lastSeen <= maxGapMs;
  const since = continuous ? previous.since : t;
  const fired = t - since >= HOLD_MS;
  return { state: { held: { a: a.id, b: b.id, since, lastSeen: t }, latched: fired, releasedAt: null }, fired };
}
