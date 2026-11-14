import { expect, test } from '@playwright/test';
import { enterBoard, drawWithMouse } from './support';

test('restores the board and theme and remembers the welcome choice', async ({ page }) => {
  await page.goto('./');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await drawWithMouse(page, [[250, 200], [400, 260]]);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'White ink' })).toBeVisible();
  await expect.poll(() => page.locator('canvas.board').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d')!;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let light = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 240 && pixels[i + 1]! > 240 && pixels[i + 2]! > 240) light++;
    return { background: Array.from(pixels.slice(0, 3)), hasWhiteInk: light > 10 };
  })).toMatchObject({ background: [0, 0, 0], hasWhiteInk: true });
  const before = await page.evaluate(() => localStorage.getItem('air-whiteboard-board-v1'));
  expect((JSON.parse(before!) as unknown[]).length).toBe(1);
  await page.reload();
  await enterBoard(page);
  await expect(page.getByRole('heading', { name: 'Air Whiteboard' })).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await drawWithMouse(page, [[300, 300], [450, 350]]);
  const after = await page.evaluate(() => localStorage.getItem('air-whiteboard-board-v1'));
  expect((JSON.parse(after!) as unknown[]).length).toBe(2);
});

test('paper backgrounds change with dark mode and persist', async ({ page }) => {
  await page.goto('./');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  for (const name of ['Grid', 'Cornell', 'Notebook']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => page.locator('canvas.board').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    const image = ctx.getImageData(0, 0, c.width, c.height).data;
    let guides = 0;
    for (let i = 0; i < image.length; i += 4) if (image[i]! > 20 && image[i]! < 200) guides++;
    return guides;
  })).toBeGreaterThan(100);
  await page.reload();
  await enterBoard(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Notebook', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute('aria-checked', 'true');
});

test('live camera background uses the active camera and is not restored on reload', async ({ page }) => {
  await page.goto('./');
  await enterBoard(page);
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Live camera' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('status')).toContainText('Tracking on this device', { timeout: 60_000 });
  await expect.poll(() => page.locator('canvas.board').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let colorful = 0;
    for (let i = 0; i < data.length; i += 400) if (Math.abs(data[i]! - data[i + 1]!) > 10) colorful++;
    return colorful;
  })).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await page.reload();
  await enterBoard(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Plain', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
