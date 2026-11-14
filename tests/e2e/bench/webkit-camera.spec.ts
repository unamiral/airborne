import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import type {} from '../../../src/dev/devtools';

// WebKit's canvas MediaStream reproduces frozen mediaTime with an advancing
// presentedFrames counter. Run the real model through the live camera path.
test('continues tracking a hand when WebKit repeats camera media timestamps', async ({ page }) => {
  await page.route('**/test-hand.jpg', (route) => route.fulfill({
    contentType: 'image/jpeg',
    path: resolve('tests/fixtures/images/pointing_up.jpg'),
  }));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const image = new Image();
      image.src = '/test-hand.jpg';
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d')!;
      const draw = (): void => ctx.drawImage(image, 0, 0, 640, 480);
      draw();
      const timer = setInterval(draw, 33);
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0]!;
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
  });
  await page.goto('./?hud=0');
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air!.metrics!.counter('accepted')), {
    timeout: 60_000,
  }).toBeGreaterThan(60);
  await expect.poll(() => page.evaluate(() => window.__air!.hands.hands.length)).toBe(1);
  expect(await page.evaluate(() => window.__air!.hands.trackingLost)).toBe(false);
  await page.getByRole('button', { name: 'Stop camera' }).click();
});
