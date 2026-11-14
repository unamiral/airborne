import { expect, test } from '@playwright/test';
import { drawWithMouse, inkPixels, instrument, probe } from './support';

test.describe('F01 startup and pointer-only entry', () => {
  test('shows a usable board without asking for the camera or loading the model', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await instrument(page);
    const response = await page.goto('./');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Air Whiteboard' })).toBeVisible();
    await expect(page.getByText('Camera images are not uploaded')).toBeVisible();
    await page.getByRole('button', { name: 'Use mouse' }).click();
    await drawWithMouse(page, [
      [200, 200],
      [300, 260],
      [420, 220],
    ]);
    await expect.poll(() => inkPixels(page)).toBeGreaterThan(200);
    const p = await probe(page);
    expect(p.gumCalls).toBe(0);
    expect(requests.some((u) => /\.task$|\.wasm$|vision_wasm|inference\.worker/.test(u))).toBe(false);
    expect(p.cspViolations).toEqual([]);
  });

  test('loads and draws when media APIs are missing, and explains the camera limitation', async ({ page }) => {
    await instrument(page, 'absent');
    await page.goto('./');
    await page.getByRole('button', { name: 'Use mouse' }).click();
    await drawWithMouse(page, [
      [100, 100],
      [200, 150],
    ]);
    await expect.poll(() => inkPixels(page)).toBeGreaterThan(50);
    await page.getByRole('button', { name: 'Start camera' }).first().click();
    await expect(page.getByRole('alert')).toContainText('Camera not available in this browser');
  });

  test('serves the production build under a subpath with restrictive headers', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const response = await page.goto('./');
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(headers['permissions-policy']).toContain('camera=(self)');
    expect(headers['permissions-policy']).toContain('microphone=()');
    const origin = new URL(page.url()).origin;
    for (const url of requests) expect(new URL(url).origin).toBe(origin);
    expect(requests.every((u) => u.includes('/air-whiteboard/'))).toBe(true);
  });
});
