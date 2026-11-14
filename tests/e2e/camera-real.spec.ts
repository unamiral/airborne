import { expect, test } from '@playwright/test';
import { enterBoard, instrument, probe } from './support';

// F03/F04/F35 (partial): the production build under a subpath with CSP loads
// the real model in the real module worker and tracks hands from Chromium's
// fake camera (MediaPipe test photos). Synthetic video, not a real camera.

test('real model tracks hands in the production worker, and Stop releases the camera', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await instrument(page);
  await page.goto('./');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect(page.getByRole('status')).toContainText('Tracking on this device', { timeout: 60_000 });
  const p1 = await probe(page);
  expect(p1.liveTracks).toBe(1);
  expect(p1.cspViolations).toEqual([]);
  // Every runtime asset came from this origin and subpath.
  const origin = new URL(page.url()).origin;
  expect(requests.some((u) => u.endsWith('hand_landmarker.task'))).toBe(true);
  expect(requests.some((u) => u.endsWith('vision_wasm_module_internal.wasm'))).toBe(true);
  for (const url of requests) expect(new URL(url).origin).toBe(origin);

  await page.getByRole('button', { name: 'Stop camera' }).click();
  await expect(page.getByRole('status')).toContainText('Camera off');
  const p2 = await probe(page);
  expect(p2.liveTracks).toBe(0);
});
