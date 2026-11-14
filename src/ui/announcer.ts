/**
 * Polite live region for screen readers (plan §11): announces discrete state
 * changes sparingly — never landmark updates — and collapses bursts.
 */
import { el } from './dom';

export class Announcer {
  readonly element: HTMLElement;
  private last = '';
  private lastAt = -Infinity;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly minIntervalMs = 1500,
  ) {
    // No role: the camera status is the page's single status landmark.
    this.element = el('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  }

  announce(message: string): void {
    const t = this.now();
    if (message === this.last && t - this.lastAt < 10_000) return;
    if (t - this.lastAt < this.minIntervalMs && message !== 'Paused') return;
    this.last = message;
    this.lastAt = t;
    this.element.textContent = message;
  }
}
