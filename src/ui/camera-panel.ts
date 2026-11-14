/**
 * Camera controls and truthful lifecycle status (plan §4). The status never
 * claims download progress that has not been measured.
 */
import type { Failure, SessionState } from '../app/camera-session';
import { el, setText } from './dom';

export interface CameraPanelHandlers {
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onUseMouse: () => void;
}

export function statusText(state: SessionState, handVisible: boolean): string {
  switch (state.kind) {
    case 'idle':
      return 'Camera off. Draw with the mouse, or start the camera.';
    case 'requesting-camera':
      return state.modelLoading
        ? 'Waiting for camera permission… Hand tracking is loading meanwhile.'
        : 'Waiting for camera…';
    case 'loading-model':
      return 'Loading hand tracking…';
    case 'warming':
      return 'Starting hand tracking…';
    case 'ready':
      return handVisible
        ? `Tracking on this device (${state.backend}).`
        : 'Looking for a hand… Hold one hand up in view of the camera.';
    case 'paused':
      return 'Paused. Press Resume (P), then open your hand to continue.';
    case 'recovering':
      return `Restarting hand tracking (attempt ${state.attempt})…`;
    case 'failed':
      return state.failure.title;
  }
}

export class CameraPanel {
  readonly element: HTMLElement;
  readonly errorCard: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly errorTitle: HTMLElement;
  private readonly errorHelp: HTMLElement;
  private readonly errorDetail: HTMLElement;

  constructor(handlers: CameraPanelHandlers) {
    this.startButton = el('button', { type: 'button', class: 'primary wide', 'data-hand-target': 'camera-start' }, [
      'Start camera',
    ]);
    this.stopButton = el('button', { type: 'button', class: 'secondary wide', hidden: true }, ['Stop camera']);
    this.status = el('p', { class: 'status', role: 'status' });
    this.startButton.addEventListener('click', handlers.onStart);
    this.stopButton.addEventListener('click', handlers.onStop);
    this.element = el('div', { class: 'strip-group camera-group' }, [this.startButton, this.stopButton]);

    this.errorTitle = el('h2');
    this.errorHelp = el('p');
    this.errorDetail = el('p', { class: 'status' });
    const retry = el('button', { type: 'button', class: 'primary' }, ['Try again']);
    const mouse = el('button', { type: 'button', class: 'secondary' }, ['Use mouse']);
    retry.addEventListener('click', handlers.onStart);
    mouse.addEventListener('click', handlers.onUseMouse);
    this.errorCard = el('section', { class: 'card error-card', role: 'alert', hidden: true }, [
      this.errorTitle,
      this.errorHelp,
      this.errorDetail,
      el('div', { class: 'actions' }, [retry, mouse]),
    ]);
  }

  get statusElement(): HTMLElement {
    return this.status;
  }

  render(state: SessionState, handVisible: boolean): void {
    const active = state.kind !== 'idle' && state.kind !== 'failed';
    this.startButton.hidden = active;
    this.stopButton.hidden = !active;
    const starting = state.kind === 'requesting-camera' || state.kind === 'loading-model';
    setText(this.stopButton, starting ? 'Cancel' : 'Stop camera');
    setText(this.status, statusText(state, handVisible));
    if (state.kind === 'failed') this.showError(state.failure);
    else this.hideError();
  }

  hideError(): void {
    this.errorCard.hidden = true;
  }

  private showError(failure: Failure): void {
    setText(this.errorTitle, failure.title);
    setText(this.errorHelp, failure.help);
    setText(this.errorDetail, failure.detail);
    this.errorCard.hidden = false;
  }
}
