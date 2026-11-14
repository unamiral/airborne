/**
 * Camera selection (F03) with two Chromium fake devices (generated pattern
 * video, not the photo file). Skipped when Chromium exposes fewer devices.
 */
import { expect, test } from '@playwright/test';
import { enterBoard } from '../support';
import type {} from '../../../src/dev/devtools';

test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=2'] },
});

test('switching cameras keeps the tracker, starts a new epoch, and keeps the board', async ({ page }) => {
  await page.goto('./?hud=0&backend=cpu&recorder=0');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Use mouse' }).click();
  const box = (await page.locator('canvas.board').boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 160, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 60_000 }).toBe('ready');
  await page.getByRole('button', { name: 'Settings' }).click();
  const select = page.getByRole('combobox', { name: 'Camera' });
  await expect(select).toBeEnabled();
  const options = await select.locator('option').count();
  test.skip(options < 2, 'Chromium exposed fewer than two fake cameras');
  const before = await page.evaluate(() => ({ epoch: window.__air!.session.details.epoch, device: window.__air!.session.details.camera?.deviceId }));
  const other = await select.locator('option').evaluateAll((opts, current) => (opts as HTMLOptionElement[]).map((o) => o.value).find((v) => v !== current), before.device);
  await select.selectOption(other!);
  await expect.poll(() => page.evaluate(() => window.__air!.session.details.camera?.deviceId)).toBe(other);
  await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 30_000 }).toBe('ready');
  const after = await page.evaluate(() => window.__air!.session.details.epoch);
  expect(after).toBeGreaterThan(before.epoch);
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(1);
  await page.keyboard.press('Escape');
});
