/**
 * Composition root. Wires camera/tracking, hand input, pointer and keyboard
 * input, the board controller, the renderer, and the UI. UI code dispatches
 * commands and reads summaries; it never edits stroke data.
 */
import { BoardController } from '../board/controller';
import { browserMediaEnvironment } from '../camera/camera-source';
import type { Rect } from '../core/coords';
import { attachKeyboard } from '../input/keyboard';
import { attachPointerInput } from '../input/pointer-input';
import { BoardRenderer } from '../render/renderer';
import { regionFromLayout, type SurfaceLayout } from '../tracking/hand-pipeline';
import type { HandPayload } from '../tracking/protocol';
import type { BackendPreference, WorkerLike } from '../tracking/tracker-client';
import { Announcer } from '../ui/announcer';
import { CameraPanel } from '../ui/camera-panel';
import { ConfirmDialog } from '../ui/dialogs';
import { el, setText } from '../ui/dom';
import { CameraPreview } from '../ui/preview';
import { Toolbar, commandForTarget, type Command } from '../ui/toolbar';
import { resolveAssets, type ResolvedAssets } from './assets';
import { CameraSession, type SessionState } from './camera-session';
import { DEFAULT_CONFIG, patchConfig, type AppConfig, type ConfigResult } from './config';
import { HandInput } from './hand-input';
import { watchInterruptions } from './interruptions';
import { Metrics, noopMetrics, type MetricsSink } from './metrics';

type ConfigPatch = Parameters<typeof patchConfig>[1];

export interface AppHandle {
  readonly metrics: Metrics | null;
  readonly session: CameraSession;
  readonly controller: BoardController;
  readonly renderer: BoardRenderer;
  readonly hands: HandInput;
  readonly config: () => AppConfig;
  /** Validated settings change, applied at the next idle boundary. */
  readonly applyConfig: (patch: ConfigPatch) => ConfigResult;
  /** Feeds a tracking result exactly as the camera path does (dev replay). */
  readonly injectResult: (sourceTimeMs: number, hands: readonly HandPayload[], ageMs: number, camera: { width: number; height: number }) => void;
  readonly layout: () => SurfaceLayout;
  readonly createWorker: () => WorkerLike;
  readonly assets: ResolvedAssets;
  readonly command: (command: Command) => void;
  lastHands: readonly HandPayload[];
}

function backendFromUrl(): BackendPreference {
  const value = new URLSearchParams(globalThis.location.search).get('backend');
  if (value === 'gpu') return 'GPU';
  if (value === 'cpu') return 'CPU';
  return 'auto';
}

/**
 * Optional input downscale for evaluation (`?inputScale=0.5`). Default 1:
 * the full camera frame is sent; see docs/decisions/0002-tracking-backend.md.
 */
function inputScaleFromUrl(): number {
  const value = Number(new URLSearchParams(globalThis.location.search).get('inputScale') ?? '1');
  return Number.isFinite(value) && value >= 0.25 && value <= 1 ? value : 1;
}

function createInferenceWorker(): WorkerLike {
  return new Worker(new URL('../tracking/worker/inference.worker.ts', import.meta.url), {
    type: 'module',
    name: 'inference',
  });
}

