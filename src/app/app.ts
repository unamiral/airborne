/**
 * Composition root (M0 slice): pointer-only board stub, camera lifecycle,
 * worker inference, mirrored preview with a one-hand skeleton, and metrics.
 */
import { browserMediaEnvironment } from '../camera/camera-source';
import { BoardDocument, type Stroke } from '../board/document';
import { attachPointerDrawing } from '../input/pointer-input';
import { BoardRenderer, type CursorView } from '../render/renderer';
import { LM } from '../tracking/landmarks';
import type { HandPayload } from '../tracking/protocol';
import type { BackendPreference, WorkerLike } from '../tracking/tracker-client';
import { CameraPanel } from '../ui/camera-panel';
import { el } from '../ui/dom';
import { CameraPreview } from '../ui/preview';
import { resolveAssets } from './assets';
import { CameraSession, type SessionState } from './camera-session';
import { DEFAULT_CONFIG } from './config';
import { Metrics, noopMetrics, type MetricsSink } from './metrics';

export interface AppHandle {
  readonly metrics: Metrics | null;
  readonly session: CameraSession;
  readonly board: BoardDocument;
  readonly renderer: BoardRenderer;
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
 * the full camera frame is sent; see docs/performance/m0-backend.md.
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
  const config = DEFAULT_CONFIG;
  const inputScale = inputScaleFromUrl();

  // --- DOM -----------------------------------------------------------------
  const canvas = el('canvas', {
    class: 'board',
    tabindex: 0,
    'aria-label': 'Whiteboard canvas. Drag to draw.',
  });
  const preview = new CameraPreview();
  let welcome: HTMLElement | null = null;
  let handVisible = false;
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

  // --- Board stub (pointer) ------------------------------------------------
  const board = new BoardDocument();
  const renderer = new BoardRenderer(canvas);
  let active: { points: number[] } | null = null;
  let cursor: CursorView | null = null;
  let frameRequested = false;

  const requestDraw = (): void => {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      const start = performance.now();
      const activeStroke: Stroke | null =
        active !== null ? { id: 0, color: '#1b1f24', width: 3, points: active.points } : null;
      renderer.draw(board.strokes, activeStroke, cursor);
      sink.sample('renderMs', performance.now() - start);
    });
  };

  const resize = (): void => {
    const rect = boardWrap.getBoundingClientRect();
    renderer.resize(rect.width, rect.height, globalThis.devicePixelRatio || 1);
    requestDraw();
  };
  new ResizeObserver(resize).observe(boardWrap);

  attachPointerDrawing(canvas, {
    begin: (x, y) => {
      dismissWelcome();
      active = { points: [x, y] };
      requestDraw();
    },
    move: (x, y) => {
      active?.points.push(x, y);
      requestDraw();
    },
    end: () => {
      if (active !== null) board.add('#1b1f24', 3, active.points);
      active = null;
      requestDraw();
    },
  });

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
      if (state.kind !== 'ready') handVisible = false;
      if (state.kind === 'idle' || state.kind === 'failed') {
        preview.clear();
        cursor = null;
        requestDraw();
      }
      panel.render(state, handVisible);
    },
    onSourceReset: () => {
      cursor = null;
    },
    onResult: ({ result, observedAt }) => {
      const now = performance.now();
      sink.sample('inferenceMs', result.inferenceMs);
      sink.sample('resultAgeMs', now - observedAt);
      if (now - observedAt > config.gesture.staleResultMs) {
        sink.count('staleResults');
        return;
      }
      sink.count('accepted');
      handle.lastHands = result.hands;
      const visible = result.hands.length > 0;
      if (visible !== handVisible) {
        handVisible = visible;
        panel.render(sessionState, handVisible);
      }
      preview.draw(result.hands, now, null);
      // M0 one-hand overlay: mirrored thumb/index midpoint over the board.
      const hand = result.hands[0];
      if (hand !== undefined) {
        const lm = hand.landmarks;
        const u = (lm[LM.THUMB_TIP * 3]! + lm[LM.INDEX_TIP * 3]!) / 2;
        const v = (lm[LM.THUMB_TIP * 3 + 1]! + lm[LM.INDEX_TIP * 3 + 1]!) / 2;
        const rect = canvas.getBoundingClientRect();
        cursor = { x: (1 - u) * rect.width, y: v * rect.height, color: '#0b57d0', diameter: 12 };
      } else {
        cursor = null;
      }
      requestDraw();
      sink.sample('drawSubmitMs', performance.now() - observedAt);
    },
  });
  panel.render(session.state, false);

  globalThis.addEventListener('pagehide', () => session.stop());

  const handle: AppHandle = { metrics, session, board, renderer, lastHands: [] };
  if (__DEVTOOLS__) {
    void import('../dev/devtools').then((dev) => dev.installDevtools(handle));
  }
  return handle;
}
