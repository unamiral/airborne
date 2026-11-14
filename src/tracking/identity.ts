/**
 * Stable application hand identities (plan §7).
 *
 * Detector output order is not an identity. Each frame, at most two valid
 * detections are associated with at most two tracks by comparing every
 * possible assignment using time-scaled palm proximity (with a bounded
 * velocity prediction), palm-size consistency, and weak handedness evidence.
 * When the two best assignments are too similar, the frame is ambiguous: the
 * caller must suspend editing for the involved tracks and require release.
 *
 * Positions and sizes are in camera pixels so identity does not depend on
 * the reach/viewport mapping.
 */
import type { XY } from '../core/coords';
import type { Handedness } from './protocol';

export interface Detection {
  readonly palm: XY;
  readonly palmSize: number;
  readonly handedness: Handedness;
  readonly handednessScore: number;
}

export interface Track {
  readonly id: number;
  readonly palm: XY;
  /** Camera px per ms. */
  readonly velocity: XY;
  readonly palmSize: number;
  readonly handedness: Handedness;
  readonly lastT: number;
  readonly firstT: number;
}

export interface IdentityConfig {
  readonly expiryMs: number;
  /** Speed cap for association prediction, camera px per ms. */
  readonly maxSpeed: number;
  /** Prediction horizon cap, ms. */
  readonly maxPredictMs: number;
  /** Base allowed motion in palm sizes, plus `gateGrowthPerMs` per ms elapsed. */
  readonly gateBase: number;
  readonly gateGrowthPerMs: number;
  /** Allowed palm-size ratio between frames. */
  readonly maxSizeRatio: number;
  /** Cost of starting a new track instead of matching (palm sizes). */
  readonly newTrackCost: number;
  /** Two assignments closer than this are ambiguous (palm sizes). */
  readonly ambiguityMargin: number;
  /** Penalty for confident handedness disagreement (palm sizes). */
  readonly handednessPenalty: number;
}

export const DEFAULT_IDENTITY_CONFIG: IdentityConfig = {
  expiryMs: 250,
  maxSpeed: 3,
  maxPredictMs: 100,
  gateBase: 1.5,
  gateGrowthPerMs: 0.03,
  maxSizeRatio: 1.6,
  newTrackCost: 3,
  ambiguityMargin: 0.35,
  handednessPenalty: 0.25,
};

export interface Association {
  /** Track id for each input detection, in input order. */
  readonly trackIds: readonly number[];
  readonly newTrackIds: readonly number[];
  readonly expiredTrackIds: readonly number[];
  /** Track ids whose identity is uncertain in this frame. */
  readonly ambiguousTrackIds: readonly number[];
}

function clampSpeed(v: XY, max: number): XY {
  const s = Math.hypot(v.x, v.y);
  return s <= max || s === 0 ? v : { x: (v.x / s) * max, y: (v.y / s) * max };
}

export class IdentityTracker {
  private list: Track[] = [];
  private nextId = 1;

  constructor(private readonly config: IdentityConfig = DEFAULT_IDENTITY_CONFIG) {}

  get tracks(): readonly Track[] {
    return this.list;
  }

  reset(): void {
    this.list = [];
  }

  /** Association cost in palm sizes; Infinity when implausible. */
  cost(track: Track, d: Detection, t: number): number {
    const c = this.config;
    const dt = Math.min(Math.max(t - track.lastT, 0), c.maxPredictMs);
    const v = clampSpeed(track.velocity, c.maxSpeed);
    const px = track.palm.x + v.x * dt;
    const py = track.palm.y + v.y * dt;
    const scale = Math.max(track.palmSize, d.palmSize, 1);
    const dist = Math.hypot(d.palm.x - px, d.palm.y - py) / scale;
    const gate = c.gateBase + c.gateGrowthPerMs * Math.max(t - track.lastT, 0);
    const ratio = d.palmSize / Math.max(track.palmSize, 1e-6);
    if (dist > gate || ratio > c.maxSizeRatio || ratio < 1 / c.maxSizeRatio) return Number.POSITIVE_INFINITY;
    let cost = dist + Math.abs(Math.log(ratio)) * 2;
    if (
      track.handedness !== 'Unknown' &&
      d.handedness !== 'Unknown' &&
      d.handedness !== track.handedness &&
      d.handednessScore > 0.8
    ) {
      cost += c.handednessPenalty;
    }
    return cost;
  }

