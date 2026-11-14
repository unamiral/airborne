/**
 * Semantic control strip (plan §4 "Workspace layout"): native buttons with
 * accessible names, visible short labels, pressed states, and visible focus.
 * Every control is also a hand target (`data-hand-target`) that dispatches
 * the same command as a click, so hand, pointer, and keyboard share one path.
 */
import type { BoardController, Tool } from '../board/controller';
import { el, icon, setText } from './dom';
import { ICONS } from './icons';

export interface PaletteColor {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

/** Six high-contrast colors (≥ 4.5:1 against white). */
export const PALETTE: readonly PaletteColor[] = [
  { id: 'black', name: 'Black', value: '#1b1f24' },
  { id: 'blue', name: 'Blue', value: '#0b57d0' },
  { id: 'red', name: 'Red', value: '#c5221f' },
  { id: 'green', name: 'Green', value: '#137333' },
  { id: 'orange', name: 'Orange', value: '#a04f00' },
  { id: 'purple', name: 'Purple', value: '#8430ce' },
];

export const WIDTHS: ReadonlyArray<{ id: string; name: string; px: number }> = [
  { id: 'fine', name: 'Fine', px: 2 },
  { id: 'medium', name: 'Medium', px: 4 },
  { id: 'bold', name: 'Bold', px: 8 },
];

export type Command =
  | { readonly kind: 'tool'; readonly tool: Tool }
  | { readonly kind: 'color'; readonly value: string }
  | { readonly kind: 'width'; readonly px: number }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'fit' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'export' }
  | { readonly kind: 'interpret' }
  | { readonly kind: 'beautify' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'help' };

/** Hand-target id → command (the reducer emits ids; routing stays data-only). */
export function commandForTarget(id: string): Command | null {
  if (id.startsWith('color-')) {
    const c = PALETTE.find((p) => `color-${p.id}` === id);
    return c === undefined ? null : { kind: 'color', value: c.value };
  }
  if (id.startsWith('width-')) {
    const w = WIDTHS.find((p) => `width-${p.id}` === id);
    return w === undefined ? null : { kind: 'width', px: w.px };
  }
  switch (id) {
    case 'tool-pen':
      return { kind: 'tool', tool: 'pen' };
    case 'tool-eraser':
      return { kind: 'tool', tool: 'eraser' };
    case 'tool-move':
      return { kind: 'tool', tool: 'move' };
    case 'undo':
    case 'redo':
    case 'clear':
    case 'fit':
    case 'reset':
    case 'pause':
    case 'export':
    case 'interpret':
    case 'beautify':
    case 'settings':
    case 'help':
      return { kind: id };
    default:
      return null;
  }
}

