/**
 * Hand input orchestration: tracking results → pipeline → reducer → intents.
 * Owns the reducer state, loss detection, and the cursor model. Every
 * accepted result is reduced in order (no down/up transition is skipped
 * because several results arrive before the next animation frame).
 */
import type { BoardController } from '../board/controller';
import type { Rect } from '../core/coords';
import {
  initialReducerState,
  isIdle,
  modeLabel,
  reduce,
  type Intent,
  type InterruptReason,
  type ModeLabel,
  type ReducerInput,
  type ReducerState,
} from '../input/hand-reducer';
import { applyIntents, surfaceToBoard } from '../input/intents';
import type { CursorMode, CursorView } from '../render/renderer';
import { HandPipeline, type CameraSize, type HandView, type SurfaceLayout } from '../tracking/hand-pipeline';
import type { HandPayload } from '../tracking/protocol';
import type { AppConfig } from './config';
import type { MetricsSink } from './metrics';

export interface HandInputDeps {
  readonly config: () => AppConfig;
  readonly controller: () => BoardController;
  readonly activateControl: (id: string) => void;
  readonly metrics: MetricsSink;
  readonly now: () => number;
  readonly onUpdate: () => void;
  /** Called for every reducer step (replay/recording hooks). */
  readonly onStep?: (input: ReducerInput, intents: readonly Intent[]) => void;
}

export class HandInput {
  readonly pipeline: HandPipeline;
  private stateValue: ReducerState = initialReducerState();
  private views: readonly HandView[] = [];
  private layoutValue: SurfaceLayout | null = null;
  private lastSourceT = 0;
  private lastReceivedAt: number | null = null;
  private lost = false;
  private armProgress = 0;
  private blocked = false;
  /** Disabled during dev replay, whose timeline already encodes losses. */
  lossCheckEnabled = true;
  /** Main-thread observation time of the newest applied result. */
  latestObservedAt: number | null = null;
  pendingDrawObservedAt: number | null = null;

  constructor(private readonly deps: HandInputDeps) {
    this.pipeline = new HandPipeline(deps.config());
  }

  get state(): ReducerState {
    return this.stateValue;
  }

  get hands(): readonly HandView[] {
    return this.views;
  }

  get trackingLost(): boolean {
    return this.lost;
  }

  get label(): ModeLabel {
    if (this.stateValue.paused) return 'Paused';
    if (this.lost) return 'Tracking lost';
    return modeLabel(this.stateValue);
  }

  get idle(): boolean {
    return isIdle(this.stateValue);
  }

  get boardRect(): Rect | null {
    return this.layoutValue?.board ?? null;
  }

  setLayout(layout: SurfaceLayout): void {
    const prev = this.layoutValue;
    this.layoutValue = layout;
    this.pipeline.setLayout(layout);
    const moved =
      prev !== null &&
      (prev.width !== layout.width || prev.height !== layout.height || prev.board.x !== layout.board.x || prev.board.y !== layout.board.y);
    // A remap mid-gesture would jump the pen: close interactions, require release.
    if (moved && !this.idle) this.interrupt('resize', false);
  }

  setConfig(config: AppConfig): void {
    this.pipeline.setConfig(config);
  }

  setCamera(camera: CameraSize): void {
    this.pipeline.setCamera(camera);
  }

