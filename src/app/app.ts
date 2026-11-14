/**
 * Composition root. Wires camera/tracking, hand input, pointer and keyboard
 * input, the board controllers (real and practice), the renderer, and the UI.
 * UI code dispatches commands and reads summaries; it never edits strokes.
 */
import { BoardController } from '../board/controller';
import { browserMediaEnvironment, listCameras, type CameraDevice } from '../camera/camera-source';
import { attachKeyboard } from '../input/keyboard';
import { attachPointerInput } from '../input/pointer-input';
import { ExportError, downloadBlob, exportFileName, renderPng } from '../render/export';
import { BoardRenderer } from '../render/renderer';
import type { SurfaceLayout } from '../tracking/hand-pipeline';
import type { HandPayload } from '../tracking/protocol';
import type { BackendPreference, WorkerLike } from '../tracking/tracker-client';
import { Announcer } from '../ui/announcer';
import { CameraPanel } from '../ui/camera-panel';
import { ConfirmDialog } from '../ui/dialogs';
import { el, setText } from '../ui/dom';
import { computeSurfaceLayout } from '../ui/layout';
import { CameraPreview } from '../ui/preview';
import { SettingsDialog, type SettingsValues } from '../ui/settings';
import { Toolbar, commandForTarget, type Command } from '../ui/toolbar';
import { resolveAssets, type ResolvedAssets } from './assets';
import { CameraSession, type SessionState } from './camera-session';
import { DEFAULT_CONFIG, patchConfig, type AppConfig, type ConfigResult } from './config';
import { HandInput } from './hand-input';
import { watchInterruptions } from './interruptions';
import { Metrics, noopMetrics, type MetricsSink } from './metrics';
import { PracticeSession } from './practice';

type ConfigPatch = Parameters<typeof patchConfig>[1];

export interface AppHandle {
  readonly metrics: Metrics | null;
  readonly session: CameraSession;
  /** The real board (never the practice board). */
  readonly controller: BoardController;
  /** The board input currently edits (real or practice). */
  readonly activeBoard: () => BoardController;
  readonly practice: PracticeSession;
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
  /** Development-only observer of every accepted tracking result (recording). */
  resultTap: ((sourceTimeMs: number, hands: readonly HandPayload[], ageMs: number, camera: { width: number; height: number }) => void) | null;
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
  const env = browserMediaEnvironment();

  // --- DOM -----------------------------------------------------------------
  const canvas = el('canvas', {
    class: 'board',
    tabindex: 0,
    'aria-label': 'Whiteboard. Drag to draw, hold Space and drag to pan, scroll to zoom. Shortcuts: Z undo, Shift+Z redo, C clear, P pause.',
  });
  const preview = new CameraPreview();
  let previewWanted = true;
  const announcer = new Announcer();
  const modeChip = el('span', { class: 'mode-chip', 'aria-hidden': 'true' }, ['Camera off']);
  const notice = el('p', { class: 'status notice', hidden: true });
  let welcome: HTMLElement | null = null;
  let sessionState: SessionState = { kind: 'idle' };
  let cameras: CameraDevice[] = [];

