/**
 * Developer tools (development and bench builds only; production builds drop
 * this module because `__DEVTOOLS__` is a compile-time `false`).
 *
 * - HUD at most 4 Hz; timings labelled as software pipeline measurements.
 * - `window.__air`: test/benchmark handle with replay and image detection.
 */
import type { AppHandle } from '../app/app';
import type { SeriesName } from '../app/metrics';
import type { HandPayload } from '../tracking/protocol';
import { startTracker } from '../tracking/tracker-client';
import { el } from '../ui/dom';
import { parseReplay } from './replay-format';

export interface DevHandle extends AppHandle {
  /** Plays a replay record through the live input path at `speed` (Infinity = no waiting). */
  readonly replay: (record: unknown, speed: number) => Promise<void>;
  /** Runs the real worker on still images (one fresh epoch per image) and returns the hands. */
  readonly detectImages: (images: readonly Blob[], backend: 'GPU' | 'CPU') => Promise<HandPayload[][]>;
  /** Serialized board content for equality checks. */
  readonly boardDump: () => number[][];
}

declare global {
  interface Window {
    /** Test/benchmark handle; never present in production builds. */
    __air?: DevHandle;
  }
}

const SERIES: ReadonlyArray<[SeriesName, string]> = [
  ['inferenceMs', 'inference (worker)'],
  ['roundTripMs', 'post→result (main)'],
  ['snapshotMs', 'bitmap snapshot'],
  ['resultAgeMs', 'result age'],
  ['drawSubmitMs', 'obs→draw submit'],
  ['inputMs', 'input math+reducer'],
  ['renderMs', 'render'],
  ['frameWorkMs', 'frame work'],
];

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '–';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function installDevtools(app: AppHandle): void {
  const handle: DevHandle = Object.assign(app, {
    replay: async (json: unknown, speed: number): Promise<void> => {
      const parsed = parseReplay(json);
      if (!parsed.ok) throw new Error(`Invalid replay: ${parsed.errors.join('; ')}`);
      const record = parsed.record;
      app.session.stop();
      app.hands.reset();
      // Losses are encoded in the record's timeline; wall-clock loss checks
      // would make outcomes depend on playback speed.
      app.hands.lossCheckEnabled = false;
      try {
        for (let i = 0; i < record.frames.length; i++) {
          const frame = record.frames[i]!;
          app.injectResult(frame.t, frame.hands, frame.ageMs, record.camera);
          const next = record.frames[i + 1];
          if (next !== undefined) {
            if (Number.isFinite(speed)) await sleep((next.t - frame.t) / speed);
            else await Promise.resolve();
          }
        }
      } finally {
        app.hands.lossCheckEnabled = true;
      }
    },
    detectImages: async (images: readonly Blob[], backend: 'GPU' | 'CPU'): Promise<HandPayload[][]> => {
      const tracker = await startTracker({
        createWorker: app.createWorker,
        assets: app.assets,
        backend,
        initTimeoutMs: 60_000,
        detectTimeoutMs: 10_000,
        warmupFrames: 1,
      });
      try {
        const out: HandPayload[][] = [];
        let seq = 0;
        for (const [epoch, image] of images.entries()) {
          let hands: HandPayload[] = [];
          // Several frames of the same image let VIDEO-mode tracking settle.
          for (let k = 0; k < 3; k++) {
            const bitmap = await createImageBitmap(image);
            const result = await tracker.detect({
              epoch: epoch + 1,
              seq: ++seq,
              sourceTimeMs: 1000 + k * 33,
              width: bitmap.width,
              height: bitmap.height,
              bitmap,
            });
            hands = [...result.hands];
          }
          out.push(hands);
        }
        return out;
      } finally {
        tracker.dispose();
      }
    },
    boardDump: (): number[][] =>
      app.controller.doc.strokes.map((s) => {
        const pts: number[] = [];
        s.points.forEach((x, y) => pts.push(x, y));
        return pts;
      }),
  });
  window.__air = handle;

  const params = new URLSearchParams(location.search);
  if (params.get('hud') === '0') return;
  const hud = el('div', { class: 'hud', 'aria-hidden': 'true' });
  document.body.append(hud);
  const metrics = app.metrics;
  if (metrics === null) return;
  setInterval(() => {
    const info = app.session.details;
    const r = app.renderer.stats;
    const lines = [
      'software pipeline (not frame-to-pixel)',
      `state ${app.session.state.kind}  backend ${info.backend ?? '–'}`,
      `camera ${info.camera?.width ?? '–'}x${info.camera?.height ?? '–'} @${fmt(info.camera?.frameRate ?? Number.NaN)}`,
      `frames src ${metrics.counter('sourceFrames')} adm ${metrics.counter('admitted')} ok ${metrics.counter('accepted')}`,
      `skip busy ${metrics.counter('busySkips')} dup ${metrics.counter('duplicateFrames')} stale ${metrics.counter('staleResults')}`,
      `errors det ${metrics.counter('detectErrors')} timeout ${metrics.counter('timeouts')} outliers ${metrics.counter('outliersFlagged')} ambiguous ${metrics.counter('identityAmbiguous')}`,
      `hands ${app.lastHands.length}  mode ${app.hands.label}  strokes ${app.controller.stats.strokes} pts ${app.controller.stats.points}`,
      `raster ${r.backingWidth}x${r.backingHeight} @${fmt(r.rasterScale)} cache ${(r.cacheBytes / 1048576).toFixed(1)} MiB desync ${String(r.desynchronized)}`,
    ];
    for (const [name, label] of SERIES) {
      const s = metrics.summary(name);
      if (s.count > 0) lines.push(`${label.padEnd(20)} p50 ${fmt(s.p50)} p95 ${fmt(s.p95)} n=${s.count}`);
    }
    hud.textContent = lines.join('\n');
  }, 250);
}
