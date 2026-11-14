/**
 * Pointer fallback details (F24 subset) and normal-workload responsiveness
 * (plan §12) in the bench build. Headless Chromium on the dev machine: the
 * numbers are indicative, not hardware gates.
 */
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../../src/dev/devtools';
import { enterBoard, drawWithMouse } from '../support';

async function open(page: Page): Promise<void> {
  await page.goto('./?hud=0');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Use mouse' }).click();
}

const strokes = (page: Page) => page.evaluate(() => window.__air!.controller.stats.strokes);

test('releasing outside the board still commits the stroke (pointer capture)', async ({ page }) => {
  await open(page);
  const box = (await page.locator('canvas.board').boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 220, { steps: 5 });
  await page.mouse.move(box.x - 60, box.y + 240, { steps: 5 }); // over the control strip
  await page.mouse.up();
  expect(await strokes(page)).toBe(1);
  expect(await page.evaluate(() => window.__air!.controller.active)).toBeNull();
});

test('pointercancel keeps the ink drawn so far; a second pointer is ignored', async ({ page }) => {
  await open(page);
  const box = (await page.locator('canvas.board').boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 260, { steps: 6 });
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas.board')!;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 99, isPrimary: false, button: 0, clientX: 50, clientY: 50, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, isPrimary: true, bubbles: true }));
  });
  await page.mouse.up();
  expect(await strokes(page)).toBe(1);
});

test('middle button and the move tool pan instead of drawing', async ({ page }) => {
  await open(page);
  const box = (await page.locator('canvas.board').boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + 350, box.y + 320, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  expect(await strokes(page)).toBe(0);
  expect(await page.evaluate(() => window.__air!.controller.view.tx)).toBeCloseTo(50, 0);
  await page.evaluate(() => window.__air!.controller.setTool('move'));
  await drawWithMouse(page, [[300, 300], [250, 250]]);
  expect(await strokes(page)).toBe(0);
  expect(await page.evaluate(() => window.__air!.controller.view.ty)).toBeCloseTo(-30, 0);
});

test('normal workload (500 strokes, 100k points) stays responsive while drawing and panning', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.evaluate(() => window.__air!.loadSyntheticBoard(500, 200, 3));
  await expect.poll(() => page.evaluate(() => window.__air!.renderer.stats.rebuilding)).toBe(false);
  const box = (await page.locator('canvas.board').boundingBox())!;

  // Drawing on top of a full board: steady rendering.
  await page.evaluate(() => window.__air!.metrics!.reset());
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  for (let i = 0; i < 300; i++) await page.mouse.move(box.x + 100 + i * 2, box.y + 100 + Math.sin(i / 8) * 30);
  await page.mouse.up();
  const drawing = await page.evaluate(() => ({
    render: window.__air!.metrics!.summary('renderMs'),
    frame: window.__air!.metrics!.summary('frameWorkMs'),
  }));

  // Continuous Space-drag pan: newly exposed areas render during the gesture.
  await page.evaluate(() => window.__air!.metrics!.reset());
  const rebuildsBefore = await page.evaluate(() => window.__air!.renderer.stats.fullRebuilds);
  await page.locator('canvas.board').focus();
  await page.keyboard.down(' ');
  await page.mouse.move(box.x + 600, box.y + 400);
  await page.mouse.down();
  for (let i = 0; i < 120; i++) {
    await page.mouse.move(box.x + 600 - i * 4, box.y + 400 - i * 2);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
  const rebuildsDuring = await page.evaluate(() => window.__air!.renderer.stats.fullRebuilds);
  await page.mouse.up();
  await page.keyboard.up(' ');
  const panning = await page.evaluate(() => ({
    render: window.__air!.metrics!.summary('renderMs'),
    chunks: window.__air!.metrics!.summary('rebuildChunkMs'),
  }));
  const result = { drawing, panning, progressiveRebuilds: rebuildsDuring - rebuildsBefore };
  test.info().annotations.push({ type: 'workload', description: JSON.stringify(result) });
  console.log('workload', JSON.stringify(result));
  expect(rebuildsDuring - rebuildsBefore).toBeGreaterThan(3);
  expect(drawing.render.p95).toBeLessThan(4);
});
