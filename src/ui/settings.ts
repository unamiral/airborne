/**
 * Settings (plan §4, §16): only useful product choices. Changes go through
 * the app's validated config path and apply at the next idle boundary.
 * Buttons double as hand targets; the slider and select serve pointer and
 * keyboard users.
 */
import { CONFIG_BOUNDS, type StabilizerPreset } from '../app/config';
import { BACKGROUNDS, type BoardBackground } from '../render/background';
import type { CameraDevice } from '../camera/camera-source';
import { el, setText } from './dom';

export interface SettingsValues {
  readonly dark: boolean;
  readonly background: BoardBackground;
  readonly stabilizer: StabilizerPreset;
  readonly reach: number;
  readonly writeStartRatio: number;
  readonly writeReleaseRatio: number;
  readonly fistErase: boolean;
  readonly preview: boolean;
  readonly cameras: readonly CameraDevice[];
  readonly cameraId: string | null;
}

export interface SettingsHandlers {
  readonly setBackground: (background: BoardBackground) => void;
  readonly setDark: (dark: boolean) => void;
  readonly setStabilizer: (preset: StabilizerPreset) => void;
  readonly setReach: (reach: number) => void;
  readonly setWritingDistance: (key: WritingDistanceKey, ratio: number) => void;
  readonly setFistErase: (enabled: boolean) => void;
  readonly setPreview: (visible: boolean) => void;
  readonly setCamera: (deviceId: string) => void;
  readonly resetDefaults: () => void;
  readonly onClose: () => void;
}

type WritingDistanceKey = 'writeStartRatio' | 'writeReleaseRatio';

const PRESETS: ReadonlyArray<{ id: StabilizerPreset; name: string; help: string }> = [
  { id: 'light', name: 'Light', help: 'Follows your hand closely; small shakes show.' },
  { id: 'balanced', name: 'Balanced', help: 'Recommended for most writing.' },
  { id: 'steady', name: 'Steady', help: 'Steadier movement, more resistance.' },
];

export class SettingsDialog {
  readonly element: HTMLDialogElement;
  private readonly backgroundButtons = new Map<BoardBackground, HTMLButtonElement>();
  private readonly presetButtons = new Map<StabilizerPreset, HTMLButtonElement>();
  private readonly reachInput: HTMLInputElement;
  private readonly reachValue: HTMLElement;
  private readonly writeStart: HTMLInputElement;
  private readonly writeRelease: HTMLInputElement;
  private readonly darkSwitch: HTMLButtonElement;
  private readonly fistSwitch: HTMLButtonElement;
  private readonly previewSwitch: HTMLButtonElement;
  private readonly cameraSelect: HTMLSelectElement;
  private values: SettingsValues | null = null;

