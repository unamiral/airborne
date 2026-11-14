import { expect, test, type Page } from '@playwright/test';

async function enter(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByRole('button', { name: 'Click to continue to Air Whiteboard' }).click();
}

test('advanced settings organize writing and persist developer tools visibility', async ({ page }) => {
  await enter(page);
  const hud = page.locator('.hud');
  const recorder = page.getByRole('region', { name: 'Developer landmark recorder' });
  await expect(hud).toBeVisible();
  await expect(recorder).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('spinbutton', { name: 'Start distance' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Start distance' })).toBeVisible();
  const toggle = dialog.getByRole('switch', { name: 'Show developer tools' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(hud).toBeHidden();
  await expect(recorder).toBeHidden();
  await dialog.getByRole('button', { name: 'Back to settings' }).click();
  await expect(dialog.getByRole('button', { name: 'Reset to defaults' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Click to continue to Air Whiteboard' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await dialog.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(hud).toBeVisible();
  await expect(recorder).toBeVisible();
});
