/**
 * M0 pointer drawing stub: one active pointer, pointer capture, coalesced
 * samples. Extended with tools, pan, and zoom in later milestones.
 */
export interface PointerStrokeHandlers {
  readonly begin: (x: number, y: number) => void;
  readonly move: (x: number, y: number) => void;
  readonly end: () => void;
}

export function attachPointerDrawing(canvas: HTMLCanvasElement, handlers: PointerStrokeHandlers): () => void {
  let activePointer: number | null = null;

  const local = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const onDown = (event: PointerEvent): void => {
    if (activePointer !== null || event.button !== 0) return;
    activePointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
    handlers.begin(...local(event));
    event.preventDefault();
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== activePointer) return;
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const sample of samples.length > 0 ? samples : [event]) handlers.move(...local(sample));
  };

  const onUp = (event: PointerEvent): void => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    handlers.end();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
  };
}