  constructor(private readonly handlers: SettingsHandlers) {
    const presetRow = el('div', { class: 'choice-row', role: 'group', 'aria-labelledby': 'stab-label' });
    for (const p of PRESETS) {
      const b = el('button', { type: 'button', class: 'choice', 'aria-pressed': 'false', 'data-hand-target': `preset-${p.id}`, 'aria-describedby': `preset-${p.id}-help` }, [
        el('strong', {}, [p.name]),
        el('span', { id: `preset-${p.id}-help` }, [p.help]),
      ]);
      b.addEventListener('click', () => handlers.setStabilizer(p.id));
      this.presetButtons.set(p.id, b);
      presetRow.append(b);
    }

    this.reachInput = el('input', { type: 'range', min: 78, max: 140, step: 1, id: 'reach-input', 'aria-describedby': 'reach-help' });
    this.reachValue = el('output', { for: 'reach-input' });
    this.reachInput.addEventListener('input', () => handlers.setReach(Math.max(0.5, Math.min(0.9, 70 / Number(this.reachInput.value)))));
    const less = el('button', { type: 'button', class: 'secondary small', 'data-hand-target': 'reach-less', 'aria-label': 'Lower sensitivity' }, ['−']);
    const more = el('button', { type: 'button', class: 'secondary small', 'data-hand-target': 'reach-more', 'aria-label': 'Higher sensitivity' }, ['+']);
    less.addEventListener('click', () => this.stepReach(0.05));
    more.addEventListener('click', () => this.stepReach(-0.05));

    const writingDistance = (id: string, key: WritingDistanceKey): HTMLInputElement => {
      const { min, max } = CONFIG_BOUNDS.gesture[key];
      const input = el('input', { type: 'number', id, min, max, step: 0.01, 'aria-describedby': 'write-distance-help' });
      input.addEventListener('change', () => {
        if (input.checkValidity() && Number.isFinite(input.valueAsNumber)) handlers.setWritingDistance(key, input.valueAsNumber);
        if (this.values !== null) input.value = String(this.values[key]);
      });
      return input;
    };
    this.writeStart = writingDistance('write-start', 'writeStartRatio');
    this.writeRelease = writingDistance('write-release', 'writeReleaseRatio');

    const makeSwitch = (target: string, label: string, onToggle: (value: boolean) => void): HTMLButtonElement => {
      const b = el('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': 'false', 'data-hand-target': target }, [label]);
      b.addEventListener('click', () => onToggle(b.getAttribute('aria-checked') !== 'true'));
      return b;
    };
    const backgroundRow = el('div', { class: 'background-choices', role: 'group', 'aria-label': 'Board background' });
    const names: Record<BoardBackground, string> = { plain: 'Plain', grid: 'Grid', cornell: 'Cornell', notebook: 'Notebook', camera: 'Live camera' };
    for (const id of BACKGROUNDS) {
      const button = el('button', { type: 'button', class: `background-choice background-${id}`, 'aria-pressed': 'false', 'data-hand-target': `background-${id}` }, [el('span', { class: 'background-thumbnail', 'aria-hidden': 'true' }), el('span', {}, [names[id]])]);
      button.addEventListener('click', () => handlers.setBackground(id));
      this.backgroundButtons.set(id, button);
      backgroundRow.append(button);
    }
    this.darkSwitch = makeSwitch('dark-toggle', 'Dark mode', (v) => handlers.setDark(v));
    this.fistSwitch = makeSwitch('fist-toggle', 'Erase with a held fist', (v) => handlers.setFistErase(v));
    this.previewSwitch = makeSwitch('preview-toggle', 'Show camera preview', (v) => handlers.setPreview(v));

    this.cameraSelect = el('select', { id: 'camera-select' });
    this.cameraSelect.addEventListener('change', () => {
      if (this.cameraSelect.value !== '') handlers.setCamera(this.cameraSelect.value);
    });

    const reset = el('button', { type: 'button', class: 'secondary' }, ['Reset to defaults']);
    reset.addEventListener('click', () => handlers.resetDefaults());
    const close = el('button', { type: 'button', class: 'primary', 'data-hand-target': 'settings-close' }, ['Done']);
    close.addEventListener('click', () => this.close());

