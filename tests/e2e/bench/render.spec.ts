/**
 * Renderer, cache, and navigation checks in a real browser (F15, F16, F29).
 * The core invariant: after any sequence of edits and view changes, the
 * cached composition equals a fresh uncached render (within anti-aliasing:
 * pixels differing by more than 96/255 in any channel count as mismatched).
 */
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../../src/dev/devtools';
import { hover, writeMove, scenario } from '../../support/scenarios';
import { drawWithMouse } from '../support';

async function open(page: Page): Promise<void> {
  await page.goto('./?hud=0');
  await page.getByRole('button', { name: 'Use mouse' }).click();
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__air!.renderer.stats.rebuilding)).toBe(false);
}

async function expectMatchesReference(page: Page, label: string): Promise<void> {
  await settled(page);
  const r = await page.evaluate(() => window.__air!.compareWithReference());
  expect(r.mismatched, `${label}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(Math.max(30, r.ink * 0.01));
}

test('cached ink matches a fresh render after draw, undo, redo, erase, and clear/undo (F29)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[100, 100], [300, 180], [500, 120], [650, 300]]);
  await drawWithMouse(page, [[120, 400], [420, 380], [460, 520]]);
  await drawWithMouse(page, [[700, 200], [710, 202]]);
  await expectMatchesReference(page, 'after drawing');
  await page.keyboard.press('Control+z');
  await expectMatchesReference(page, 'after undo');
  await page.keyboard.press('Control+Shift+z');
  await expectMatchesReference(page, 'after redo');
  await page.evaluate(() => {
    const c = window.__air!.controller;
    c.setTool('eraser');
  });
  await drawWithMouse(page, [[290, 60], [310, 260]]);
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(2);
  await expectMatchesReference(page, 'after erase');
  await page.evaluate(() => window.__air!.controller.clear());
  await expectMatchesReference(page, 'after clear');
  await page.keyboard.press('Control+z');
  await expectMatchesReference(page, 'after undo clear');
});

test('pans beyond the viewport, draws there, and shows old content when returning (F16)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[200, 200], [400, 260]]);
  const board = page.locator('canvas.board');
  await board.focus();
  await page.keyboard.down(' ');
  await drawWithMouse(page, [[900, 600], [100, 100]]); // Space-drag pans by (-800, -500)
  await page.keyboard.up(' ');
  const view = await page.evaluate(() => window.__air!.controller.view);
  expect(view.tx).toBeCloseTo(-800, 0);
  await drawWithMouse(page, [[300, 300], [500, 360]]);
  await expectMatchesReference(page, 'far away');
  await page.evaluate(() => window.__air!.controller.resetView());
  await expectMatchesReference(page, 'back home');
  const strokes = await page.evaluate(() => window.__air!.controller.stats.strokes);
  expect(strokes).toBe(2);
});

test('wheel zoom anchors at the pointer, clamps scale, and settles crisp (F15, F16)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[300, 300], [500, 300], [500, 450]]);
  const box = (await page.locator('canvas.board').boundingBox())!;
  await page.mouse.move(box.x + 400, box.y + 300);
  const before = await page.evaluate(() => {
    const v = window.__air!.controller.view;
    return { x: (400 - v.tx) / v.scale, y: (300 - v.ty) / v.scale };
  });
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
  const after = await page.evaluate(() => window.__air!.controller.view);
  expect(after.scale).toBeGreaterThan(2);
  // The world point under the pointer stays under the pointer.
  expect(before.x * after.scale + after.tx).toBeCloseTo(400, 1);
  expect(before.y * after.scale + after.ty).toBeCloseTo(300, 1);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400);
  expect(await page.evaluate(() => window.__air!.controller.view.scale)).toBe(10);
  for (let i = 0; i < 80; i++) await page.mouse.wheel(0, 400);
  expect(await page.evaluate(() => window.__air!.controller.view.scale)).toBeCloseTo(0.1, 9);
  await expectMatchesReference(page, 'zoomed out');
});

test('fit and reset work on empty and populated boards (F16)', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__air!.controller.fit(1000, 700));
  expect(await page.evaluate(() => window.__air!.controller.view)).toEqual({ scale: 1, tx: 0, ty: 0 });
  await drawWithMouse(page, [[100, 100], [140, 120]]);
  await page.evaluate(() => {
    const c = window.__air!.controller;
    c.setView({ scale: 0.3, tx: 900, ty: -400 });
    const { cssWidth, cssHeight } = window.__air!.renderer.stats;
    c.fit(cssWidth, cssHeight);
  });
  const v = await page.evaluate(() => window.__air!.controller.view);
  expect(v.scale).toBe(1); // fit never enlarges beyond 100%
  await expectMatchesReference(page, 'fitted');
});

test('resize at zoom and DPR 2 keep the cache consistent (F29)', async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();
  await open(page);
  expect(await page.evaluate(() => window.__air!.renderer.stats.rasterScale)).toBe(2);
  await drawWithMouse(page, [[100, 100], [400, 300], [600, 120]]);
  await page.evaluate(() => window.__air!.controller.zoom({ x: 300, y: 200 } as never, 2.5));
  await page.setViewportSize({ width: 800, height: 600 });
  await expectMatchesReference(page, 'after resize at zoom');
  await context.close();
});

test('frame cost does not grow with stroke length (F29)', async ({ page }) => {
  await open(page);
  const box = (await page.locator('canvas.board').boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  const sample = async (from: number, count: number): Promise<number[]> => {
    await page.evaluate(() => window.__air!.metrics!.reset());
    for (let i = from; i < from + count; i++) {
      const x = 50 + (i % 900);
      const y = 50 + Math.floor(i / 900) * 40 + Math.sin(i / 10) * 12;
      await page.mouse.move(box.x + x, box.y + y);
    }
    return page.evaluate(() => Array.from(window.__air!.metrics!.values('renderMs')));
  };
  const early = await sample(0, 300);
  await sample(300, 2400); // grow the stroke
  const late = await sample(2700, 300);
  await page.mouse.up();
  const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.95)] ?? 0;
  const points = await page.evaluate(() => window.__air!.controller.stats.points);
  test.info().annotations.push({ type: 'renderMs', description: JSON.stringify({ earlyP95: p95(early), lateP95: p95(late), points }) });
  console.log('render p95 early', p95(early), 'late', p95(late), 'points', points);
  expect(points).toBeGreaterThan(2000);
  expect(p95(late)).toBeLessThan(Math.max(2, p95(early) * 2.5));
});

test('large rebuilds are chunked and never show a blank frame (F29, normal workload)', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__air!.loadSyntheticBoard(500, 200, 7));
  await settled(page);
  const stats = await page.evaluate(() => window.__air!.controller.stats);
  expect(stats.points).toBeGreaterThanOrEqual(99_000);
  await page.evaluate(() => window.__air!.metrics!.reset());
  const blankFrames = await page.evaluate(async () => {
    const air = window.__air!;
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.board')!;
    const probe = new OffscreenCanvas(64, 40);
    const pctx = probe.getContext('2d', { willReadFrequently: true })!;
    air.controller.zoom({ x: 400, y: 300 } as never, 1.7);
    let blank = 0;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      pctx.drawImage(canvas, 0, 0, 64, 40);
      const d = pctx.getImageData(0, 0, 64, 40).data;
      let ink = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k]! < 200) ink++;
      if (ink === 0) blank++;
    }
    return blank;
  });
  expect(blankFrames).toBe(0);
  await settled(page);
  const chunks = await page.evaluate(() => window.__air!.metrics!.summary('rebuildChunkMs'));
  test.info().annotations.push({ type: 'rebuildChunkMs', description: JSON.stringify(chunks) });
  console.log('rebuild chunks', JSON.stringify(chunks));
  expect(chunks.count).toBeGreaterThan(1);
  await expectMatchesReference(page, 'after chunked rebuild');
});

test('two-hand zoom replay: smooth scale, no phantom strokes, consistent cache (F14, F15)', async ({ page }) => {
  await open(page);
  const record = scenario('zoom anchor', [
    { phases: [hover(300, 500, 360), writeMove(600, 500, 360, 430, 330), hover(200, 430, 330)] },
    { phases: [hover(300, 800, 360), writeMove(600, 800, 360, 900, 410), hover(200, 900, 410)], handedness: 'Left' },
  ], { strokes: 0 });
  const result = await page.evaluate(async (r) => {
    const air = window.__air!;
    const views: Array<{ scale: number; tx: number; ty: number }> = [];
    const off = air.controller.onChange((k) => {
      if (k === 'view') views.push(air.controller.view);
    });
    await air.replay(r, Number.POSITIVE_INFINITY);
    off();
    return { views, strokes: air.controller.stats.strokes };
  }, JSON.parse(JSON.stringify(record)) as unknown);
  expect(result.strokes).toBe(0);
  expect(result.views.length).toBeGreaterThan(5);
  // Scale changes smoothly (no jump on exit): consecutive scale ratios stay small.
  for (let i = 1; i < result.views.length; i++) {
    expect(Math.abs(result.views[i]!.scale / result.views[i - 1]!.scale - 1)).toBeLessThan(0.2);
  }
  await expectMatchesReference(page, 'after two-hand zoom');
});