function toolButton(target: string, label: string, svg: string, short: string): HTMLButtonElement {
  return el('button', { type: 'button', class: 'tool', 'aria-label': label, title: label, 'data-hand-target': target }, [
    icon(svg),
    el('span', { 'aria-hidden': 'true' }, [short]),
  ]);
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly pauseButton: HTMLButtonElement;

  constructor(dispatch: (command: Command) => void) {
    const group = (label: string, children: HTMLElement[]): HTMLElement =>
      el('div', { class: 'strip-group', role: 'group', 'aria-label': label }, [el('span', { class: 'strip-label', 'aria-hidden': 'true' }, [label]), ...children]);
    const add = (target: string, button: HTMLButtonElement): HTMLButtonElement => {
      this.buttons.set(target, button);
      button.addEventListener('click', () => {
        const command = commandForTarget(target);
        if (command !== null) dispatch(command);
      });
      return button;
    };

    const tools = [
      add('tool-pen', toolButton('tool-pen', 'Pen', ICONS.pen, 'Pen')),
      add('tool-eraser', toolButton('tool-eraser', 'Eraser', ICONS.eraser, 'Erase')),
      add('tool-move', toolButton('tool-move', 'Move board', ICONS.move, 'Move')),
    ];
    this.pauseButton = add('pause', toolButton('pause', 'Pause hand input', ICONS.pause, 'Pause'));
    tools.push(this.pauseButton);

    const colors = PALETTE.map((c) =>
      add(
        `color-${c.id}`,
        el('button', { type: 'button', class: 'tool', 'aria-label': `${c.name} ink`, title: `${c.name} ink`, 'data-hand-target': `color-${c.id}` }, [
          (() => {
            const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
            swatch.style.background = c.value;
            return swatch;
          })(),
          el('span', { 'aria-hidden': 'true' }, [c.name]),
        ]),
      ),
    );

    const widths = WIDTHS.map((w) =>
      add(
        `width-${w.id}`,
        el('button', { type: 'button', class: 'tool', 'aria-label': `${w.name} pen, ${w.px} pixels`, title: `${w.name} pen (${w.px} px)`, 'data-hand-target': `width-${w.id}` }, [
          (() => {
            const dot = el('span', { class: 'width-dot', 'aria-hidden': 'true' });
            dot.style.width = `${Math.max(w.px, 3)}px`;
            dot.style.height = `${Math.max(w.px, 3)}px`;
            return dot;
          })(),
          el('span', { 'aria-hidden': 'true' }, [w.name]),
        ]),
      ),
    );

    const edit = [
      add('undo', toolButton('undo', 'Undo', ICONS.undo, 'Undo')),
      add('redo', toolButton('redo', 'Redo', ICONS.redo, 'Redo')),
      add('clear', toolButton('clear', 'Clear board…', ICONS.clear, 'Clear')),
      add('export', toolButton('export', 'Export PNG', ICONS.export, 'Export')),
      add('interpret', toolButton('interpret', 'Interpret handwriting', ICONS.pen, 'Text')),
      add('beautify', toolButton('beautify', 'Clean up handwriting', ICONS.pen, 'Clean')),
    ];
    const view = [
      add('fit', toolButton('fit', 'Fit board to ink', ICONS.fit, 'Fit')),
      add('reset', toolButton('reset', 'Reset view to 100%', ICONS.reset, '100%')),
      add('settings', toolButton('settings', 'Settings', ICONS.settings, 'Settings')),
      add('help', toolButton('help', 'Practice and help', ICONS.help, 'Help')),
    ];

    this.element = el('nav', { class: 'toolbar', 'aria-label': 'Whiteboard tools' }, [
      group('Tools', tools),
      group('Color', colors),
      group('Size', widths),
      group('Edit', edit),
      group('View', view),
    ]);
  }

  button(target: string): HTMLButtonElement | undefined {
    return this.buttons.get(target);
  }

  /** Reflects controller and input state in pressed/disabled attributes. */
  sync(board: BoardController, paused: boolean): void {
    for (const [target, button] of this.buttons) {
      const command = commandForTarget(target);
      if (command === null) continue;
      let pressed: boolean | null = null;
      if (command.kind === 'tool') pressed = board.tool === command.tool;
      else if (command.kind === 'color') pressed = board.color === command.value;
      else if (command.kind === 'width') pressed = board.widthPx === command.px;
      if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
    }
    this.buttons.get('undo')!.disabled = !board.history.canUndo;
    this.buttons.get('redo')!.disabled = !board.history.canRedo;
    this.pauseButton.setAttribute('aria-pressed', String(paused));
    this.pauseButton.setAttribute('aria-label', paused ? 'Resume hand input' : 'Pause hand input');
    this.pauseButton.title = paused ? 'Resume hand input (P)' : 'Pause hand input (P)';
    const svgSlot = this.pauseButton.querySelector('svg');
    const label = this.pauseButton.querySelector('span');
    if (label !== null) setText(label, paused ? 'Resume' : 'Pause');
    if (svgSlot !== null && svgSlot.dataset.state !== String(paused)) {
      const next = icon(paused ? ICONS.play : ICONS.pause);
      next.dataset.state = String(paused);
      svgSlot.replaceWith(next);
    }
  }

  /** Visual feedback for hands over controls (not color alone: outline style). */
  setHandFeedback(hover: ReadonlySet<string>, pressed: ReadonlySet<string>): void {
    for (const [target, button] of this.buttons) {
      button.classList.toggle('hand-hover', hover.has(target));
      button.classList.toggle('hand-press', pressed.has(target));
    }
  }
}