    this.element = el('dialog', { class: 'card settings', 'aria-labelledby': 'settings-title' }, [
      el('h2', { id: 'settings-title' }, ['Settings']),
      el('div', { class: 'settings-columns' }, [
        el('section', {}, [
          el('h3', {}, ['Appearance']),
          this.darkSwitch,
          el('h3', {}, ['Board background']),
          backgroundRow,
          el('p', { class: 'help' }, ['Live camera uses the active camera; start it from the toolbar. Camera images are not included in exports.']),
          el('h3', {}, ['Gestures and camera']),
          el('div', { class: 'switch-row' }, [this.fistSwitch, this.previewSwitch]),
          el('label', { for: 'camera-select', class: 'help' }, ['Camera']),
          this.cameraSelect,
        ]),
        el('section', {}, [
          el('h3', { id: 'stab-label' }, ['Hand steadiness']),
          presetRow,
          el('h3', {}, [el('label', { for: 'reach-input' }, ['Sensitivity'])]),
          el('p', { id: 'reach-help', class: 'help' }, ['Lower sensitivity gives finer control near the center. The entire camera view remains active.']),
          el('div', { class: 'reach-row' }, [less, this.reachInput, more, this.reachValue]),
          el('h3', {}, ['Writing gesture']),
          el('p', { id: 'write-distance-help', class: 'help' }, ['These distances control the close-fingertip gesture. The extended-finger pose uses finger direction. Distances are measured in palm lengths, and release must be higher than start.']),
          el('div', { class: 'switch-row' }, [
            el('label', { for: 'write-start' }, ['Start distance ', this.writeStart]),
            el('label', { for: 'write-release' }, ['Release distance ', this.writeRelease]),
          ]),
        ]),
      ]),
      el('div', { class: 'actions' }, [reset, close]),
    ]);
    this.element.addEventListener('close', () => handlers.onClose());
  }

  get isOpen(): boolean {
    return this.element.open;
  }

  open(values: SettingsValues): void {
    this.update(values);
    if (!this.element.open) {
      if (typeof this.element.showModal === 'function') this.element.showModal();
      else this.element.setAttribute('open', '');
    }
  }

  close(): void {
    if (!this.element.open) return;
    if (typeof this.element.close === 'function') this.element.close();
    else this.element.removeAttribute('open');
  }

  update(values: SettingsValues): void {
    this.values = values;
    for (const [id, b] of this.backgroundButtons) b.setAttribute('aria-pressed', String(id === values.background));
    for (const [id, b] of this.presetButtons) b.setAttribute('aria-pressed', String(id === values.stabilizer));
    const pct = Math.round(70 / values.reach);
    this.reachInput.value = String(pct);
    setText(this.reachValue, `${pct}%`);
    this.writeStart.value = String(values.writeStartRatio);
    this.writeRelease.value = String(values.writeReleaseRatio);
    this.darkSwitch.setAttribute('aria-checked', String(values.dark));
    this.fistSwitch.setAttribute('aria-checked', String(values.fistErase));
    this.previewSwitch.setAttribute('aria-checked', String(values.preview));
    const options = values.cameras.length === 0 ? [{ deviceId: '', label: 'Start the camera to choose' }] : values.cameras;
    this.cameraSelect.replaceChildren(
      ...options.map((c) => el('option', { value: c.deviceId, selected: c.deviceId === values.cameraId }, [c.label])),
    );
    this.cameraSelect.disabled = values.cameras.length === 0;
  }

  private stepReach(delta: number): void {
    const current = this.values?.reach ?? 0.7;
    const next = Math.min(0.9, Math.max(0.5, Math.round((current + delta) * 100) / 100));
    this.handlers.setReach(next);
  }

  /** Hand activation of a settings target. */
  activate(target: string): boolean {
    if (target === 'settings-close') this.close();
    else if (target === 'reach-less') this.stepReach(0.05);
    else if (target === 'reach-more') this.stepReach(-0.05);
    else if (target.startsWith('background-')) {
      const id = target.slice('background-'.length) as BoardBackground;
      if (!BACKGROUNDS.includes(id)) return false;
      this.handlers.setBackground(id);
    }
    else if (target === 'dark-toggle') this.handlers.setDark(!(this.values?.dark ?? false));
    else if (target === 'fist-toggle') this.handlers.setFistErase(!(this.values?.fistErase ?? true));
    else if (target === 'preview-toggle') this.handlers.setPreview(!(this.values?.preview ?? true));
    else if (target.startsWith('preset-')) {
      const id = target.slice('preset-'.length);
      const p = PRESETS.find((x) => x.id === id);
      if (p === undefined) return false;
      this.handlers.setStabilizer(p.id);
    } else return false;
    return true;
  }
}
