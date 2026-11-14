import { expect, test } from '@playwright/test';

test('welcome screen opens the whiteboard by keyboard', async ({ page }) => {
  await page.goto('./');
  const welcome = page.getByRole('button', { name: 'Click to continue to Air Whiteboard' });
  await expect(welcome).toBeVisible();
  await expect(welcome).toBeFocused();
  await expect(welcome.getByText('Click to continue')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(welcome).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Whiteboard tools' })).toBeVisible();
});

test('welcome screen opens immediately with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('./');
  await page.getByRole('button', { name: 'Click to continue to Air Whiteboard' }).click();
  await expect(page.getByRole('navigation', { name: 'Whiteboard tools' })).toBeVisible();
});
