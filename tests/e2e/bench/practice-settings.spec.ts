/**
 * Practice on a separate board (F26), settings applied at idle boundaries
 * (F27), and preview toggling without inference loss (F28) in the bench build.
 */
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../../src/dev/devtools';
import { hover, writeMove, scenario } from '../../support/scenarios';
import { enterBoard, drawWithMouse } from '../support';

async function open(page: Page): Promise<void> {
  await page.goto('./?hud=0');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Use mouse' }).click();
}

test('practice runs on a separate board and returns to the untouched real board (F26)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[600, 500], [700, 520]]);
  const realBefore = await page.evaluate(() => ({ dump: window.__air!.boardDump(), view: window.__air!.controller.view }));
  await page.getByRole('button', { name: 'Practice and help' }).click();
  const card = page.getByRole('region', { name: 'Practice (about 20 seconds)' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Drag on the board.')).toBeVisible();
  // 1. A loop of at least 40 px.
  await drawWithMouse(page, [[300, 300], [360, 280], [380, 340], [320, 370], [300, 310]]);
  await expect(card.getByText('✓ Draw a loop — done')).toBeVisible();
  // 2. Pan ≥ 40 px with Space-drag.
  await page.locator('canvas.board').focus();
  await page.keyboard.down(' ');
  await drawWithMouse(page, [[500, 400], [560, 430]]);
  await page.keyboard.up(' ');
  await expect(card.getByText('✓ Move the board — done')).toBeVisible();
  // 3. Zoom ≥ 15%.
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, -200);
  await expect(card.getByText('✓ Zoom — done')).toBeVisible();
  // 4. Erase the loop.
  await page.getByRole('button', { name: 'Eraser' }).click();
  const loop = await page.evaluate(() => {
    const b = window.__air!.activeBoard();
    const s = b.doc.strokes[0]!;
    const v = b.view;
    return { x: s.points.x(0) * v.scale + v.tx, y: s.points.y(0) * v.scale + v.ty };
  });
  await drawWithMouse(page, [[loop.x - 30, loop.y], [loop.x + 30, loop.y]]);
  await expect(card.getByText(/All four done in \d+ s\./)).toBeVisible();
  await card.getByRole('button', { name: 'Start writing' }).click();
  await expect(card).toBeHidden();
  const realAfter = await page.evaluate(() => ({ dump: window.__air!.boardDump(), view: window.__air!.controller.view }));
  expect(realAfter).toEqual(realBefore);
  expect(await page.evaluate(() => window.__air!.activeBoard() === window.__air!.controller)).toBe(true);
  expect(await page.evaluate(() => window.__air!.practice.completions.length)).toBe(1);
});

test('settings changes wait for the stroke to finish (idle boundary) (F27)', async ({ page }) => {
  await open(page);
  const surface = await page.evaluate(() => {
    const l = window.__air!.layout();
    return { width: l.width, height: l.height, stripWidth: l.board.x };
  });
  const record = scenario('long stroke', [{ phases: [hover(300, 500, 300), writeMove(1200, 500, 300, 800, 380), hover(300, 800, 380)] }], {}, { surface });
  const json = JSON.parse(JSON.stringify(record)) as { frames: unknown[] };
  const half = Math.floor(json.frames.length / 2);
  const result = await page.evaluate(
    async ({ r, half }) => {
      const air = window.__air!;
      const first = { ...r, frames: r.frames.slice(0, half) };
      await air.replay(first, Number.POSITIVE_INFINITY);
      const drawing = air.activeBoard().active !== null;
      air.applyConfig({ reach: 0.5, stabilizer: 'steady' });
      const duringReach = air.config().reach;
      const recordFrames = r.frames.slice(half) as Array<{ t: number; ageMs: number; hands: never[] }>;
      for (const f of recordFrames) air.injectResult(f.t, f.hands, f.ageMs, { width: 640, height: 480 });
      return { drawing, duringReach, afterReach: air.config().reach, afterPreset: air.config().stabilizer, strokes: air.controller.stats.strokes };
    },
    { r: json, half },
  );
  expect(result.drawing).toBe(true);
  expect(result.duringReach).toBe(0.7);
  expect(result.afterReach).toBe(0.5);
  expect(result.afterPreset).toBe('steady');
  expect(result.strokes).toBe(1);
});

test('hiding the camera preview keeps inference running; practice is offered once (F28)', async ({ page }) => {
  await page.goto('./?hud=0&backend=cpu');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 60_000 }).toBe('ready');
  const offer = page.getByRole('region', { name: 'Practice offer' });
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'No thanks' }).click();
  await expect(offer).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Show camera preview' }).click();
  await expect(page.locator('.preview')).toHaveAttribute('data-hidden', 'true');
  await expect(page.getByRole('combobox', { name: 'Camera' })).toBeEnabled();
  await page.keyboard.press('Escape');
  const before = await page.evaluate(() => window.__air!.metrics!.counter('accepted'));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__air!.metrics!.counter('accepted'));
  expect(after - before).toBeGreaterThan(10);
});
