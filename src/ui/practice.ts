/**
 * Practice card (non-modal, top of the board): four steps with checkmarks
 * and a text "Done" (not color alone), a concise hint for hands and mouse,
 * Skip and Finish buttons that are also hand targets.
 */
import { PRACTICE_STEPS, type PracticeStep, type PracticeTracker } from '../app/practice-tracker';
import { el, setText } from './dom';

const STEP_TEXT: Readonly<Record<PracticeStep, { title: string; hand: string; mouse: string }>> = {
  draw: { title: 'Draw a loop', hand: 'Extend your thumb, index and middle finger in the same direction, then move your index fingertip. Angle your thumb away to stop.', mouse: 'Drag on the board.' },
  pan: { title: 'Move the board', hand: 'Use the writing pose with both hands, then move your hands together.', mouse: 'Hold Space and drag.' },
  zoom: { title: 'Zoom', hand: 'Use the writing pose with both hands, then spread your hands apart or bring them together.', mouse: 'Scroll or pinch the trackpad.' },
  erase: { title: 'Erase your loop', hand: 'Hold a fist until the ring fills, then sweep over the loop.', mouse: 'Choose Erase and drag over the loop.' },
};

export class PracticeCard {
  readonly element: HTMLElement;
  private readonly items = new Map<PracticeStep, HTMLElement>();
  private readonly hint: HTMLElement;
  private readonly finish: HTMLButtonElement;
  private readonly skip: HTMLButtonElement;

  constructor(onClose: () => void) {
    const list = el('ol', { class: 'practice-steps' });
    for (const step of PRACTICE_STEPS) {
      const item = el('li', {}, [STEP_TEXT[step].title]);
      this.items.set(step, item);
      list.append(item);
    }
    this.hint = el('p', { class: 'help', 'aria-live': 'polite' });
    this.skip = el('button', { type: 'button', class: 'secondary', 'data-hand-target': 'practice-skip' }, ['Skip practice']);
    this.finish = el('button', { type: 'button', class: 'primary', 'data-hand-target': 'practice-done', hidden: true }, ['Start writing']);
    this.skip.addEventListener('click', onClose);
    this.finish.addEventListener('click', onClose);
    this.element = el('section', { class: 'card practice', 'aria-labelledby': 'practice-title', hidden: true }, [
      el('h2', { id: 'practice-title' }, ['Practice (about 20 seconds)']),
      el('p', { class: 'help' }, ['This is a separate practice board. Your real board is not changed.']),
      list,
      this.hint,
      el('div', { class: 'actions' }, [this.skip, this.finish]),
    ]);
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  render(tracker: PracticeTracker, usingHands: boolean): void {
    for (const step of PRACTICE_STEPS) {
      const item = this.items.get(step)!;
      const done = tracker.isDone(step);
      item.dataset.state = done ? 'done' : step === tracker.current ? 'current' : 'todo';
      setText(item, done ? `✓ ${STEP_TEXT[step].title} — done` : STEP_TEXT[step].title);
    }
    const current = tracker.current;
    if (current === null) {
      setText(this.hint, `All four done in ${Math.round(tracker.elapsedMs / 1000)} s.`);
      this.finish.hidden = false;
      this.skip.hidden = true;
    } else {
      setText(this.hint, usingHands ? STEP_TEXT[current].hand : STEP_TEXT[current].mouse);
      this.finish.hidden = true;
      this.skip.hidden = false;
    }
  }
}

/** One-time offer shown when the camera first becomes ready. */
export class PracticeOffer {
  readonly element: HTMLElement;

  constructor(onAccept: () => void, onDismiss: () => void) {
    const accept = el('button', { type: 'button', class: 'primary', 'data-hand-target': 'practice-start' }, ['Practice']);
    const dismiss = el('button', { type: 'button', class: 'secondary', 'data-hand-target': 'practice-dismiss' }, ['No thanks']);
    accept.addEventListener('click', onAccept);
    dismiss.addEventListener('click', onDismiss);
    this.element = el('section', { class: 'card practice', 'aria-label': 'Practice offer', hidden: true }, [
      el('p', {}, ['New to air writing? Try a 20-second practice on a separate board.']),
      el('div', { class: 'actions' }, [accept, dismiss]),
    ]);
  }
}
