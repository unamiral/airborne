/**
 * Deterministic replay (plan §5, §14): runs a replay record through the same
 * pipeline → reducer → board controller path as live input, without DOM,
 * camera, or worker. Outcomes depend only on recorded timestamps and result
 * ages, so playback speed cannot change them.
 */
import type { AppConfig } from '../app/config';
import { BoardController } from '../board/controller';
import type { Rect } from '../core/coords';
import { initialReducerState, reduce, type Intent, type ReducerState } from '../input/hand-reducer';
import { applyIntents } from '../input/intents';
import { HandPipeline, regionFromLayout, type SurfaceLayout } from '../tracking/hand-pipeline';
import type { ReplayRecord } from './replay-format';

export interface ReplayControl {
  readonly id: string;
  readonly rect: Rect;
}

export interface ReplayOptions {
  readonly config?: AppConfig;
  readonly controls?: readonly ReplayControl[];
  readonly controller?: BoardController;
  /** Called after each frame (for visualization or timing). */
  readonly onFrame?: (index: number, intents: readonly Intent[]) => void;
}

export interface ReplayOutcome {
  readonly controller: BoardController;
  readonly intents: readonly Intent[];
  readonly activations: readonly string[];
  readonly finalState: ReducerState;
  readonly layout: SurfaceLayout;
}

export function replayLayout(record: ReplayRecord, controls: readonly ReplayControl[] = []): SurfaceLayout {
  const { width, height, stripWidth } = record.surface;
  const board: Rect = { x: stripWidth, y: 0, width: width - stripWidth, height };
  return { width, height, board, hitTest: regionFromLayout(board, controls, width, height) };
}

export function runReplay(record: ReplayRecord, options: ReplayOptions = {}): ReplayOutcome {
  const config = options.config ?? record.config;
  const controller = options.controller ?? new BoardController(config);
  const layout = replayLayout(record, options.controls);
  const pipeline = new HandPipeline(config);
  pipeline.setLayout(layout);
  pipeline.setCamera(record.camera);
  let state = initialReducerState();
  const intents: Intent[] = [];
  const activations: string[] = [];
  record.frames.forEach((frame, index) => {
    const out = pipeline.process(frame.t, frame.hands, frame.ageMs);
    const step = reduce(state, out.input, config.gesture);
    state = step.state;
    intents.push(...step.intents);
    applyIntents(step.intents, {
      controller,
      boardRect: layout.board,
      activateControl: (id) => activations.push(id),
    });
    options.onFrame?.(index, step.intents);
  });
  return { controller, intents, activations, finalState: state, layout };
}
