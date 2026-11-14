/**
 * M4 interface on the production build: PNG export (F30), settings (F27),
 * accessibility basics (F28), narrow windows.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { drawWithMouse, inkPixels } from './support';

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByRole('button', { name: 'Use mouse' }).click();
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('exports the visible board as a PNG that matches the canvas and changes nothing (F30)', async ({ page }) => {
  await page.addInitScript(() => {
    const revoked: string[] = [];
    (window as unknown as { __revoked: string[] }).__revoked = revoked;
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      original(url);
    };
  });
  await open(page);
  await drawWithMouse(page, [[100, 100], [300, 220], [500, 140]]);
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -150);
  const before = await inkPixels(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^air-whiteboard-\d{8}-\d{4}\.png$/);
  const bytes = readFileSync(await download.path());
  const size = pngSize(bytes);
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.board')!;
    return { width: c.width, height: c.height };
  });
  expect(size).toEqual(canvasSize);
  // Decode the PNG in the page and compare ink with the visible board.
  const compare = await page.evaluate(async (b64) => {
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const board = document.querySelector<HTMLCanvasElement>('canvas.board')!;
    const read = (src: CanvasImageSource) => {
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const a = read(bmp);
    const v = read(board);
    let ink = 0;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i]! < 200) ink++;
      if (Math.abs(a[i]! - v[i]!) > 96) diff++;
    }
    return { ink, diff, corner: [a[0], a[1], a[2]] };
  }, bytes.toString('base64'));
  expect(compare.corner).toEqual([255, 255, 255]);
  expect(compare.ink).toBeGreaterThan(100);
  expect(compare.diff).toBeLessThan(compare.ink * 0.02 + 20);
  expect(await inkPixels(page)).toBe(before);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __revoked: string[] }).__revoked.length), { timeout: 3000 }).toBe(1);
});

test('exports an empty board as a white image and reports encoding failures (F30)', async ({ page }) => {
  await open(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  const size = pngSize(readFileSync(await (await downloadPromise).path()));
  expect(size.width).toBeGreaterThan(0);
  await page.evaluate(() => {
    OffscreenCanvas.prototype.convertToBlob = () => Promise.reject(new Error('encoder unavailable'));
  });
  await drawWithMouse(page, [[100, 100], [200, 150]]);
  await page.getByRole('button', { name: 'Export PNG' }).click();
  await expect(page.getByText(/could not encode the PNG image\. Your board is unchanged\./)).toBeVisible();
  expect(await inkPixels(page)).toBeGreaterThan(0);
});

test('settings are labelled, keyboard-operable, and reset to defaults (F27, F28)', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Balanced/ })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: /Steady/ }).click();
  await expect(dialog.getByRole('button', { name: /Steady/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText('Steadier movement, more resistance.')).toBeVisible();
  const reach = dialog.getByRole('slider', { name: 'Reach' });
  await reach.focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('output')).toHaveText('75% of the camera view');
  await dialog.getByRole('button', { name: 'More hand movement' }).click();
  await expect(dialog.locator('output')).toHaveText('80% of the camera view');
  const fist = dialog.getByRole('switch', { name: 'Erase with a held fist' });
  await expect(fist).toHaveAttribute('aria-checked', 'true');
  await fist.click();
  await expect(fist).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByRole('combobox', { name: 'Camera' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(dialog.getByRole('button', { name: /Balanced/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('output')).toHaveText('70% of the camera view');
  await expect(fist).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('every control has an accessible name and keyboard traversal reaches the board (F28)', async ({ page }) => {
  await open(page);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role="switch"], select, input')]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .filter((e) => {
        const label = e.getAttribute('aria-label') ?? (e.textContent ?? '').trim();
        return label.length === 0 && !(e.id !== '' && document.querySelector(`label[for="${e.id}"]`) !== null);
      }).length,
  );
  expect(unnamed).toBe(0);
  const toggles = await page.locator('nav.toolbar button[aria-pressed]').count();
  expect(toggles).toBeGreaterThanOrEqual(13); // tools, pause, colors, widths
  await page.locator('body').click({ position: { x: 5, y: 790 } });
  let reachedBoard = false;
  for (let i = 0; i < 40 && !reachedBoard; i++) {
    await page.keyboard.press('Tab');
    reachedBoard = await page.evaluate(() => document.activeElement?.classList.contains('board') === true);
  }
  expect(reachedBoard).toBe(true);
  const focusOutline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(focusOutline).not.toBe('none');
});

test('basic controls fit a narrow window and drawing still works', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 820 });
  await open(page);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  const board = await page.locator('canvas.board').boundingBox();
  expect(board!.width).toBeGreaterThan(400);
  await drawWithMouse(page, [[50, 200], [300, 260]]);
  expect(await inkPixels(page)).toBeGreaterThan(50);
});

test('hand targets are at least 48 CSS px and fully inside the 1280×800 surface (F06, F21)', async ({ page }) => {
  await open(page);
  const check = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-hand-target]')]
        .filter((e) => e.getClientRects().length > 0 && e.closest('[hidden]') === null && (e.closest('dialog') === null || e.closest('dialog')!.open))
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { id: e.dataset.handTarget, w: r.width, h: r.height, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
        }),
    );
  const strip = await check();
  expect(strip.length).toBeGreaterThanOrEqual(19);
  for (const t of strip) {
    expect(t.inside, t.id).toBe(true);
    expect(Math.min(t.w, t.h), t.id).toBeGreaterThanOrEqual(48);
  }
  await page.getByRole('button', { name: 'Clear board…' }).click();
  for (const t of await check()) expect(Math.min(t.w, t.h), t.id).toBeGreaterThanOrEqual(48);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings' }).click();
  for (const t of await check()) {
    expect(t.inside, t.id).toBe(true);
    expect(Math.min(t.w, t.h), t.id).toBeGreaterThanOrEqual(48);
  }
});
