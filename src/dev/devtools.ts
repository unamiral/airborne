/**
 * Developer tools (development and bench builds only; production builds drop
 * this module because `__DEVTOOLS__` is a compile-time `false`).
 *
 * The HUD updates at most 4 Hz and labels all timings as software pipeline
 * measurements (plan §12).
 */
import type { AppHandle } from '../app/app';
import type { SeriesName } from '../app/metrics';
import { el } from '../ui/dom';

declare global {
  interface Window {
    /** Test/benchmark handle; never present in production builds. */
    __air?: AppHandle;
  }
}

const SERIES: ReadonlyArray<[SeriesName, string]> = [
  ['inferenceMs', 'inference (worker)'],
  ['roundTripMs', 'post→result (main)'],
  ['snapshotMs', 'bitmap snapshot'],
  ['resultAgeMs', 'result age'],
  ['drawSubmitMs', 'obs→draw submit'],
  ['inputMs', 'input math+reducer'],
  ['inputMs', 'input math+reducer'],
  ['renderMs', 'render'],
  ['frameWorkMs', 'frame work'],
  ['frameWorkMs', 'frame work'],
];

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '–';
}

export function installDevtools(app: AppHandle): void {
  window.__air = app;
  const params = new URLSearchParams(location.search);
  if (params.get('hud') === '0') return;
  const hud = el('div', { class: 'hud', 'aria-hidden': 'true' });
  document.body.append(hud);
  const metrics = app.metrics;
  if (metrics === null) return;
  setInterval(() => {
    const info = app.session.details;
    const lines = [
      'software pipeline (not frame-to-pixel)',
      `state ${app.session.state.kind}  backend ${info.backend ?? '–'}`,
      `camera ${info.camera?.width ?? '–'}x${info.camera?.height ?? '–'} @${fmt(info.camera?.frameRate ?? Number.NaN)}`,
      `frames src ${metrics.counter('sourceFrames')} adm ${metrics.counter('admitted')} ok ${metrics.counter('accepted')}`,
      `skip busy ${metrics.counter('busySkips')} dup ${metrics.counter('duplicateFrames')} stale ${metrics.counter('staleResults')}`,
      `errors det ${metrics.counter('detectErrors')} timeout ${metrics.counter('timeouts')}`,
      `hands ${app.lastHands.length}  mode ${app.hands.label}  strokes ${app.controller.stats.strokes} pts ${app.controller.stats.points}`,
    ];
    for (const [name, label] of SERIES) {
      const s = metrics.summary(name);
      if (s.count > 0) lines.push(`${label.padEnd(20)} p50 ${fmt(s.p50)} p95 ${fmt(s.p95)} n=${s.count}`);
    }
    hud.textContent = lines.join('\n');
  }, 250);
}
