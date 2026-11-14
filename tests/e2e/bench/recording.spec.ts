/**
 * Developer landmark recording (F32) with Chromium's fake camera: visible
 * indicator, bounded duration, discard, export, schema validity, and
 * deterministic replay of an exported recording.
 */
import { expect, test } from '@playwright/test';
import { enterBoard } from '../support';
import { readFileSync } from 'node:fs';
import type {} from '../../../src/dev/devtools';
import { parseReplay } from '../../../src/dev/replay-format';

test('records landmarks only, exports a valid replay, and replays deterministically', async ({ page }) => {
  await page.goto('./?hud=0&backend=cpu');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 60_000 }).toBe('ready');
  const recorder = page.getByRole('region', { name: 'Developer landmark recorder' });
  await recorder.getByRole('button', { name: 'Record landmarks' }).click();
  await expect(recorder).toHaveAttribute('data-recording', 'true');
  await expect(recorder.getByText(/● Recording \d+ s/)).toBeVisible();
  await page.waitForTimeout(1500);
  await recorder.getByRole('button', { name: 'Stop recording' }).click();
  await expect(recorder).toHaveAttribute('data-recording', 'false');
  const downloadPromise = page.waitForEvent('download');
  await recorder.getByRole('button', { name: 'Export recording' }).click();
  const json: unknown = JSON.parse(readFileSync(await (await downloadPromise).path(), 'utf8'));
  const parsed = parseReplay(json);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.record.source).toBe('recorded');
  expect(parsed.record.frames.length).toBeGreaterThan(20);
  expect(parsed.record.frames.some((f) => f.hands.length > 0)).toBe(true);
  expect(JSON.stringify(json)).not.toMatch(/data:image|video/);
  // Discard clears the buffer.
  await recorder.getByRole('button', { name: 'Discard' }).click();
  expect(await page.evaluate(() => window.__air!.recorder.frameCount)).toBe(0);
  // The recording replays to the same board twice.
  const run = async () => {
    await page.evaluate((r) => window.__air!.replay(r, Number.POSITIVE_INFINITY), json);
    return page.evaluate(() => ({ dump: window.__air!.boardDump(), view: window.__air!.controller.view }));
  };
  const a = await run();
  await page.evaluate(() => {
    window.__air!.controller.closeTransientWork();
  });
  const b = await run();
  expect(b.view).toEqual(a.view);
});

test('recording stops itself at the duration limit', async ({ page }) => {
  await page.goto('./?hud=0&backend=cpu&recordMaxMs=600');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 60_000 }).toBe('ready');
  const recorder = page.getByRole('region', { name: 'Developer landmark recorder' });
  await recorder.getByRole('button', { name: 'Record landmarks' }).click();
  await expect(recorder.getByText(/Stopped \(duration limit reached\)/)).toBeVisible({ timeout: 5000 });
  expect(await page.evaluate(() => window.__air!.recorder.recording)).toBe(false);
});
