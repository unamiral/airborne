import { expect, test } from '@playwright/test';
import { instrument, probe } from './support';

// F02: every failure class gets its own explanation and a working
// retry/fallback. getUserMedia is replaced via an init script (a controlled
// browser API mock, distinct from the real-camera suite).

const cases = [
  { mode: 'deny', text: 'Camera permission was denied' },
  { mode: 'notfound', text: 'No camera found' },
  { mode: 'busy', text: 'Camera is in use' },
  { mode: 'insecure', text: 'Camera needs a secure page' },
] as const;

for (const { mode, text } of cases) {
  test(`explains ${mode} and keeps mouse drawing available`, async ({ page }) => {
    await instrument(page, mode);
    await page.goto('./');
    await page.getByRole('button', { name: 'Start camera' }).first().click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(text);
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    await alert.getByRole('button', { name: 'Use mouse' }).click();
    await expect(alert).toBeHidden();
    // Insecure contexts are detected without calling getUserMedia.
    const p = await probe(page);
    expect(p.gumCalls).toBe(mode === 'insecure' ? 0 : 1);
  });
}

test('a pending permission prompt can be cancelled; double-clicking Start asks once', async ({ page }) => {
  await instrument(page, 'pending');
  await page.goto('./');
  const start = page.getByRole('button', { name: 'Start camera' }).first();
  await start.dblclick();
  await expect(page.getByRole('status')).toContainText('Waiting for camera permission');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status')).toContainText('Camera off');
  expect((await probe(page)).gumCalls).toBe(1);
});

test('retry after denial succeeds once permission is granted', async ({ page }) => {
  await instrument(page, 'deny');
  await page.goto('./');
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect(page.getByRole('alert')).toContainText('denied');
  // Grant: restore the real getUserMedia (fake device) and retry.
  await page.evaluate(() => {
    const md = navigator.mediaDevices;
    const proto = Object.getPrototypeOf(md) as MediaDevices;
    md.getUserMedia = proto.getUserMedia.bind(md);
  });
  await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('status')).toContainText(/Tracking on this device|Looking for a hand|Starting hand tracking|Loading/, {
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Stop camera' }).click();
});
