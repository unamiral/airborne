/**
 * Observation → intent input (plan §8.1 steps 1–5). Pure and DOM-free so the
 * same code runs live and in deterministic replay.
 *
 *   validate → features → identity → map pen to surface → discontinuity
 *   check (raw) → One Euro (per track, seconds/CSS px) → region routing
 *
 * Gesture features (pinch ratio, fist) bypass the coordinate filter so heavy
 * smoothing never delays pen-up or shifts thresholds. Rejected outliers do
 * not touch the filter or the residual history.
 */
import { oneEuroFor, type AppConfig } from '../app/config';
import { surfacePoint, type Rect, type SurfacePoint } from '../core/coords';
import type { HandSample, ReducerInput, Region } from '../input/hand-reducer';
import { SurfaceMapping, type MappingInput } from '../input/mapping';
import { DiscontinuityDetector } from '../signal/discontinuity';
import { PointFilter } from '../signal/one-euro';
import { DEFAULT_FEATURE_CONFIG, extractFeatures, type FeatureConfig, type HandFeatures } from './features';
import { DEFAULT_IDENTITY_CONFIG, IdentityTracker, type Detection } from './identity';
import type { HandPayload } from './protocol';

export interface SurfaceLayout {
  readonly width: number;
  readonly height: number;
  /** Board canvas rectangle within the surface. */
  readonly board: Rect;
  /** Control hit regions are resolved before board coordinates. */
  readonly hitTest: (p: SurfacePoint) => Region;
}

export interface CameraSize {
  readonly width: number;
  readonly height: number;
}

/** Per-hand information for cursors, preview, and diagnostics. */
export interface HandView {
  readonly id: number;
  readonly pen: SurfacePoint;
  readonly rawPen: SurfacePoint;
  readonly palm: SurfacePoint;
  readonly usable: boolean;
  readonly inReach: boolean;
  readonly outlier: boolean;
  readonly ambiguous: boolean;
  readonly features: HandFeatures;
}

export interface PipelineOutput {
  readonly input: ReducerInput;
  readonly hands: readonly HandView[];
  readonly stale: boolean;
}

interface TrackState {
  readonly filter: PointFilter;
  readonly palmFilter: PointFilter;
  readonly detector: DiscontinuityDetector;
  lastPen: SurfacePoint | null;
}

/**
 * Region routing: controls first, then overlays that absorb pinches (cards
 * drawn over the board), then the board, then the rest of the surface.
 */
export function regionFromLayout(
  board: Rect,
  controls: ReadonlyArray<{ id: string; rect: Rect }>,
  width: number,
  height: number,
  absorbers: readonly Rect[] = [],
) {
  const inside = (r: Rect, p: SurfacePoint): boolean => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
  return (p: SurfacePoint): Region => {
    for (const c of controls) {
      if (inside(c.rect, p)) return { kind: 'control', id: c.id };
    }
    if (absorbers.some((r) => inside(r, p))) return { kind: 'strip' };
    if (inside(board, p)) return { kind: 'board' };
    if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) return { kind: 'strip' };
    return { kind: 'outside' };
  };
}

export class HandPipeline {
  private readonly identity: IdentityTracker;
  private readonly tracks = new Map<number, TrackState>();
  private mapping: SurfaceMapping | null = null;
  private layout: SurfaceLayout | null = null;
  private camera: CameraSize | null = null;

  constructor(
    private config: AppConfig,
    private readonly featureConfig: FeatureConfig = DEFAULT_FEATURE_CONFIG,
  ) {
    this.identity = new IdentityTracker({ ...DEFAULT_IDENTITY_CONFIG, expiryMs: config.gesture.trackExpiryMs });
  }

  get currentMapping(): SurfaceMapping | null {
    return this.mapping;
  }

  /** Applies new settings. Call only at an idle boundary. */
  setConfig(config: AppConfig): void {
    const remap = config.reach !== this.config.reach;
    this.config = config;
    const params = oneEuroFor(config);
    for (const t of this.tracks.values()) {
      t.filter.setParams(params);
      t.palmFilter.setParams(params);
    }
    if (remap) this.remap();
  }

  /** Updates surface geometry; any mapping change resets filter histories. */
  setLayout(layout: SurfaceLayout): void {
    this.layout = layout;
    this.remap();
  }

  setCamera(camera: CameraSize): void {
    if (this.camera?.width === camera.width && this.camera.height === camera.height) return;
    this.camera = camera;
    this.remap();
  }

  /** New source timeline or identity space. */
  reset(): void {
    this.identity.reset();
    this.tracks.clear();
  }

  private remap(): void {
    if (this.layout === null || this.camera === null) {
      this.mapping = null;
      return;
    }
    const input: MappingInput = {
      cameraWidth: this.camera.width,
      cameraHeight: this.camera.height,
      surfaceWidth: this.layout.width,
      surfaceHeight: this.layout.height,
      reach: this.config.reach,
    };
    if (this.mapping?.equals(input) === true) return;
    this.mapping = new SurfaceMapping(input);
    for (const t of this.tracks.values()) {
      t.filter.reset();
      t.palmFilter.reset();
      t.detector.reset();
      t.lastPen = null;
    }
  }

