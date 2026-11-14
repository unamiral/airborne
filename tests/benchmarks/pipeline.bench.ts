/**
 * Software-pipeline timings with the live camera path (plan §12): frame
 * observation → canvas draw submission, input math + reducer, app work per
 * active frame, rAF cadence, result age, and inference. Fake camera (MediaPipe
 * test photos, hands hovering), GPU-backed Chromium new-headless, 3 × 60 s
 * after a 5 s warm-up. These are software timestamps, not physical latency.
 */
import { expect, test } from '@playwright/test';
import { summarize, type SeriesName } from '../../src/app/metrics';
import type {} from '../../src/dev/devtools';
import { describeEnvironment, round, writeJson } from './environment';

const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 60);
const SERIES: readonly SeriesName[] = ['inferenceMs', 'resultAgeMs', 'inputMs', 'drawSubmitMs', 'frameWorkMs', 'rafIntervalMs', 'renderMs'];

test('software pipeline timings', async ({ browser, page }) => {
  test.setTimeout((RUNS * SECONDS + 120) * 1000);
  const environment = await describeEnvironment(browser, page);
  await page.goto('./?hud=0&recorder=0');
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air?.session.state.kind), { timeout: 90_000 }).toBe('ready');
  await page.waitForTimeout(5000);
  const runs: Array<{ raw: Record<string, number[]>; counters: Record<string, number> }> = [];
  for (let r = 0; r < RUNS; r++) {
    // Independent probes: every display frame's interval (the app itself only
    // renders when something changed) and main-thread long tasks.
    await page.evaluate(() => {
      const w = window as unknown as { __probe: { raf: number[]; long: number[]; stop: boolean; observer: PerformanceObserver } };
      // One observer per run, bound to this run's arrays and disconnected at
      // the end (an earlier version leaked observers and counted tasks twice).
      const probe = { raf: [] as number[], long: [] as number[], stop: false, observer: new PerformanceObserver((list) => {
        for (const e of list.getEntries()) probe.long.push(e.duration);
      }) };
      w.__probe = probe;
      let last = performance.now();
      const tick = (now: number): void => {
        probe.raf.push(now - last);
        last = now;
        if (!probe.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      probe.observer.observe({ type: 'longtask', buffered: false });
      window.__air!.metrics!.reset();
    });
    await page.waitForTimeout(SECONDS * 1000);
    runs.push(
      await page.evaluate((series) => {
        const w = window as unknown as { __probe: { raf: number[]; long: number[]; stop: boolean; observer: PerformanceObserver } };
        w.__probe.stop = true;
        w.__probe.observer.disconnect();
        const m = window.__air!.metrics!;
        const raw: Record<string, number[]> = {};
        for (const name of series) raw[name] = Array.from(m.values(name));
        raw.displayFrameMs = w.__probe.raf.slice(1);
        raw.longTaskMs = w.__probe.long;
        return { raw, counters: m.snapshot().counters };
      }, SERIES),
    );
  }
  const backend = await page.evaluate(() => window.__air!.session.details.backend);
  const pooled = Object.fromEntries(SERIES.map((s) => [s, summarize(runs.flatMap((r) => r.raw[s] ?? []))]));
  const raf = runs.flatMap((r) => r.raw.displayFrameMs ?? []);
  const cadence = raf.length > 0 ? raf.filter((v) => v <= 20).length / raf.length : Number.NaN;
  const longTasks = runs.flatMap((r) => r.raw.longTaskMs ?? []);
  const result = {
    environment,
    backend,
    protocol: { RUNS, SECONDS, warmupS: 5 },
    pooled,
    rafWithin20ms: cadence,
    displayFrames: summarize(raf),
    longTasks: { count: longTasks.length, max: longTasks.length > 0 ? Math.max(...longTasks) : 0 },
    acceptedPerSecond: runs.map((r) => (r.counters.accepted ?? 0) / SECONDS),
    raw: runs.map((r) => Object.fromEntries(Object.entries(r.raw).map(([k, v]) => [k, round(v)]))),
  };
  writeJson('bench-results/m5-pipeline.json', result);
  console.log(JSON.stringify({ backend, pooled, rafWithin20ms: cadence, longTasks: result.longTasks, acceptedPerSecond: result.acceptedPerSecond }, null, 1));
});

test('shell load (warm) and ready-after-permission (cached and cold 25 Mbps)', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const environment = await describeEnvironment(browser, page);
  // Warm navigations: time until the board and controls are interactive.
  await page.goto('./?hud=0&recorder=0');
  const shell: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await page.getByRole('button', { name: 'Use mouse' }).waitFor();
    // The module script builds the whole UI synchronously before
    // DOMContentLoaded completes, so DCL end marks an interactive shell.
    shell.push(
      await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventEnd),
    );
  }
  // Ready after permission with cached assets (this context already loaded them once).
  const readyTimes = async (p: typeof page) => {
    await p.getByRole('button', { name: 'Start camera' }).first().click();
    await expect.poll(() => p.evaluate(() => window.__air?.session.state.kind), { timeout: 120_000 }).toBe('ready');
    return p.evaluate(() => {
      const d = window.__air!.session.details;
      return { permissionToReadyMs: d.permissionToReadyMs, readyToFirstResultMs: d.readyToFirstResultMs, timings: d.initTimings, backend: d.backend };
    });
  };
  await page.goto('./?hud=0&recorder=0');
  const warmFirst = await readyTimes(page);
  await page.reload();
  const cached = await readyTimes(page);
  await context.close();
  // Cold: fresh context (empty HTTP cache) throttled to 25 Mbps down / 5 Mbps up, 20 ms RTT.
  const cold = await browser.newContext();
  const coldPage = await cold.newPage();
  const cdp = await cold.newCDPSession(coldPage);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (25e6 / 8), uploadThroughput: (5e6 / 8) });
  await coldPage.goto('./?hud=0&recorder=0');
  const coldResult = await readyTimes(coldPage);
  const transferred = await coldPage.evaluate(() =>
    performance.getEntriesByType('resource').reduce((sum, e) => sum + ((e as PerformanceResourceTiming).transferSize || 0), 0),
  );
  await cold.close();
  const result = { environment, shellInteractiveMs: shell, warmFirst, cached, cold25Mbps: { ...coldResult, transferredBytes: transferred, note: 'vite preview serves uncompressed files' } };
  writeJson('bench-results/m5-startup.json', result);
  console.log(JSON.stringify(result, null, 1));
});