  /** While a pointer gesture owns the board, hands update cursors only. */
  setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    if (blocked) this.interrupt('escape', false);
  }

  handleResult(sourceTimeMs: number, hands: readonly HandPayload[], observedAt: number): void {
    const started = this.deps.now();
    const ageMs = started - observedAt;
    const out = this.pipeline.process(sourceTimeMs, hands, ageMs);
    this.lastSourceT = sourceTimeMs;
    this.lastReceivedAt = started;
    if (out.stale) this.deps.metrics.count('staleResults');
    else this.deps.metrics.count('accepted');
    this.views = out.hands;
    this.lost = out.input.kind === 'loss';
    for (const h of out.hands) {
      if (h.outlier) this.deps.metrics.count('outliersFlagged');
      if (h.ambiguous) this.deps.metrics.count('identityAmbiguous');
    }
    if (!this.blocked || out.input.kind === 'loss') this.dispatch(out.input);
    this.latestObservedAt = observedAt;
    this.pendingDrawObservedAt = observedAt;
    this.deps.metrics.sample('inputMs', this.deps.now() - started);
    this.deps.onUpdate();
  }

  /** Called periodically: no fresh result for longer than the stale limit is loss. */
  checkLoss(now: number): void {
    if (this.lastReceivedAt === null || this.lost) return;
    const gap = now - this.lastReceivedAt;
    if (gap <= this.deps.config().gesture.staleResultMs) return;
    this.lost = true;
    this.views = [];
    this.dispatch({ kind: 'loss', t: this.lastSourceT + gap });
    this.deps.onUpdate();
  }

  interrupt(reason: InterruptReason, pause: boolean): void {
    this.dispatch({ kind: 'interrupt', reason, pause });
    this.deps.onUpdate();
  }

  resume(): void {
    this.dispatch({ kind: 'resume' });
    this.deps.onUpdate();
  }

  /** New source timeline or camera stop: forget identities and filters. */
  reset(): void {
    this.pipeline.reset();
    this.dispatch({ kind: 'reset' });
    this.views = [];
    this.lastReceivedAt = null;
    this.lost = false;
    this.deps.onUpdate();
  }

  dispatch(input: ReducerInput): void {
    const step = reduce(this.stateValue, input, this.deps.config().gesture);
    this.stateValue = step.state;
    for (const intent of step.intents) {
      if (intent.kind === 'erase-arming') this.armProgress = intent.progress;
    }
    const board = this.layoutValue?.board;
    if (board !== undefined) {
      applyIntents(step.intents, {
        controller: this.deps.controller(),
        boardRect: board,
        activateControl: this.deps.activateControl,
      });
    }
    this.deps.onStep?.(input, step.intents);
  }

  /** Cursors for hands over the board, in board-local CSS px. */
  cursors(): CursorView[] {
    const board = this.layoutValue?.board;
    if (board === undefined) return [];
    const c = this.deps.controller();
    const mode = this.stateValue.mode;
    const out: CursorView[] = [];
    const config = this.deps.config();
    for (const h of this.views) {
      if (!h.inReach) continue;
      const p = surfaceToBoard(h.pen, board);
      if (p.x < 0 || p.y < 0 || p.x > board.width || p.y > board.height) continue;
      const flags = this.stateValue.tracks.get(h.id);
      let cursorMode: CursorMode = 'hover';
      if (this.stateValue.paused) cursorMode = 'blocked';
      else if (mode.kind === 'transforming' && (mode.a === h.id || mode.b === h.id)) cursorMode = 'move';
      else if (mode.kind === 'drawing' && mode.owner === h.id) cursorMode = 'draw';
      else if (mode.kind === 'pinch-candidate' && mode.owner === h.id) cursorMode = 'pinch';
      else if (mode.kind === 'erase-arming' && mode.owner === h.id) cursorMode = 'erase-arming';
      else if (mode.kind === 'erasing' && mode.owner === h.id) cursorMode = 'erase';
      else if (flags === undefined || !flags.armed || (flags.held && flags.pinched) || !h.usable) cursorMode = 'blocked';
      out.push({
        id: h.id,
        x: p.x,
        y: p.y,
        color: c.color,
        diameter: c.widthPx,
        mode: cursorMode,
        progress: this.armProgress,
        eraserRadius: config.eraserRadiusPx,
      });
    }
    if (mode.kind === 'suspended') {
      const p = surfaceToBoard(mode.last, board);
      out.push({ id: -1, x: p.x, y: p.y, color: c.color, diameter: c.widthPx, mode: 'lost', progress: 0, eraserRadius: 0 });
    }
    return out;
  }
}
