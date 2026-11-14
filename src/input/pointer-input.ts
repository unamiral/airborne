/**
 * Pointer fallback (plan §11): one active pointer with capture, release
 * outside the canvas, cancellation, coalesced samples (observed input, never
 * predicted), Space-drag or the move tool for panning, and wheel/trackpad
 * zoom anchored at the pointer. Pointer input bypasses the hand filter but
 * uses the same geometry, document, and history.
 */
import type { BoardController } from '../board/controller';
import { boardPoint, type BoardPoint } from '../core/coords';

export interface PointerHost {
  readonly controller: () => BoardController;
  /** Space is held with the board focused (temporary pan). */
  readonly spaceHeld: () => boolean;
  /** False while a hand interaction or a dialog owns input. */
  readonly canStart: () => boolean;
  readonly onUse?: () => void;
}

type Gesture = { kind: 'draw' } | { kind: 'erase' } | { kind: 'pan'; last: BoardPoint };

export function attachPointerInput(canvas: HTMLCanvasElement, host: PointerHost): () => void {
  let active: { id: number; gesture: Gesture } | null = null;

  const local = (event: { clientX: number; clientY: number }): BoardPoint => {
    const rect = canvas.getBoundingClientRect();
    return boardPoint(event.clientX - rect.left, event.clientY - rect.top);
  };

  const finish = (): void => {
    if (active === null) return;
    const c = host.controller();
    const g = active.gesture;
    active = null;
    canvas.dataset.panning = 'false';
    if (g.kind === 'draw') c.commitStroke();
    else if (g.kind === 'erase') c.endErase();
  };

  const onDown = (event: PointerEvent): void => {
    if (active !== null || !event.isPrimary) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (!host.canStart()) return;
    const c = host.controller();
    const p = local(event);
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
    host.onUse?.();
    let gesture: Gesture;
    if (event.button === 1 || host.spaceHeld() || c.tool === 'move') {
      gesture = { kind: 'pan', last: p };
      canvas.dataset.panning = 'true';
    } else if (c.tool === 'eraser') {
      gesture = { kind: 'erase' };
      c.beginErase(p);
    } else {
      if (!c.beginStroke(p, false)) return;
      gesture = { kind: 'draw' };
    }
    active = { id: event.pointerId, gesture };
    event.preventDefault();
  };

  const onMove = (event: PointerEvent): void => {
    if (active === null || event.pointerId !== active.id) return;
    const c = host.controller();
    const g = active.gesture;
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const list = samples.length > 0 ? samples : [event];
    if (g.kind === 'pan') {
      const p = local(event);
      c.pan(p.x - g.last.x, p.y - g.last.y);
      g.last = p;
      return;
    }
    for (const sample of list) {
      const p = local(sample);
      if (g.kind === 'draw') c.extendStroke(p);
      else c.moveErase(p);
    }
  };

  const onEnd = (event: PointerEvent): void => {
    if (active === null || event.pointerId !== active.id) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    // pointercancel also commits: the user did draw this ink; undo is available.
    finish();
  };

  const onWheel = (event: WheelEvent): void => {
    if (active !== null) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const delta = event.deltaY * unit;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015));
    host.controller().zoom(local(event), factor);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onEnd);
  canvas.addEventListener('pointercancel', onEnd);
  canvas.addEventListener('lostpointercapture', onEnd);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    finish();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onEnd);
    canvas.removeEventListener('pointercancel', onEnd);
    canvas.removeEventListener('lostpointercapture', onEnd);
    canvas.removeEventListener('wheel', onWheel);
  };
}