  const showNotice = (text: string): void => {
    notice.hidden = false;
    setText(notice, text);
  };

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
      if (activeBoard.clear()) announcer.announce('Board cleared. Undo is available.');
    },
    onClose: () => {
      relayout();
      canvas.focus({ preventScroll: true });
    },
  });
  const settings = new SettingsDialog({
    setStabilizer: (stabilizer) => updateSettings({ stabilizer }),
    setReach: (reach) => updateSettings({ reach }),
    setFistErase: (fistEraseEnabled) => updateSettings({ gesture: { fistEraseEnabled } }),
    setPreview: (visible) => {
      previewWanted = visible;
      preview.setVisible(visible);
      settings.update(settingsValues());
    },
    setCamera: (deviceId) => {
      void session.switchDevice(deviceId);
    },
    resetDefaults: () => {
      updateSettings({ stabilizer: DEFAULT_CONFIG.stabilizer, reach: DEFAULT_CONFIG.reach, gesture: { fistEraseEnabled: true } });
      previewWanted = true;
      preview.setVisible(true);
      settings.update(settingsValues());
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
  root.append(strip, boardWrap, clearDialog.element, settings.element, announcer.element);
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
    relayout();
  }

  // --- Boards, renderer --------------------------------------------------------
  const controller = new BoardController(config);
  let activeBoard: BoardController = controller;
  const renderer = new BoardRenderer(canvas, config.render, sink);
  renderer.attach(controller);
  const observeBoard = (board: BoardController): void => {
    board.onChange((kind) => {
      if (board !== activeBoard) return;
      if (kind === 'style' || kind === 'history' || kind === 'doc') syncToolbar();
      if (kind === 'limit' && board.limitReached) showNotice('The board is full. Export it or clear it to keep writing; your work is kept.');
    });
  };
  observeBoard(controller);

  const practice = new PracticeSession({
    config: () => config,
    mainBoard: controller,
    boardCenter: () => ({ x: layoutValue.board.width / 2, y: layoutValue.board.height / 2 }),
    usingHands: () => sessionState.kind === 'ready',
    now: () => performance.now(),
    setActiveBoard: (board) => {
      activeBoard.closeTransientWork();
      activeBoard = board;
      if (board !== controller) observeBoard(board);
      renderer.setBoard(board);
      syncToolbar();
    },
    onChange: () => relayout(),
  });
  boardWrap.append(practice.card.element, practice.offer.element);

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
    controller: () => activeBoard,
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
    const target = root.querySelector<HTMLElement>(`[data-hand-target="${CSS.escape(id)}"]`);
    if (target === null || target.hasAttribute('disabled') || target.closest('[hidden]') !== null) return;
    if (clearDialog.isOpen) {
      clearDialog.activate(id);
      return;
    }
    if (settings.isOpen) {
      settings.activate(id);
      return;
    }
    if (practice.activate(id)) return;
    const command = commandForTarget(id);
    if (command !== null) runCommand(command);
  }

  function runCommand(command: Command): void {
    const board = activeBoard;
    switch (command.kind) {
      case 'tool':
        board.setTool(command.tool);
        break;
      case 'color':
        board.setColor(command.value);
        break;
      case 'width':
        board.setWidth(command.px);
        break;
      case 'undo':
        if (board.undo()) announcer.announce('Undo');
        break;
      case 'redo':
        if (board.redo()) announcer.announce('Redo');
        break;
      case 'clear':
        board.closeTransientWork();
        clearDialog.open();
        relayout();
        break;
      case 'fit':
        board.fit(layoutValue.board.width, layoutValue.board.height);
        break;
      case 'reset':
        board.resetView();
        break;
      case 'pause':
        togglePause();
        break;
      case 'export':
        void exportPng();
        break;
      case 'settings':
        settings.open(settingsValues());
        relayout();
        break;
      case 'help':
        if (practice.active) practice.stop();
        else practice.start();
        break;
    }
    syncToolbar();
  }

  async function exportPng(): Promise<void> {
    const r = renderer.stats;
    try {
      const blob = await renderPng(activeBoard, r.cssWidth, r.cssHeight, r.rasterScale);
      downloadBlob(blob, exportFileName(new Date()));
      announcer.announce('Exported the visible board as a PNG image.');
    } catch (error) {
      const message = error instanceof ExportError ? error.message : 'Export failed.';
      showNotice(`${message} Your board is unchanged.`);
    }
  }

  function settingsValues(): SettingsValues {
    const c = pendingConfig ?? config;
    return {
      stabilizer: c.stabilizer,
      reach: c.reach,
      fistErase: c.gesture.fistEraseEnabled,
      preview: previewWanted,
      cameras,
      cameraId: session.details.camera?.deviceId ?? null,
    };
  }

  function updateSettings(patch: ConfigPatch): void {
    handle.applyConfig(patch);
    settings.update(settingsValues());
  }

  function syncToolbar(): void {
    toolbar.sync(activeBoard, hands.state.paused);
    canvas.dataset.tool = activeBoard.tool;
  }

  let layoutValue: SurfaceLayout = computeLayout();
  function computeLayout(): SurfaceLayout {
    const modal = clearDialog.isOpen ? clearDialog.element : settings.isOpen ? settings.element : null;
    const overlays = [practice.card.element, practice.offer.element, panel.errorCard, ...(welcome !== null ? [welcome] : [])];
    return computeSurfaceLayout(root, canvas, modal, overlays);
  }
  function relayout(): void {
    layoutValue = computeLayout();
    hands.setLayout(layoutValue);
    renderer.resize(layoutValue.board.width, layoutValue.board.height, globalThis.devicePixelRatio || 1);
  }
  new ResizeObserver(relayout).observe(root);
  new ResizeObserver(relayout).observe(strip);
  strip.addEventListener('scroll', relayout, { passive: true });
  // Hand hit regions depend on which controls are visible and enabled; keep
  // them current when buttons enable/disable or cards and dialogs show/hide.
  let layoutScheduled = false;
  new MutationObserver(() => {
    if (layoutScheduled) return;
    layoutScheduled = true;
    requestAnimationFrame(() => {
      layoutScheduled = false;
      relayout();
    });
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'open'] });
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
    controller: () => activeBoard,
    spaceHeld: () => spaceHeld,
    canStart: () => hands.idle && !clearDialog.isOpen && !settings.isOpen,
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
    activeBoard.closeTransientWork();
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
      else activeBoard.closeTransientWork();
    },
    hiddenTooLong: () => {
      if (!session.active) return;
      session.stop();
      showNotice('The camera was turned off because the tab was hidden. Start the camera again to continue.');
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
    if (activeBoard !== controller) activeBoard.setConfig(config);
    hands.setConfig(config);
  }

  // --- Camera + tracking -----------------------------------------------------
  const session = new CameraSession({
    env,
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
      if (state.kind === 'ready') {
        announcer.announce('Camera ready. Pinch to draw.');
        practice.offerOnce();
        void listCameras(env).then((list) => {
          cameras = list;
          if (settings.isOpen) settings.update(settingsValues());
        });
      }
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
      handle.resultTap?.(result.sourceTimeMs, result.hands, now - observedAt, { width: video.videoWidth, height: video.videoHeight });
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
    activeBoard: () => activeBoard,
    practice,
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
    resultTap: null,
    lastHands: [],
  };
  if (__DEVTOOLS__) {
    void import('../dev/devtools').then((dev) => dev.installDevtools(handle));
  }
  return handle;
}
