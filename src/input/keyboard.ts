/**
 * Keyboard shortcuts (plan §4, §10):
 *  - Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo, except inside text
 *    fields, sliders, selects, and dialogs.
 *  - With the board focused: Z / Shift+Z, C (clear confirmation), P (pause),
 *    held Space (temporary pan). Escape ends the active interaction and
 *    leaves hand input paused.
 *  - Key repeat never toggles pause or reopens clear.
 */
export interface KeyboardActions {
  readonly undo: () => void;
  readonly redo: () => void;
  readonly requestClear: () => void;
  readonly togglePause: () => void;
  readonly escape: () => void;
  readonly setSpace: (held: boolean) => void;
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && (target.matches(EDITABLE) || target.closest('dialog') !== null);
}

export function attachKeyboard(doc: Document, board: HTMLElement, actions: KeyboardActions): () => void {
  let space = false;
  const releaseSpace = (): void => {
    if (!space) return;
    space = false;
    actions.setSpace(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    const onBoard = target === board;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (event.key === 'Escape') {
      if (target instanceof Element && target.closest('dialog') !== null) return;
      actions.escape();
      return;
    }
    if (isEditableTarget(target)) return;

    if (modifier && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault();
      if (key === 'y' || event.shiftKey) actions.redo();
      else actions.undo();
      return;
    }
    if (!onBoard || modifier || event.altKey) return;
    switch (key) {
      case 'z':
        event.preventDefault();
        if (event.shiftKey) actions.redo();
        else actions.undo();
        return;
      case 'c':
        event.preventDefault();
        if (!event.repeat) actions.requestClear();
        return;
      case 'p':
        event.preventDefault();
        if (!event.repeat) actions.togglePause();
        return;
      case ' ':
        event.preventDefault();
        if (!space) {
          space = true;
          actions.setSpace(true);
        }
        return;
      default:
        return;
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ') releaseSpace();
  };

  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keyup', onKeyUp);
  board.addEventListener('blur', releaseSpace);
  return () => {
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('keyup', onKeyUp);
    board.removeEventListener('blur', releaseSpace);
  };
}
