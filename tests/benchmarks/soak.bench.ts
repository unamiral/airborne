/**
 * Soak test (plan §12: 15-minute thermal/soak run). GPU-backed Chromium
 * new-headless with the fake camera; a pointer stroke every 20 s (undone
 * every other time) keeps rendering active. Per-minute inference, result
 * age, frame work, throughput, and JS heap go to bench-results/m5-soak.json.
 * Synthetic camera input; device temperature is not observable here.
 */
import { expect, test } from '@playwright/test';
import { summarize } from '../../src/app/metrics';
import type {} from '../../src/dev/devtools';
import { describeEnvironment, writeJson } from './environment';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 15);

test('soak', async ({ browser, page }) => {
  test.setTimeout((MINUTES + 3) * 60_000);
  const environment = await describeEnvironment(browser, page);
  await page.goto('./?hud=0&recorder=0');
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 90_000 }).toBe('ready');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const box = (await page.locator('canvas.board').boundingBox())!;
  const minutes: unknown[] = [];
  for (let m = 0; m < MINUTES; m++) {
    await page.evaluate(() => window.__air!.metrics!.reset());
    for (let k = 0; k < 3; k++) {
      await page.waitForTimeout(17_000);
      const y = box.y + 100 + ((m * 3 + k) % 10) * 40;
      await page.mouse.move(box.x + 100, y);
      await page.mouse.down();
      for (let i = 0; i < 60; i++) await page.mouse.move(box.x + 100 + i * 8, y + Math.sin(i / 5) * 15);
      await page.mouse.up();
      if ((m * 3 + k) % 2 === 1) await page.keyboard.press('Control+z');
    }
    const data = await page.evaluate(() => {
      const air = window.__air!;
      const mm = air.metrics!;
      return {
        inference: Array.from(mm.values('inferenceMs')),
        age: Array.from(mm.values('resultAgeMs')),
        frame: Array.from(mm.values('frameWorkMs')),
        accepted: mm.counter('accepted'),
        state: air.session.state.kind,
        backend: air.session.details.backend,
        board: air.controller.stats,
      };
    });
    const { metrics } = await cdp.send('Performance.getMetrics');
    const heap = metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? null;
    const row = {
      minute: m + 1,
      state: data.state,
      backend: data.backend,
      acceptedPerSecond: data.accepted / 60,
      inference: summarize(data.inference),
      resultAge: summarize(data.age),
      frameWork: summarize(data.frame),
      heapMiB: heap === null ? null : Math.round((heap / 1048576) * 10) / 10,
      board: data.board,
    };
    minutes.push(row);
    console.log(JSON.stringify({ minute: row.minute, acc: row.acceptedPerSecond.toFixed(1), inf95: row.inference.p95.toFixed(1), heap: row.heapMiB }));
    writeJson('bench-results/m5-soak.json', { environment, minutes });
  }
});
