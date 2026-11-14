/**
 * Modal confirmation built on <dialog>: focus is trapped by the browser,
 * Escape cancels, and both buttons are hand targets. Hand confirmation needs
 * a new pinch after release (the pinch that opened the dialog stays captured
 * by the reducer until it is released), so one held pinch cannot clear.
 */
import { el } from './dom';

export interface ConfirmOptions {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly confirmTarget: string;
  readonly cancelTarget: string;
  readonly onConfirm: () => void;
  readonly onClose?: () => void;
}

export class ConfirmDialog {
  readonly element: HTMLDialogElement;
  private readonly confirm: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;

  constructor(private readonly options: ConfirmOptions) {
    const titleId = `${options.confirmTarget}-title`;
    this.confirm = el('button', { type: 'button', class: 'primary danger', 'data-hand-target': options.confirmTarget }, [options.confirmLabel]);
    this.cancel = el('button', { type: 'button', class: 'secondary', 'data-hand-target': options.cancelTarget }, ['Cancel']);
    this.element = el('dialog', { class: 'card confirm', 'aria-labelledby': titleId, role: 'alertdialog' }, [
      el('h2', { id: titleId }, [options.title]),
      el('p', {}, [options.body]),
      el('div', { class: 'actions' }, [this.cancel, this.confirm]),
    ]);
    this.confirm.addEventListener('click', () => this.accept());
    this.cancel.addEventListener('click', () => this.close());
    this.element.addEventListener('close', () => this.options.onClose?.());
  }

  get isOpen(): boolean {
    return this.element.open;
  }

  open(): void {
    if (this.element.open) return;
    if (typeof this.element.showModal === 'function') this.element.showModal();
    else this.element.setAttribute('open', '');
    // The safe action has initial focus: Enter right after C does not clear.
    this.cancel.focus();
  }

  accept(): void {
    if (!this.element.open) return;
    this.options.onConfirm();
    this.close();
  }

  close(): void {
    if (!this.element.open) return;
    if (typeof this.element.close === 'function') this.element.close();
    else this.element.removeAttribute('open');
  }

  /** Hand activation of one of the dialog's targets. */
  activate(target: string): boolean {
    if (target === this.options.confirmTarget) this.accept();
    else if (target === this.options.cancelTarget) this.close();
    else return false;
    return true;
  }
}