export function createApp(root: HTMLElement): AppHandle {
  const metrics = __DEVTOOLS__ ? new Metrics() : null;
  const sink: MetricsSink = metrics ?? noopMetrics;
  let config: AppConfig = DEFAULT_CONFIG;
  let pendingConfig: AppConfig | null = null;
  const inputScale = inputScaleFromUrl();
  const assets = resolveAssets(document.baseURI);

  // --- DOM -----------------------------------------------------------------
  const canvas = el('canvas', {
    class: 'board',
    tabindex: 0,
    'aria-label': 'Whiteboard. Drag to draw, hold Space and drag to pan, scroll to zoom. Shortcuts: Z undo, Shift+Z redo, C clear, P pause.',
  });
  const preview = new CameraPreview();
  const announcer = new Announcer();
  const modeChip = el('span', { class: 'mode-chip', 'aria-hidden': 'true' }, ['Camera off']);
  const notice = el('p', { class: 'status notice', hidden: true });
  let welcome: HTMLElement | null = null;
  let sessionState: SessionState = { kind: 'idle' };

  const panel = new CameraPanel({
    onStart: () => {
      dismissWelcome();
      notice.hidden = true;
      void session.start();
    },
    onStop: () => session.stop(),
    onUseMouse: () => {
      dismissWelcome();
      panel.hideError();
      canvas.focus();
    },
  });

  const toolbar = new Toolbar((command) => runCommand(command));
  const clearDialog = new ConfirmDialog({
    title: 'Clear the board?',
    body: 'Everything on the board will be removed. You can undo this.',
    confirmLabel: 'Clear board',
    confirmTarget: 'clear-confirm',
    cancelTarget: 'clear-cancel',
    onConfirm: () => {
      if (controller.clear()) announcer.announce('Board cleared. Undo is available.');
    },
    onClose: () => {
      relayout();
      canvas.focus({ preventScroll: true });
    },
  });

  const strip = el('aside', { class: 'strip', 'aria-label': 'Controls' }, [
    panel.element,
    el('div', { class: 'mode-row' }, [modeChip]),
    toolbar.element,
    panel.statusElement,
    notice,
    preview.element,
  ]);
  const boardWrap = el('main', { class: 'board-wrap' }, [canvas, panel.errorCard]);
  root.append(strip, boardWrap, clearDialog.element, announcer.element);
  welcome = buildWelcome();
  boardWrap.append(welcome);

  function buildWelcome(): HTMLElement {
    const start = el('button', { type: 'button', class: 'primary' }, ['Start camera']);
    const mouse = el('button', { type: 'button', class: 'secondary' }, ['Use mouse']);
    start.addEventListener('click', () => {
      dismissWelcome();
      void session.start();
    });
    mouse.addEventListener('click', () => {
      dismissWelcome();
      canvas.focus();
    });
    return el('section', { class: 'card welcome', 'aria-labelledby': 'welcome-title' }, [
      el('h1', { id: 'welcome-title' }, ['Air Whiteboard']),
      el('p', {}, ['Write with your hands through the webcam, or draw with a mouse or trackpad.']),
      el('p', {}, ['Pinch thumb and index finger to draw. Pinch with both hands to move and zoom. Hold a fist to erase.']),
      el('p', {}, [
        'Hand tracking runs on this device. Camera images are not uploaded, and the board stays in this tab unless you export it.',
      ]),
      el('div', { class: 'actions' }, [start, mouse]),
    ]);
  }

  function dismissWelcome(): void {
    welcome?.remove();
    welcome = null;
  }

  // --- Board, renderer, input -------------------------------------------------
  const controller = new BoardController(config);
  const renderer = new BoardRenderer(canvas, config.render, sink);
  renderer.attach(controller);
  controller.onChange((kind) => {
    if (kind === 'style' || kind === 'history' || kind === 'doc') syncToolbar();
    if (kind === 'limit' && controller.limitReached) {
      notice.hidden = false;
      setText(notice, 'The board is full. Export it or clear it to keep writing; your work is kept.');
    }
  });

  let lastFrameAt: number | null = null;
  renderer.onFrame = (duration) => {
    const now = performance.now();
    if (lastFrameAt !== null && now - lastFrameAt < 250) sink.sample('rafIntervalMs', now - lastFrameAt);
    lastFrameAt = now;
    sink.sample('frameWorkMs', duration);
    const observed = hands.pendingDrawObservedAt;
    if (observed !== null) {
      // Software pipeline: admitted-frame observation → canvas submission.
      sink.sample('drawSubmitMs', now - observed);
      hands.pendingDrawObservedAt = null;
    }
  };

  const hands = new HandInput({
    config: () => config,
    controller: () => controller,
    activateControl: (id) => activateTarget(id),
    metrics: sink,
    now: () => performance.now(),
    onUpdate: () => {
      renderer.setOverlay({ cursors: hands.cursors(), prediction: null });
      refreshHandFeedback();
      refreshMode();
      applyPendingConfig();
    },
  });

  function activateTarget(id: string): void {
    if (clearDialog.isOpen) {
      clearDialog.activate(id);
      return;
    }
    const command = commandForTarget(id);
    if (command !== null) runCommand(command);
  }

  function runCommand(command: Command): void {
    switch (command.kind) {
      case 'tool':
        controller.setTool(command.tool);
        break;
      case 'color':
        controller.setColor(command.value);
        break;
      case 'width':
        controller.setWidth(command.px);
        break;
      case 'undo':
        if (controller.undo()) announcer.announce('Undo');
        break;
      case 'redo':
        if (controller.redo()) announcer.announce('Redo');
        break;
      case 'clear':
        controller.closeTransientWork();
        clearDialog.open();
        relayout();
        break;
      case 'fit':
        controller.fit(layoutValue.board.width, layoutValue.board.height);
        break;
      case 'reset':
        controller.resetView();
        break;
      case 'pause':
        togglePause();
        break;
      case 'export':
      case 'settings':
      case 'help':
        // Implemented in M4.
        break;
    }
    syncToolbar();
  }

  function syncToolbar(): void {
    toolbar.sync(controller, hands.state.paused);
    canvas.dataset.tool = controller.tool;
  }

  let layoutValue: SurfaceLayout = computeLayout();
  function relative(r: DOMRect, origin: DOMRect): Rect {
    return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
  }
  function computeLayout(): SurfaceLayout {
    const rootRect = root.getBoundingClientRect();
    const boardRect = relative(canvas.getBoundingClientRect(), rootRect);
    // A modal dialog owns hand input: only its controls are targets, and the
    // rest of the surface absorbs pinches instead of drawing underneath.
    const scope: ParentNode = clearDialog.isOpen ? clearDialog.element : strip;
    const controls = [...scope.querySelectorAll<HTMLElement>('[data-hand-target]')]
      .filter((node) => node.getClientRects().length > 0 && !node.hasAttribute('disabled'))
      .map((node) => ({ id: node.dataset.handTarget ?? '', rect: relative(node.getBoundingClientRect(), rootRect) }));
    const hitBoard = clearDialog.isOpen ? { x: 0, y: 0, width: 0, height: 0 } : boardRect;
    return {
      width: rootRect.width,
      height: rootRect.height,
      board: boardRect,
      hitTest: regionFromLayout(hitBoard, controls, rootRect.width, rootRect.height),
    };
  }
  function relayout(): void {
    layoutValue = computeLayout();
    hands.setLayout(layoutValue);
    renderer.resize(layoutValue.board.width, layoutValue.board.height, globalThis.devicePixelRatio || 1);
  }
  new ResizeObserver(relayout).observe(root);
  new ResizeObserver(relayout).observe(strip);
  strip.addEventListener('scroll', relayout, { passive: true });
  relayout();

  function refreshHandFeedback(): void {
    const hover = new Set<string>();
    const pressed = new Set<string>();
    for (const h of hands.hands) {
      const region = layoutValue.hitTest(h.pen);
      if (region.kind !== 'control') continue;
      hover.add(region.id);
      if (hands.state.tracks.get(h.id)?.pinched === true) pressed.add(region.id);
    }
    toolbar.setHandFeedback(hover, pressed);
  }

  let spaceHeld = false;
  let pointerActive = false;
  attachPointerInput(canvas, {
    controller: () => controller,
    spaceHeld: () => spaceHeld,
    canStart: () => hands.idle && !clearDialog.isOpen,
    onUse: () => dismissWelcome(),
  });
  canvas.addEventListener('pointerdown', () => {
    pointerActive = true;
    hands.setBlocked(true);
  });
  const endPointer = (): void => {
    if (!pointerActive) return;
    pointerActive = false;
    hands.setBlocked(false);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);

  function pause(reason: 'pause' | 'blur' | 'hidden' | 'escape'): void {
    controller.closeTransientWork();
    if (!hands.state.paused) {
      hands.interrupt(reason, true);
      announcer.announce('Paused');
    }
    // Explicit pause keeps tracking (cursors) so hands can be opened before
    // resuming; blur/hidden also stop inference.
    if (reason === 'blur' || reason === 'hidden') session.pause();
    syncToolbar();
  }

  function resume(): void {
    if (sessionState.kind === 'paused') session.resume();
    hands.resume();
    announcer.announce('Resumed. Open your hand before drawing.');
    syncToolbar();
  }

  function togglePause(): void {
    if (hands.state.paused) resume();
    else pause('pause');
  }

  attachKeyboard(document, canvas, {
    undo: () => runCommand({ kind: 'undo' }),
    redo: () => runCommand({ kind: 'redo' }),
    requestClear: () => runCommand({ kind: 'clear' }),
    togglePause,
    escape: () => pause('escape'),
    setSpace: (held) => {
      spaceHeld = held;
      canvas.dataset.panning = held ? 'true' : 'false';
    },
  });

  watchInterruptions({ window, document }, () => config.lifecycle.hiddenStopMs, {
    suspend: (reason) => {
      // Startup prompts may blur the window; only an active session pauses.
      const k = sessionState.kind;
      if (k === 'ready' || k === 'warming' || k === 'paused') pause(reason);
      else controller.closeTransientWork();
    },
    hiddenTooLong: () => {
      if (!session.active) return;
      session.stop();
      notice.hidden = false;
      setText(notice, 'The camera was turned off because the tab was hidden. Start the camera again to continue.');
    },
    pageHide: () => session.stop(),
  });

  function refreshMode(): void {
    const running = sessionState.kind === 'ready' || sessionState.kind === 'paused' || sessionState.kind === 'warming';
    const label = hands.state.paused ? 'Paused' : running ? hands.label : 'Camera off';
    if (modeChip.textContent !== label && (label === 'Tracking lost' || label === 'Paused')) announcer.announce(label);
    setText(modeChip, label);
    modeChip.dataset.tone = label === 'Tracking lost' || label === 'Paused' ? 'warn' : '';
  }

  function applyPendingConfig(): void {
    if (pendingConfig === null || !hands.idle) return;
    config = pendingConfig;
    pendingConfig = null;
    controller.setConfig(config);
    hands.setConfig(config);
  }

  // --- Camera + tracking -----------------------------------------------------
  const session = new CameraSession({
    env: browserMediaEnvironment(),
    camera: () => config.camera,
    video: preview.video,
    snapshot: () => {
      const video = preview.video;
      if (inputScale === 1) return createImageBitmap(video);
      return createImageBitmap(video, {
        resizeWidth: Math.max(1, Math.round(video.videoWidth * inputScale)),
        resizeHeight: Math.max(1, Math.round(video.videoHeight * inputScale)),
        resizeQuality: 'medium',
      });
    },
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
    assets,
    backend: backendFromUrl(),
    createWorker: createInferenceWorker,
    metrics: sink,
    now: () => performance.now(),
    onState: (state) => {
      sessionState = state;
      preview.element.hidden = state.kind === 'idle' || state.kind === 'failed';
      if (state.kind === 'idle' || state.kind === 'failed') {
        preview.clear();
        hands.reset();
        if (hands.state.paused) hands.resume();
      }
      if (state.kind === 'ready') announcer.announce('Camera ready. Pinch to draw.');
      panel.render(state, handle.lastHands.length > 0);
      refreshMode();
      syncToolbar();
      relayout();
    },
    onSourceReset: () => hands.reset(),
    onResult: ({ result, observedAt }) => {
      const now = performance.now();
      sink.sample('inferenceMs', result.inferenceMs);
      sink.sample('resultAgeMs', now - observedAt);
      const video = preview.video;
      hands.setCamera({ width: video.videoWidth, height: video.videoHeight });
      const hadHands = handle.lastHands.length > 0;
      handle.lastHands = result.hands;
      if (hadHands !== result.hands.length > 0) panel.render(sessionState, result.hands.length > 0);
      hands.handleResult(result.sourceTimeMs, result.hands, observedAt);
      const mapping = hands.pipeline.currentMapping;
      preview.draw(result.hands, now, mapping?.rect ?? null);
    },
  });
  panel.render(session.state, false);
  preview.element.hidden = true;
  refreshMode();
  syncToolbar();

  setInterval(() => {
    if (hands.lossCheckEnabled) hands.checkLoss(performance.now());
  }, 50);

  const handle: AppHandle = {
    metrics,
    session,
    controller,
    renderer,
    hands,
    config: () => config,
    applyConfig: (patch) => {
      const result = patchConfig(pendingConfig ?? config, patch);
      if (result.ok) {
        pendingConfig = result.config;
        applyPendingConfig();
      }
      return result;
    },
    layout: () => layoutValue,
    createWorker: createInferenceWorker,
    assets,
    command: runCommand,
    injectResult: (sourceTimeMs, payload, ageMs, camera) => {
      hands.setCamera(camera);
      handle.lastHands = payload;
      hands.handleResult(sourceTimeMs, payload, performance.now() - ageMs);
    },
    lastHands: [],
  };
  if (__DEVTOOLS__) {
    void import('../dev/devtools').then((dev) => dev.installDevtools(handle));
  }
  return handle;
}
