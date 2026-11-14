/**
 * Editing and recovery with pointer and keyboard on the production build
 * (F20, F22, F23, F24, F25 subsets).
 */
import { expect, test, type Page } from '@playwright/test';
import { drawWithMouse, inkPixels } from './support';

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByRole('button', { name: 'Use mouse' }).click();
}

/** Color of the board pixel at board-local CSS (x, y). */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    ([px, py]) => {
      const board = document.querySelector<HTMLCanvasElement>('canvas.board')!;
      const scale = board.width / board.getBoundingClientRect().width;
      const c = document.createElement('canvas');
      c.width = board.width;
      c.height = board.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(board, 0, 0);
      const d = ctx.getImageData(Math.round(px! * scale), Math.round(py! * scale), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    [x, y],
  );
}

test('clear needs confirmation by keyboard and is undoable (F23, F22)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[100, 100], [400, 200]]);
  const ink = await inkPixels(page);
  await page.locator('canvas.board').focus();
  await page.keyboard.press('c');
  const dialog = page.getByRole('alertdialog', { name: 'Clear the board?' });
  await expect(dialog).toBeVisible();
  // Safe default: Cancel has focus, so Enter right after C does not clear.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect(await inkPixels(page)).toBe(ink);
  await page.locator('canvas.board').focus();
  await page.keyboard.press('c');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await inkPixels(page)).toBe(ink);
  await page.locator('canvas.board').focus();
  await page.keyboard.press('c');
  await dialog.getByRole('button', { name: 'Clear board' }).click();
  await expect.poll(() => inkPixels(page)).toBe(0);
  await page.locator('canvas.board').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => inkPixels(page)).toBe(ink);
});

test('toolbar clear, undo and redo buttons with disabled states (F22, F23)', async ({ page }) => {
  await open(page);
  const undo = page.getByRole('button', { name: 'Undo' });
  const redo = page.getByRole('button', { name: 'Redo' });
  await expect(undo).toBeDisabled();
  await drawWithMouse(page, [[100, 300], [500, 320]]);
  await expect(undo).toBeEnabled();
  await page.getByRole('button', { name: 'Clear board…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear board' }).click();
  await expect.poll(() => inkPixels(page)).toBe(0);
  await undo.click();
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(0);
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect.poll(() => inkPixels(page)).toBe(0);
  await undo.click();
  await undo.click();
  await expect.poll(() => inkPixels(page)).toBe(0);
  await expect(undo).toBeDisabled();
});

test('color and size choices apply to new strokes only (F20)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[100, 100], [400, 100]]);
  await page.getByRole('button', { name: 'Red ink' }).click();
  await page.getByRole('button', { name: /Bold pen/ }).click();
  await expect(page.getByRole('button', { name: 'Red ink' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Black ink' })).toHaveAttribute('aria-pressed', 'false');
  await drawWithMouse(page, [[100, 300], [400, 300]]);
  const first = await pixel(page, 250, 100);
  const second = await pixel(page, 250, 300);
  expect(first[0]).toBeLessThan(60); // still black
  expect(second[0]).toBeGreaterThan(150); // red
  expect(second[1]).toBeLessThan(80);
  // Bold (8 px) is visibly thicker than medium (4 px): 3 px off-center is still ink.
  expect((await pixel(page, 250, 303))[0]).toBeGreaterThan(150);
  expect((await pixel(page, 250, 103))[0]).toBeGreaterThan(200);
});

test('shortcuts respect focus: no board shortcuts from toolbar focus, none inside dialogs (F24)', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[100, 100], [300, 120]]);
  await page.getByRole('button', { name: 'Black ink' }).focus();
  await page.keyboard.press('c');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await page.getByRole('button', { name: 'Clear board…' }).click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Escape');
  expect(await inkPixels(page)).toBeGreaterThan(0); // Ctrl+Z inside the dialog did not undo
  await page.getByRole('button', { name: 'Black ink' }).focus();
  await page.keyboard.press('Control+z'); // allowed outside text inputs and dialogs
  await expect.poll(() => inkPixels(page)).toBe(0);
});

test('pause toggles from the toolbar and P, with a visible state (F25)', async ({ page }) => {
  await open(page);
  const pause = page.getByRole('button', { name: 'Pause hand input' });
  await pause.click();
  await expect(page.getByRole('button', { name: 'Resume hand input' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.mode-chip')).toHaveText('Paused');
  await page.locator('canvas.board').focus();
  await page.keyboard.press('p');
  await expect(page.getByRole('button', { name: 'Pause hand input' })).toHaveAttribute('aria-pressed', 'false');
  // Mouse drawing is not affected by hand-input pause.
  await page.keyboard.press('p');
  await drawWithMouse(page, [[100, 100], [300, 140]]);
  expect(await inkPixels(page)).toBeGreaterThan(0);
});

test('handwriting cleanup is explicit and undoable', async ({ page }) => {
  await open(page);
  await drawWithMouse(page, [[100, 120], [110, 122], [120, 118], [130, 122], [140, 120], [150, 122]]);
  await page.getByRole('button', { name: 'Clean up handwriting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clean up handwriting' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Light smoothing' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
  expect(await inkPixels(page)).toBeGreaterThan(0);
});
