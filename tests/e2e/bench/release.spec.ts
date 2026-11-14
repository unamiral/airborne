/**
 * Release validation in the bench build with Chromium's fake camera:
 * HUD (F33), offline operation (F31), start/stop resource cycles (F03, F34),
 * and an automated demo run (F36). Synthetic camera and synthetic hands.
 */
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../../src/dev/devtools';
import { POSES } from '../../support/hands';
import { hover, move, pinchAt, pinchMove, scenario, type HandScript, type Phase } from '../../support/scenarios';

const ready = (page: Page) =>
  expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 60_000 }).toBe('ready');

test('the HUD labels software timings, updates at most 4 Hz, and can be hidden (F33)', async ({ page }) => {
  await page.goto('./?backend=cpu&recorder=0');
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await ready(page);
  const hud = page.locator('.hud');
  await expect(hud).toContainText('software pipeline (not frame-to-pixel)');
  const changes = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const el = document.querySelector('.hud')!;
        let n = 0;
        const obs = new MutationObserver(() => n++);
        obs.observe(el, { childList: true, characterData: true, subtree: true });
        setTimeout(() => {
          obs.disconnect();
          resolve(n);
        }, 2000);
      }),
  );
  expect(changes).toBeLessThanOrEqual(9);
  const counts = await page.evaluate(() => {
    const m = window.__air!.metrics!;
    return { source: m.counter('sourceFrames'), admitted: m.counter('admitted'), accepted: m.counter('accepted'), stale: m.counter('staleResults') };
  });
  expect(counts.source).toBeGreaterThanOrEqual(counts.admitted);
  expect(counts.admitted).toBeGreaterThanOrEqual(counts.accepted + counts.stale);
  await page.goto('./?hud=0&recorder=0');
  await expect(page.locator('.hud')).toHaveCount(0);
});

test('tracking keeps working offline once assets are loaded (F31)', async ({ page, context }) => {
  await page.goto('./?hud=0&backend=cpu&recorder=0');
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await ready(page);
  await context.setOffline(true);
  const before = await page.evaluate(() => window.__air!.metrics!.counter('accepted'));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__air!.metrics!.counter('accepted'));
  expect(after - before).toBeGreaterThan(10);
  await context.setOffline(false);
});

test('twenty camera start/stop cycles leave no workers, live tracks, or heap growth (F03, F34)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    (window as unknown as { __streams: MediaStream[] }).__streams = streams;
    const md = navigator.mediaDevices;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await original(c);
      streams.push(s);
      return s;
    };
  });
  await page.goto('./?hud=0&backend=cpu&recorder=0');
  const cdp = await page.context().newCDPSession(page);
  const heap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
  };
  await cdp.send('Performance.enable');
  const heaps: number[] = [];
  for (let i = 0; i < 20; i++) {
    await page.getByRole('button', { name: 'Start camera' }).first().click();
    await ready(page);
    await page.getByRole('button', { name: 'Stop camera' }).click();
    await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind)).toBe('idle');
    await expect.poll(() => page.workers().length).toBe(0);
    if (i === 1 || i === 19) heaps.push(await heap());
  }
  const live = await page.evaluate(() =>
    (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length,
  );
  const streams = await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length);
  test.info().annotations.push({ type: 'heap', description: JSON.stringify({ afterCycle2: heaps[0], afterCycle20: heaps[1] }) });
  console.log('heap after cycle 2 / 20 (bytes):', heaps[0], heaps[1]);
  expect(streams).toBe(20);
  expect(live).toBe(0);
  expect(heaps[1]! - heaps[0]!).toBeLessThan(5 * 1024 * 1024);
});

test('automated demo: write, recolor, zoom, erase, undo, and export (F36)', async ({ page }) => {
  await page.goto('./?hud=0&recorder=0');
  await page.getByRole('button', { name: 'Use mouse' }).click();
  const surface = await page.evaluate(() => {
    const l = window.__air!.layout();
    return { width: l.width, height: l.height, stripWidth: l.board.x };
  });
  const centre = (sel: string) =>
    page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
  const play = async (hands: HandScript[]) => {
    const record = scenario('demo', hands, {}, { surface, noisePx: 0.3 });
    await page.evaluate((r) => window.__air!.replay(r, Number.POSITIVE_INFINITY), JSON.parse(JSON.stringify(record)) as unknown);
  };
  const stroke = (x0: number, y0: number, x1: number, y1: number): Phase[] => [hover(250, x0, y0), pinchMove(450, x0, y0, x1, y1), hover(200, x1, y1)];
  // "1 + 1" in black.
  await play([{ phases: [...stroke(420, 260, 420, 360), ...stroke(480, 310, 540, 310), ...stroke(510, 280, 510, 340), ...stroke(600, 260, 600, 360)] }]);
  // Pick red by hand, then "= 2" pieces in red.
  const red = await centre('[data-hand-target="color-red"]');
  await play([{ phases: [hover(300, red.x, red.y), pinchAt(250, red.x, red.y), hover(250, red.x, red.y)] }]);
  await play([{ phases: [...stroke(660, 295, 720, 295), ...stroke(660, 325, 720, 325), ...stroke(760, 270, 820, 350)] }]);
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(7);
  // Two-hand zoom.
  await play([
    { phases: [hover(300, 560, 500), pinchMove(600, 560, 500, 500, 500), hover(250, 500, 500)] },
    { phases: [hover(300, 760, 500), pinchMove(600, 760, 500, 840, 500), hover(250, 840, 500)], handedness: 'Left' },
  ]);
  const scale = await page.evaluate(() => window.__air!.controller.view.scale);
  expect(scale).toBeGreaterThan(1.2);
  // Fist-erase the "2" (last stroke), then undo the erase by hand.
  const two = await page.evaluate(() => {
    const c = window.__air!.controller;
    const s = c.doc.strokes[c.doc.strokes.length - 1]!;
    const v = c.view;
    const board = window.__air!.layout().board;
    const mid = Math.floor(s.points.length / 2);
    return { x: s.points.x(mid) * v.scale + v.tx + board.x, y: s.points.y(mid) * v.scale + v.ty + board.y };
  });
  await play([{ phases: [hover(300, two.x - 60, two.y), { ms: 700, pose: POSES.fist, path: move(two.x - 60, two.y, two.x + 30, two.y) }, hover(300, two.x + 30, two.y - 80)] }]);
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(6);
  const undo = await centre('[data-hand-target="undo"]');
  await play([{ phases: [hover(300, undo.x, undo.y), pinchAt(250, undo.x, undo.y), hover(250, undo.x, undo.y)] }]);
  const final = await page.evaluate(() => {
    const c = window.__air!.controller;
    return { strokes: c.stats.strokes, red: c.doc.strokes.filter((s) => s.color === '#c5221f').length, undoDepth: c.history.undoDepth };
  });
  expect(final).toEqual({ strokes: 7, red: 3, undoDepth: 7 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});
