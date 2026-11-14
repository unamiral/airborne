import { expect, test } from '@playwright/test';
import type {} from '../../../src/dev/devtools';
import { hover, pinchMove, scenario } from '../../support/scenarios';
import { inkPixels } from '../support';

// Synthetic landmark replay through the live browser path (pipeline, reducer,
// controller, renderer). Not a camera or detector test.

const record = scenario(
  'browser two strokes',
  [
    {
      phases: [
        hover(300, 420, 300),
        pinchMove(700, 420, 300, 760, 360),
        hover(300, 760, 420),
        pinchMove(500, 760, 420, 940, 420),
        hover(300, 940, 420),
      ],
    },
  ],
  { strokes: 2 },
  { noisePx: 0.3 },
);

test('replayed hand input draws strokes and records draw-submission timing (F09, F32)', async ({ page }) => {
  await page.goto('./?hud=0');
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await page.evaluate((r) => window.__air!.replay(r, 1), JSON.parse(JSON.stringify(record)) as unknown);
  await expect.poll(() => page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(2);
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(300);
  const submits = await page.evaluate(() => window.__air!.metrics!.summary('drawSubmitMs').count);
  expect(submits).toBeGreaterThan(10);
});

test('playback speed does not change the committed board (F32)', async ({ page }) => {
  await page.goto('./?hud=0');
  await page.getByRole('button', { name: 'Use mouse' }).click();
  const json = JSON.parse(JSON.stringify(record)) as unknown;
  await page.evaluate((r) => window.__air!.replay(r, 1), json);
  const realtime = await page.evaluate(() => window.__air!.boardDump());
  await page.reload();
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await page.evaluate((r) => window.__air!.replay(r, Number.POSITIVE_INFINITY), json);
  const fast = await page.evaluate(() => window.__air!.boardDump());
  await page.reload();
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await page.evaluate((r) => window.__air!.replay(r, 0.5), json);
  const slow = await page.evaluate(() => window.__air!.boardDump());
  expect(realtime.length).toBe(2);
  expect(fast).toEqual(realtime);
  expect(slow).toEqual(realtime);
});
