import type { Enhancement } from '../beautify/enhance';
import { el } from './dom';

/** Explicit scope prevents a diagram from being silently treated as text. */
export class BeautifyDialog {
  readonly element: HTMLDialogElement;
  constructor(apply: (level: Enhancement) => void, onClose: () => void) {
    const light = el('button', { type: 'button', class: 'secondary', 'data-hand-target': 'beautify-light' }, ['Light smoothing']);
    const balanced = el('button', { type: 'button', class: 'primary', 'data-hand-target': 'beautify-balanced' }, ['Smooth and align']);
    const cancel = el('button', { type: 'button', class: 'secondary', 'data-hand-target': 'beautify-cancel' }, ['Cancel']);
    light.addEventListener('click', () => { this.close(); apply('light'); });
    balanced.addEventListener('click', () => { this.close(); apply('balanced'); });
    cancel.addEventListener('click', () => this.close());
    this.element = el('dialog', { class: 'card settings', 'aria-labelledby': 'beautify-title' }, [
      el('h2', { id: 'beautify-title' }, ['Clean up handwriting']),
      el('p', { class: 'help' }, ['Applies to all ink on this board. Light smooths small irregularities. Smooth and align also gently aligns simple, separated lines when their layout is clear. Use Undo to restore the original ink.']),
      el('p', { class: 'help' }, ['Complex layouts and drawings cannot be reliably identified as handwriting. Review the result before continuing.']),
      el('div', { class: 'actions' }, [cancel, light, balanced]),
    ]);
    this.element.addEventListener('close', onClose);
  }
  get isOpen(): boolean { return this.element.open; }
  open(): void { if (!this.element.open) this.element.showModal(); }
  close(): void { if (this.element.open) this.element.close(); }
  activate(target: string): boolean {
    if (!['beautify-light', 'beautify-balanced', 'beautify-cancel'].includes(target)) return false;
    this.element.querySelector<HTMLButtonElement>(`[data-hand-target="${target}"]`)?.click();
    return true;
  }
}
