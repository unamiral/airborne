/**
 * M0 backend comparison (plan §6 "Worker capability spike", §12).
 *
 * For each delegate: a cold start in a fresh profile (initialization reported
 * separately), a 5 s warm-up that is excluded, then RUNS x RUN_SECONDS of
 * steady state with raw samples kept. Percentiles are computed from raw
 * samples per run and pooled; stages are never summed.
 *
 * Run: npm run build:bench && npx playwright test -c playwright.bench.config.ts backend
 */
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, type SeriesName, type Summary } from '../../src/app/metrics';
import type {} from '../../src/dev/devtools';
import { BENCH_URL } from '../../playwright.config.ts';
import { describeEnvironment, round, writeJson } from './environment';

const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const RUN_SECONDS = Number(process.env.BENCH_SECONDS ?? 60);
const WARMUP_SECONDS = 5;
const SERIES: readonly SeriesName[] = ['inferenceMs', 'roundTripMs', 'snapshotMs', 'resultAgeMs', 'sourceIntervalMs', 'drawSubmitMs'];

interface RunResult {
  durationS: number;
  counters: Record<string, number>;
  acceptedPerSecond: number;
  admittedPerSecond: number;
  sourceFps: number;
  handCounts: Record<string, number>;
  summaries: Record<string, Summary>;
  raw: Record<string, number[]>;
  jsHeapMiB: number | null;
}

async function startCamera(page: Page, backend: 'gpu' | 'cpu'): Promise<void> {
  await page.goto(`./?hud=0&backend=${backend}`);
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air?.session.state.kind), { timeout: 90_000 }).toBe('ready');
}

async function heapMiB(page: Page): Promise<number | null> {
  try {
    const session = await page.context().newCDPSession(page);
    const { metrics } = await session.send('Performance.getMetrics');
    const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
    await session.detach();
    return used === undefined ? null : Math.round((used / 1024 ** 2) * 10) / 10;
  } catch {
    return null;
  }
}

async function measure(page: Page, seconds: number): Promise<RunResult> {
  await page.evaluate(() => {
    window.__air!.metrics!.reset();
    (window as unknown as { __handCounts: Record<string, number> }).__handCounts = {};
    const app = window.__air!;
    const tick = (): void => {
      const counts = (window as unknown as { __handCounts: Record<string, number> }).__handCounts;
      const key = String(app.lastHands.length);
      counts[key] = (counts[key] ?? 0) + 1;
    };
    (window as unknown as { __handTimer: number }).__handTimer = window.setInterval(tick, 100);
  });
  await page.waitForTimeout(seconds * 1000);
  const data = await page.evaluate((series) => {
    clearInterval((window as unknown as { __handTimer: number }).__handTimer);
    const m = window.__air!.metrics!;
    const raw: Record<string, number[]> = {};
    for (const name of series) raw[name] = Array.from(m.values(name));
    return { raw, counters: m.snapshot().counters, handCounts: (window as unknown as { __handCounts: Record<string, number> }).__handCounts };
  }, SERIES);
  const summaries: Record<string, Summary> = {};
  for (const [name, values] of Object.entries(data.raw)) summaries[name] = summarize(values);
  const c = data.counters;
  return {
    durationS: seconds,
    counters: c,
    acceptedPerSecond: (c.accepted ?? 0) / seconds,
    admittedPerSecond: (c.admitted ?? 0) / seconds,
    sourceFps: (c.sourceFrames ?? 0) / seconds,
    handCounts: data.handCounts,
    summaries,
    raw: Object.fromEntries(Object.entries(data.raw).map(([k, v]) => [k, round(v)])),
    jsHeapMiB: await heapMiB(page),
  };
}

function pooled(runs: RunResult[], name: string): Summary {
  return summarize(runs.flatMap((r) => r.raw[name] ?? []));
}

test('GPU vs CPU worker inference on this machine', async ({ browser, page }) => {
  test.setTimeout(30 * 60_000);
  const environment = await describeEnvironment(browser, page);
  const results: Record<string, unknown> = { environment, protocol: { RUNS, RUN_SECONDS, WARMUP_SECONDS } };
  for (const backend of ['gpu', 'cpu'] as const) {
    const context = await browser.newContext();
    const p = await context.newPage();
    await startCamera(p, backend);
    const details = await p.evaluate(() => window.__air!.session.details);
    await p.waitForTimeout(WARMUP_SECONDS * 1000);
    const runs: RunResult[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await measure(p, RUN_SECONDS));
    results[backend] = {
      selectedBackend: details.backend,
      fallbackReason: details.fallbackReason,
      coldStart: {
        initTimings: details.initTimings,
        startToReadyMs: details.startToReadyMs,
        permissionToReadyMs: details.permissionToReadyMs,
        readyToFirstResultMs: details.readyToFirstResultMs,
      },
      pooled: Object.fromEntries(SERIES.map((s) => [s, pooled(runs, s)])),
      runs: runs.map(({ raw: _raw, ...rest }) => rest),
      raw: runs.map((r) => r.raw),
    };
    await context.close();
  }

  // Shader/program caches persist in a real profile: measure a second GPU
  // start in the same persistent profile.
  const profile = mkdtempSync(join(tmpdir(), 'aw-profile-'));
  const warmStarts: unknown[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const ctx = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-video-capture=${join(process.cwd(), 'tests/.cache/fake-camera.mjpeg')}`,
          '--enable-gpu',
          '--ignore-gpu-blocklist',
        ],
        baseURL: test.info().project.use.baseURL ?? BENCH_URL,
        viewport: { width: 1280, height: 800 },
      });
      const p = ctx.pages()[0] ?? (await ctx.newPage());
      await startCamera(p, 'gpu');
      const d = await p.evaluate(() => window.__air!.session.details);
      warmStarts.push({ launch: i + 1, initTimings: d.initTimings, startToReadyMs: d.startToReadyMs, backend: d.backend });
      await ctx.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  results.gpuPersistentProfileStarts = warmStarts;
  writeJson('bench-results/m0-backend.json', results);
  console.log(JSON.stringify({ gpu: (results.gpu as { pooled: unknown }).pooled, cpu: (results.cpu as { pooled: unknown }).pooled, warmStarts }, null, 1));
});