  private track(id: number): TrackState {
    let state = this.tracks.get(id);
    if (state === undefined) {
      state = {
        filter: new PointFilter(oneEuroFor(this.config), this.config.gesture.trackExpiryMs / 1000),
        palmFilter: new PointFilter(oneEuroFor(this.config), this.config.gesture.trackExpiryMs / 1000),
        detector: new DiscontinuityDetector(this.config.outlier),
        lastPen: null,
      };
      this.tracks.set(id, state);
    }
    return state;
  }

  /**
   * Converts one accepted tracking result into reducer input.
   * `ageMs` is the software result age (main-thread receive − observation).
   */
  process(sourceTimeMs: number, hands: readonly HandPayload[], ageMs: number): PipelineOutput {
    const t = sourceTimeMs;
    const mapping = this.mapping;
    const layout = this.layout;
    const camera = this.camera;
    if (ageMs > this.config.gesture.maxResultAgeMs || mapping === null || layout === null || camera === null) {
      return { input: { kind: 'loss', t }, hands: [], stale: ageMs > this.config.gesture.maxResultAgeMs };
    }
    const features = hands.map((h) => extractFeatures(h, camera.width, camera.height, this.featureConfig));
    const validIndex: number[] = [];
    const detections: Detection[] = [];
    features.forEach((f, i) => {
      if (!f.valid) return;
      validIndex.push(i);
      detections.push({
        palm: { x: f.palm.x * camera.width, y: f.palm.y * camera.height },
        palmSize: f.palmSizePx,
        handedness: hands[i]!.handedness,
        handednessScore: hands[i]!.handednessScore,
      });
    });
    const association = this.identity.update(t, detections);
    for (const id of association.expiredTrackIds) this.tracks.delete(id);
    const ambiguous = new Set(association.ambiguousTrackIds);
    for (const id of ambiguous) {
      const s = this.tracks.get(id);
      if (s !== undefined) {
        s.filter.reset();
        s.palmFilter.reset();
        s.detector.reset();
      }
    }

    const samples: HandSample[] = [];
    const views: HandView[] = [];
    association.trackIds.forEach((id, k) => {
      const f = features[validIndex[k]!]!;
      const state = this.track(id);
      const raw = mapping.toSurface(f.pen.x, f.pen.y);
      const palm = mapping.toSurface(f.palm.x, f.palm.y).point;
      const palmSize = mapping.cameraLengthToSurface(f.palmSizePx);
      const observation = { t, pen: raw.point, palm, palmSize };
      const verdict = state.detector.check(observation);
      const outlier = verdict.outlier && this.config.outlier.rejectOutliers;
      let pen: SurfacePoint | null = state.lastPen;
      if (!outlier) {
        state.detector.accept(observation, verdict.residual);
        const filtered = state.filter.filter(raw.point.x, raw.point.y, t / 1000);
        if (filtered !== null) pen = surfacePoint(filtered.x, filtered.y);
      }
      const isAmbiguous = ambiguous.has(id);
      const usable = !outlier && !isAmbiguous && pen !== null;
      // Fingertip-only discontinuities are common as the hand opens or
      // closes. The identity tracker separately gates palm jumps.
      const palmUsable = !isAmbiguous;
      const filteredPalm = palmUsable ? state.palmFilter.filter(palm.x, palm.y, t / 1000) : null;
      const gesturePalm = filteredPalm === null ? palm : surfacePoint(filteredPalm.x, filteredPalm.y);
      const palmRegion = layout.hitTest(gesturePalm);
      const shown = pen ?? raw.point;
      state.lastPen = shown;
      const inReach = shown.x >= 0 && shown.y >= 0 && shown.x <= layout.width && shown.y <= layout.height;
      samples.push({
        id,
        usable,
        ambiguous: isAmbiguous,
        pinchRatio: f.pinchRatio,
        pinchPose: f.pinchPose,
        writingProximity: raw.inReach ? f.writingProximity : null,
        fist: f.fist,
        extended: f.extended,
        frameCorner: f.frameCorner,
        palm: gesturePalm,
        palmUsable,
        palmRegion,
        clap: f.palmNormal === null ? undefined : {
          // Camera coordinates keep the clap independent of reach and zoom.
          center: { x: f.palm.x * camera.width, y: f.palm.y * camera.height },
          size: f.palmSizePx,
          normal: { x: f.palmNormal[0], y: f.palmNormal[1] },
        },
        pen: shown,
        inReach,
        region: inReach ? layout.hitTest(shown) : { kind: 'outside' },
      });
      views.push({ id, pen: shown, rawPen: raw.point, palm: gesturePalm, usable, inReach, outlier: verdict.outlier, ambiguous: isAmbiguous, features: f });
    });
    return {
      input: { kind: 'frame', t, hands: samples, expired: association.expiredTrackIds },
      hands: views,
      stale: false,
    };
  }
}
