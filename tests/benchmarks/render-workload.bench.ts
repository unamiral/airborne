/**
 * Normal-workload rendering benchmark (plan §12: steady rendering p95 ≤ 4 ms,
 * rebuild chunks ≤ 4 ms, app work per active frame p95 ≤ 8 ms) on the real
 * GPU-backed canvas (new headless, ANGLE Metal). Writes bench-results/m2-render.json.
 */
import { expect, test } from '@playwright/test';
import type {} from '../../src/dev/devtools';
import { describeEnvironment, writeJson } from './environment';

test('render workload: 500 strokes / 100k points', async ({ browser, page }) => {
  test.setTimeout(300_000);
  const environment = await describeEnvironment(browser, page);
  await page.goto('./?hud=0');
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await page.evaluate(() => window.__air!.loadSyntheticBoard(500, 200, 3));
  await expect.poll(() => page.evaluate(() => window.__air!.renderer.stats.rebuilding)).toBe(false);
  const box = (await page.locator('canvas.board').boundingBox())!;
  const runs: unknown[] = [];
  for (let run = 0; run < 3; run++) {
    await page.evaluate(() => window.__air!.metrics!.reset());
    await page.mouse.move(box.x + 100, box.y + 100 + run * 40);
    await page.mouse.down();
    for (let i = 0; i < 400; i++) {
      await page.mouse.move(box.x + 100 + i * 2, box.y + 100 + run * 40 + Math.sin(i / 8) * 30);
    }
    await page.mouse.up();
    const drawing = await page.evaluate(() => ({ render: window.__air!.metrics!.summary('renderMs'), raf: window.__air!.metrics!.summary('rafIntervalMs') }));
    await page.evaluate(() => window.__air!.metrics!.reset());
    await page.locator('canvas.board').focus();
    await page.keyboard.down(' ');
    await page.mouse.move(box.x + 600, box.y + 400);
    await page.mouse.down();
    for (let i = 0; i < 150; i++) {
      await page.mouse.move(box.x + 600 - i * 3, box.y + 400 - i * 1.5);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
    await page.mouse.up();
    await page.keyboard.up(' ');
    const panning = await page.evaluate(() => ({ render: window.__air!.metrics!.summary('renderMs'), chunks: window.__air!.metrics!.summary('rebuildChunkMs') }));
    await page.evaluate(() => window.__air!.metrics!.reset());
    await page.mouse.move(box.x + 500, box.y + 350);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i < 10 ? -120 : 120);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
    await expect.poll(() => page.evaluate(() => window.__air!.renderer.stats.rebuilding)).toBe(false);
    const zooming = await page.evaluate(() => ({ render: window.__air!.metrics!.summary('renderMs'), chunks: window.__air!.metrics!.summary('rebuildChunkMs') }));
    runs.push({ drawing, panning, zooming });
  }
  const stats = await page.evaluate(() => ({ board: window.__air!.controller.stats, renderer: window.__air!.renderer.stats }));
  writeJson('bench-results/m2-render.json', { environment, stats, runs });
  console.log(JSON.stringify(runs, null, 0));
});
