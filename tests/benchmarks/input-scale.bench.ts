/**
 * M0 experiment: does downscaling the admitted frame reduce inference time?
 * Short runs (1 x 30 s per cell); exploratory, not a release gate.
 */
import { expect, test, type Page } from '@playwright/test';
import { summarize } from '../../src/app/metrics';
import type {} from '../../src/dev/devtools';
import { describeEnvironment, writeJson } from './environment';

async function run(page: Page, backend: string, scale: number) {
  await page.goto(`./?hud=0&backend=${backend}&inputScale=${scale}`);
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air?.session.state.kind), { timeout: 90_000 }).toBe('ready');
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.__air!.metrics!.reset());
  await page.waitForTimeout(30_000);
  return page.evaluate(() => {
    const m = window.__air!.metrics!;
    return { inference: Array.from(m.values('inferenceMs')), counters: m.snapshot().counters };
  });
}

test('input scale experiment', async ({ browser, page }) => {
  test.setTimeout(20 * 60_000);
  const out: Record<string, unknown> = { environment: await describeEnvironment(browser, page) };
  for (const backend of ['gpu', 'cpu']) {
    for (const scale of (process.env.BENCH_SCALES ?? '1,0.5').split(',').map(Number)) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      const r = await run(p, backend, scale);
      const s = summarize(r.inference);
      out[`${backend}@${scale}`] = { inference: s, acceptedPerSecond: (r.counters.accepted ?? 0) / 30, counters: r.counters };
      console.log(backend, scale, `p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} accepted/s ${((r.counters.accepted ?? 0) / 30).toFixed(1)}`);
      await ctx.close();
    }
  }
  writeJson(process.env.BENCH_OUT ?? 'bench-results/m0-input-scale.json', out);
});
