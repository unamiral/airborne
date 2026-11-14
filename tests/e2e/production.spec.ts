/**
 * Privacy and production packaging (F31, F35) against the production build
 * served under /air-whiteboard/ with deployment headers.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drawWithMouse, instrument, probe } from './support';

test('the production bundle contains no developer tooling or source maps (F31)', () => {
  const files = readdirSync('dist/assets').filter((f) => f.endsWith('.js'));
  expect(files.length).toBeGreaterThan(0);
  const markers = ['__air', 'installDevtools', 'Developer landmark recorder', 'loadSyntheticBoard', 'compareWithReference', 'software pipeline', 'detectImages'];
  for (const f of files) {
    const text = readFileSync(join('dist/assets', f), 'utf8');
    for (const m of markers) expect(text.includes(m), `${f} contains ${m}`).toBe(false);
  }
  expect(readdirSync('dist/assets').some((f) => f.endsWith('.map'))).toBe(false);
});

test('a full session makes only same-origin GET requests and keeps data locally (F31)', async ({ page }) => {
  const requests: Array<{ url: string; method: string }> = [];
  const sockets: string[] = [];
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  page.on('websocket', (w) => sockets.push(w.url()));
  await instrument(page);
  await page.goto('./');
  await page.getByRole('button', { name: 'Use mouse' }).click();
  await drawWithMouse(page, [[100, 100], [300, 200]]);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Steady/ }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Start camera' }).first().click();
  await expect(page.getByRole('status')).toContainText('Tracking on this device', { timeout: 60_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  await download;
  await page.getByRole('button', { name: 'Stop camera' }).click();
  expect((await probe(page)).liveTracks).toBe(0);
  const origin = new URL(page.url()).origin;
  for (const r of requests) {
    expect(r.method, r.url).toBe('GET');
    if (!r.url.startsWith('blob:') && !r.url.startsWith('data:')) expect(new URL(r.url).origin).toBe(origin);
  }
  expect(sockets).toEqual([]);
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    idb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
    caches: 'caches' in window ? (await caches.keys()).length : 0,
    serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  }));
  expect(storage.local).toBeGreaterThan(0);
  expect(storage.cookie).toContain('air-welcome=1');
  expect({ session: storage.session, idb: storage.idb, caches: storage.caches, serviceWorkers: storage.serviceWorkers }).toEqual({ session: 0, idb: 0, caches: 0, serviceWorkers: 0 });
});

test('the deployment headers file matches the preview headers (F35)', () => {
  const headers = readFileSync('dist/_headers', 'utf8');
  expect(headers).toContain("Content-Security-Policy: default-src 'self'");
  expect(headers).toContain('Permissions-Policy: camera=(self), microphone=()');
  expect(headers).toMatch(/\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
  expect(headers).toContain('Content-Type: application/wasm');
});
