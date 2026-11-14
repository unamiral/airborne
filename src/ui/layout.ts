/**
 * Interaction-surface layout from the DOM (plan §7): the hand maps onto the
 * whole app root; control hit regions come from `[data-hand-target]`
 * elements, overlays on the board absorb pinches, and an open modal dialog
 * scopes hand input to its own controls (the board then absorbs pinches).
 */
import type { Rect } from '../core/coords';
import { regionFromLayout, type SurfaceLayout } from '../tracking/hand-pipeline';

function relative(r: DOMRect, origin: DOMRect): Rect {
  return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
}

function visible(node: Element): boolean {
  return node.getClientRects().length > 0 && !node.closest('[hidden]');
}

export function computeSurfaceLayout(root: HTMLElement, board: HTMLElement, modal: HTMLElement | null, overlays: readonly HTMLElement[]): SurfaceLayout {
  const rootRect = root.getBoundingClientRect();
  const boardRect = relative(board.getBoundingClientRect(), rootRect);
  const scope: ParentNode = modal ?? root;
  const controls = [...scope.querySelectorAll<HTMLElement>('[data-hand-target]')]
    .filter((node) => visible(node) && !node.hasAttribute('disabled') && (modal !== null || node.closest('dialog') === null))
    .map((node) => ({ id: node.dataset.handTarget ?? '', rect: relative(node.getBoundingClientRect(), rootRect) }));
  const absorbers = modal !== null ? [] : overlays.filter((o) => visible(o)).map((o) => relative(o.getBoundingClientRect(), rootRect));
  const hitBoard = modal !== null ? { x: 0, y: 0, width: 0, height: 0 } : boardRect;
  return {
    width: rootRect.width,
    height: rootRect.height,
    board: boardRect,
    hitTest: regionFromLayout(hitBoard, controls, rootRect.width, rootRect.height, absorbers),
  };
}
