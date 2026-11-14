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
import { CameraPanel } from '../ui/camera-panel';
import { el, setText } from '../ui/dom';
import { CameraPreview } from '../ui/preview';
import { resolveAssets } from './assets';
import { CameraSession, type SessionState } from './camera-session';
import { DEFAULT_CONFIG, type AppConfig } from './config';
import { HandInput } from './hand-input';
import { Metrics, noopMetrics, type MetricsSink } from './metrics';

export interface AppHandle {
  readonly metrics: Metrics | null;
  readonly session: CameraSession;
  readonly controller: BoardController;
  readonly renderer: BoardRenderer;
  readonly hands: HandInput;
  readonly config: () => AppConfig;
  /** Feeds a tracking result exactly as the camera path does (dev replay). */
  readonly injectResult: (sourceTimeMs: number, hands: readonly HandPayload[], ageMs: number, camera: { width: number; height: number }) => void;
  readonly layout: () => SurfaceLayout;
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
  const config: AppConfig = DEFAULT_CONFIG;
  const inputScale = inputScaleFromUrl();

  // --- DOM -----------------------------------------------------------------
  const canvas = el('canvas', {
    class: 'board',
    tabindex: 0,
    'aria-label': 'Whiteboard. Drag to draw, hold Space and drag to pan, scroll to zoom.',
  });
  const preview = new CameraPreview();
  const modeChip = el('span', { class: 'mode-chip', 'aria-hidden': 'true' }, ['Camera off']);
  let welcome: HTMLElement | null = null;
  let sessionState: SessionState = { kind: 'idle' };

  const panel = new CameraPanel({
    onStart: () => {
      dismissWelcome();
      void session.start();
    },
    onStop: () => session.stop(),
    onUseMouse: () => {
      dismissWelcome();
      panel.hideError();
      canvas.focus();
    },
  });

  const strip = el('aside', { class: 'strip', 'aria-label': 'Controls' }, [
    panel.element,
    el('div', { class: 'mode-row' }, [modeChip]),
    panel.statusElement,
    preview.element,
  ]);
  const boardWrap = el('main', { class: 'board-wrap' }, [canvas, panel.errorCard]);
  root.append(strip, boardWrap);
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
    activateControl: () => undefined,
    metrics: sink,
    now: () => performance.now(),
    onUpdate: () => {
      renderer.setOverlay({ cursors: hands.cursors(), prediction: null });
      refreshMode();
    },
  });

  let layoutValue: SurfaceLayout = computeLayout();
  function relative(r: DOMRect, origin: DOMRect): Rect {
    return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
  }
  function computeLayout(): SurfaceLayout {
    const rootRect = root.getBoundingClientRect();
    const board = relative(canvas.getBoundingClientRect(), rootRect);
    const controls = [...root.querySelectorAll<HTMLElement>('[data-hand-target]')]
      .filter((node) => node.offsetParent !== null && !node.hasAttribute('disabled'))
      .map((node) => ({ id: node.dataset.handTarget ?? '', rect: relative(node.getBoundingClientRect(), rootRect) }));
    return {
      width: rootRect.width,
      height: rootRect.height,
      board,
      hitTest: regionFromLayout(board, controls, rootRect.width, rootRect.height),
    };
  }
  const relayout = (): void => {
    layoutValue = computeLayout();
    hands.setLayout(layoutValue);
    renderer.resize(layoutValue.board.width, layoutValue.board.height, globalThis.devicePixelRatio || 1);
  };
  new ResizeObserver(relayout).observe(root);
  strip.addEventListener('scroll', relayout, { passive: true });
  relayout();

  let spaceHeld = false;
  let pointerActive = false;
  attachPointerInput(canvas, {
    controller: () => controller,
    spaceHeld: () => spaceHeld,
    canStart: () => hands.idle,
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

  const togglePause = (): void => {
    if (hands.state.paused) hands.resume();
    else hands.interrupt('pause', true);
  };
  attachKeyboard(document, canvas, {
    undo: () => controller.undo(),
    redo: () => controller.redo(),
    requestClear: () => undefined,
    togglePause,
    escape: () => {
      controller.closeTransientWork();
      hands.interrupt('escape', true);
    },
    setSpace: (held) => {
      spaceHeld = held;
      canvas.dataset.panning = held ? 'true' : 'false';
    },
  });

  function refreshMode(): void {
    const running = sessionState.kind === 'ready' || sessionState.kind === 'paused' || sessionState.kind === 'warming';
    const label = running ? hands.label : 'Camera off';
    setText(modeChip, label);
    modeChip.dataset.tone = label === 'Tracking lost' || label === 'Paused' ? 'warn' : '';
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
    assets: resolveAssets(document.baseURI),
    backend: backendFromUrl(),
    createWorker: createInferenceWorker,
    metrics: sink,
    now: () => performance.now(),
    onState: (state) => {
      sessionState = state;
      if (state.kind === 'idle' || state.kind === 'failed') {
        preview.clear();
        hands.reset();
      }
      panel.render(state, handle.lastHands.length > 0);
      refreshMode();
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
  refreshMode();

  setInterval(() => hands.checkLoss(performance.now()), 50);
  globalThis.addEventListener('pagehide', () => session.stop());

  const handle: AppHandle = {
    metrics,
    session,
    controller,
    renderer,
    hands,
    config: () => config,
    layout: () => layoutValue,
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