  /** Associates up to two detections observed at time `t` (ms). */
  update(t: number, detections: readonly Detection[]): Association {
    const c = this.config;
    const expired = this.list.filter((tr) => t - tr.lastT > c.expiryMs).map((tr) => tr.id);
    if (expired.length > 0) this.list = this.list.filter((tr) => !expired.includes(tr.id));
    const tracks = this.list;
    const dets = detections.slice(0, 2);

    // Enumerate assignments: each detection maps to a distinct track index or -1 (new).
    const options: number[][] = [];
    const choices = [-1, ...tracks.map((_, i) => i)];
    if (dets.length === 0) options.push([]);
    else if (dets.length === 1) for (const a of choices) options.push([a]);
    else for (const a of choices) for (const b of choices) if (a === -1 || b === -1 || a !== b) options.push([a, b]);

    const scored = options
      .map((assignment) => {
        let total = 0;
        assignment.forEach((ti, di) => {
          total += ti === -1 ? c.newTrackCost : this.cost(tracks[ti]!, dets[di]!, t);
        });
        return { assignment, total };
      })
      .filter((o) => Number.isFinite(o.total))
      .sort((a, b) => a.total - b.total);
    const best = scored[0]?.assignment ?? dets.map(() => -1);

    // Ambiguity: another plausible assignment, nearly as good as the best,
    // in which some detection belongs to a different track or some track to
    // a different detection (e.g. crossed hands, or one hand that could be
    // either track).
    const ambiguous = new Set<number>();
    const bestTotal = scored[0]?.total ?? 0;
    const trackToDetection = (assignment: readonly number[]): Map<number, number> => {
      const map = new Map<number, number>();
      assignment.forEach((ti, di) => {
        if (ti !== -1) map.set(ti, di);
      });
      return map;
    };
    const bestMap = trackToDetection(best);
    for (const alt of scored.slice(1)) {
      if (alt.total - bestTotal >= c.ambiguityMargin) break;
      const altMap = trackToDetection(alt.assignment);
      if (altMap.size === 0 || altMap.size !== bestMap.size) continue;
      const detectionMoved = alt.assignment.some((ti, di) => ti !== -1 && best[di] !== -1 && ti !== best[di]);
      const trackMoved = [...altMap].some(([ti, di]) => bestMap.has(ti) && bestMap.get(ti) !== di);
      if (detectionMoved || trackMoved) {
        for (const ti of [...altMap.keys(), ...bestMap.keys()]) ambiguous.add(tracks[ti]!.id);
      }
    }

    const trackIds: number[] = [];
    const newTrackIds: number[] = [];
    const next: Track[] = tracks.filter((_, i) => !best.includes(i));
    best.forEach((ti, di) => {
      const d = dets[di]!;
      if (ti === -1) {
        const track: Track = {
          id: this.nextId++,
          palm: d.palm,
          velocity: { x: 0, y: 0 },
          palmSize: d.palmSize,
          handedness: d.handedness,
          lastT: t,
          firstT: t,
        };
        next.push(track);
        trackIds.push(track.id);
        newTrackIds.push(track.id);
        return;
      }
      const prev = tracks[ti]!;
      const dt = t - prev.lastT;
      const raw = dt > 0 ? { x: (d.palm.x - prev.palm.x) / dt, y: (d.palm.y - prev.palm.y) / dt } : prev.velocity;
      next.push({
        id: prev.id,
        palm: d.palm,
        velocity: { x: 0.5 * prev.velocity.x + 0.5 * raw.x, y: 0.5 * prev.velocity.y + 0.5 * raw.y },
        palmSize: 0.7 * prev.palmSize + 0.3 * d.palmSize,
        handedness: d.handednessScore > 0.8 ? d.handedness : prev.handedness,
        lastT: t,
        firstT: prev.firstT,
      });
      trackIds.push(prev.id);
    });
    this.list = next.sort((a, b) => a.id - b.id);
    return { trackIds, newTrackIds, expiredTrackIds: expired, ambiguousTrackIds: [...ambiguous] };
  }
}
