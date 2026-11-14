/**
 * Hand-operated controls and lifecycle interruptions in the bench build
 * (F21, F23, F25). Hands are synthetic landmark replays positioned on the
 * real DOM controls; lifecycle tests use Chromium's fake camera.
 */
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../../src/dev/devtools';
import { POSES } from '../../support/hands';
import { hover, move, writeMove, scenario, still, type Phase } from '../../support/scenarios';
import { drawWithMouse, inkPixels } from '../support';

const controlAt = (ms: number, x: number, y: number): Phase => ({ ms, pose: POSES.pinch(), path: still(x, y) });

async function open(page: Page): Promise<void> {
  await page.goto('./?hud=0');
  await page.getByRole('button', { name: 'Use mouse' }).click();
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

async function surface(page: Page) {
  return page.evaluate(() => {
    const l = window.__air!.layout();
    return { width: l.width, height: l.height, stripWidth: l.board.x };
  });
}

async function play(page: Page, phases: Phase[]): Promise<void> {
  const record = scenario('ui', [{ phases }], {}, { surface: await surface(page) });
  await page.evaluate((r) => window.__air!.replay(r, Number.POSITIVE_INFINITY), JSON.parse(JSON.stringify(record)) as unknown);
}

test('a pinch on a color swatch selects it once; the held pinch never draws (F21)', async ({ page }) => {
  await open(page);
  const red = await centre(page, '[data-hand-target="color-red"]');
  await play(page, [hover(300, red.x, red.y), controlAt(300, red.x, red.y), { ms: 400, pose: POSES.pinch(), path: move(red.x, red.y, 600, 300) }, hover(300, 600, 300)]);
  await expect(page.getByRole('button', { name: 'Red ink' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(0);
});

test('a control that becomes enabled after startup is reachable by hand (regression)', async ({ page }) => {
  await open(page);
  // Undo starts disabled; drawing enables it after the hand layout was first computed.
  await drawWithMouse(page, [[200, 200], [500, 260]]);
  const undo = await centre(page, '[data-hand-target="undo"]');
  await play(page, [hover(300, undo.x, undo.y), controlAt(250, undo.x, undo.y), hover(250, undo.x, undo.y)]);
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(0);
});

test('clearing by hand needs a second, separate pinch on the confirmation (F23)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[200, 200], [500, 260]]);
  const ink = await inkPixels(page);
  const clear = await centre(page, '[data-hand-target="clear"]');
  // Measure where the confirmation button appears, then close the dialog.
  await page.getByRole('button', { name: 'Clear board…' }).click();
  const confirm = await centre(page, '[data-hand-target="clear-confirm"]');
  await page.keyboard.press('Escape');
  await play(page, [
    hover(300, clear.x, clear.y),
    controlAt(200, clear.x, clear.y),
    // Same pinch held onto the confirmation button: must not clear.
    { ms: 400, pose: POSES.pinch(0.1), path: move(clear.x, clear.y, confirm.x, confirm.y) },
    { ms: 300, pose: POSES.pinch(0.1), path: still(confirm.x, confirm.y) },
  ]);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  expect(await inkPixels(page)).toBe(ink);
  // Release, then a new pinch confirms.
  await play(page, [hover(300, confirm.x, confirm.y), controlAt(200, confirm.x, confirm.y), hover(200, confirm.x, confirm.y)]);
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect.poll(() => inkPixels(page)).toBe(0);
});

test('a hand can pause and resume; paused hands never draw (F25)', async ({ page }) => {
  await open(page);
  const pauseBtn = await centre(page, '[data-hand-target="pause"]');
  await play(page, [hover(300, pauseBtn.x, pauseBtn.y), controlAt(200, pauseBtn.x, pauseBtn.y), hover(200, pauseBtn.x, pauseBtn.y)]);
  await expect(page.locator('.mode-chip')).toHaveText('Paused');
  await play(page, [hover(300, 600, 300), writeMove(500, 600, 300, 800, 350), hover(200, 800, 350)]);
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(0);
  // replay() resets tracks; pause persists and Resume is reachable by hand.
  await play(page, [hover(300, pauseBtn.x, pauseBtn.y), controlAt(200, pauseBtn.x, pauseBtn.y), hover(300, pauseBtn.x, pauseBtn.y)]);
  await expect(page.getByRole('button', { name: 'Pause hand input' })).toHaveAttribute('aria-pressed', 'false');
  await play(page, [hover(300, 600, 300), writeMove(500, 600, 300, 800, 350), hover(200, 800, 350)]);
  expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(1);
});

test.describe('lifecycle with the fake camera (F25)', () => {
  async function startCamera(page: Page): Promise<void> {
    await page.goto('./?hud=0&backend=cpu');
    await page.getByRole('button', { name: 'Start camera' }).first().click();
    await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 60_000 }).toBe('ready');
  }

  test('blur pauses editing and inference; Resume restarts admission', async ({ page }) => {
    await startCamera(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('.mode-chip')).toHaveText('Paused');
    expect(await page.evaluate(() => window.__air!.session.state.kind)).toBe('paused');
    await page.getByRole('button', { name: 'Resume hand input' }).click();
    await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 15_000 }).toBe('ready');
  });

  test('a long-hidden tab stops the camera and keeps the board', async ({ page }) => {
    await startCamera(page);
    await drawWithMouse(page, [[200, 200], [500, 240]]);
    await page.evaluate(() => window.__air!.applyConfig({ lifecycle: { hiddenStopMs: 300 } }));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind)).toBe('idle');
    await expect(page.getByText('camera was turned off because the tab was hidden')).toBeVisible();
    expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(1);
  });

  test('pagehide and an unplugged camera release everything without losing ink', async ({ page }) => {
    await startCamera(page);
    await drawWithMouse(page, [[200, 300], [500, 340]]);
    await page.evaluate(() => {
      const track = window.__air!.session.mediaStream!.getVideoTracks()[0]!;
      track.dispatchEvent(new Event('ended'));
    });
    await expect(page.getByRole('alert')).toContainText('Camera disconnected');
    expect(await page.evaluate(() => window.__air!.session.mediaStream)).toBeNull();
    expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(1);
    await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => page.evaluate(() => window.__air!.session.state.kind), { timeout: 60_000 }).toBe('ready');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    expect(await page.evaluate(() => window.__air!.session.state.kind)).toBe('idle');
    expect(await page.evaluate(() => window.__air!.controller.stats.strokes)).toBe(1);
  });
});
