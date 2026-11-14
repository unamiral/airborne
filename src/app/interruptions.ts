/**
 * Page lifecycle interruptions (plan §11): hidden tab, blur, and pagehide.
 * Hidden or unfocused: editing and inference stop immediately. Hidden for
 * longer than `hiddenStopMs` (30 s): the camera is stopped and needs an
 * explicit restart. Returning never resumes automatically.
 */
export interface InterruptionHandlers {
  readonly suspend: (reason: 'hidden' | 'blur') => void;
  readonly hiddenTooLong: () => void;
  readonly pageHide: () => void;
}

export interface InterruptionTargets {
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>;
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export function watchInterruptions(targets: InterruptionTargets, hiddenStopMs: () => number, handlers: InterruptionHandlers): () => void {
  let timer: number | null = null;
  const clear = (): void => {
    if (timer !== null) targets.window.clearTimeout(timer);
    timer = null;
  };
  const onVisibility = (): void => {
    if (targets.document.visibilityState === 'hidden') {
      handlers.suspend('hidden');
      clear();
      timer = targets.window.setTimeout(() => {
        timer = null;
        handlers.hiddenTooLong();
      }, hiddenStopMs());
    } else {
      clear();
    }
  };
  const onBlur = (): void => handlers.suspend('blur');
  const onPageHide = (): void => {
    clear();
    handlers.pageHide();
  };
  targets.document.addEventListener('visibilitychange', onVisibility);
  targets.window.addEventListener('blur', onBlur);
  targets.window.addEventListener('pagehide', onPageHide);
  return () => {
    clear();
    targets.document.removeEventListener('visibilitychange', onVisibility);
    targets.window.removeEventListener('blur', onBlur);
    targets.window.removeEventListener('pagehide', onPageHide);
  };
}
