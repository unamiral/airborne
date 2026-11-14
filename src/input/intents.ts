/**
 * Applies reducer intents to the board controller, converting interaction-
 * surface points to board-local CSS points. Control activation is forwarded
 * to the UI; everything else is a document/view operation.
 */
import type { BoardController } from '../board/controller';
import { boardPoint, type BoardPoint, type Rect, type SurfacePoint } from '../core/coords';
import type { Intent } from './hand-reducer';

export interface IntentSinks {
  readonly controller: BoardController;
  /** Board rectangle within the interaction surface. */
  readonly boardRect: Rect;
  readonly activateControl: (id: string) => void;
}

export function surfaceToBoard(p: SurfacePoint, board: Rect): BoardPoint {
  return boardPoint(p.x - board.x, p.y - board.y);
}

export function applyIntents(intents: readonly Intent[], sinks: IntentSinks): void {
  const c = sinks.controller;
  const toBoard = (p: SurfacePoint): BoardPoint => surfaceToBoard(p, sinks.boardRect);
  for (const intent of intents) {
    switch (intent.kind) {
      case 'stroke-begin':
        c.beginStroke(toBoard(intent.at), true);
        break;
      case 'stroke-point':
        c.extendStroke(toBoard(intent.at));
        break;
      case 'stroke-preview':
        c.setPreview(intent.points.map(toBoard));
        break;
      case 'stroke-confirm':
        c.confirmStroke();
        break;
      case 'stroke-commit':
        c.setPreview([]);
        c.commitStroke();
        break;
      case 'stroke-cancel':
        c.cancelStroke();
        break;
      case 'transform-begin':
        c.beginTransform(toBoard(intent.a), toBoard(intent.b));
        break;
      case 'transform-update':
        c.updateTransform(toBoard(intent.a), toBoard(intent.b));
        break;
      case 'transform-end':
        c.endTransform();
        break;
      case 'erase-arming':
      case 'erase-cancel':
        // Visual only (cursor progress); never touches the document.
        break;
      case 'erase-begin':
        c.beginErase(toBoard(intent.at));
        break;
      case 'erase-move':
        c.moveErase(toBoard(intent.at));
        break;
      case 'erase-end':
        c.endErase();
        break;
      case 'control-activate':
        sinks.activateControl(intent.id);
        break;
    }
  }
}
