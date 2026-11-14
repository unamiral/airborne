import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Browser tests run against built output, never the dev server:
 *  - "prod": production build served under a subpath (/air-whiteboard/) with
 *    the deployment security headers (CSP, Permissions-Policy).
 *  - "bench": the same code built with developer instrumentation (`__air`
 *    handle, metrics, replay) for measurement and replay-driven tests.
 *
 * Chromium's fake media device plays tests/.cache/fake-camera.mjpeg (built
 * from MediaPipe test photos) so the real model runs in the real worker. That
 * is a synthetic video source, not a real-camera test.
 */
const fakeCamera = resolve('tests/.cache/fake-camera.mjpeg');
const reuse = process.env.CI === undefined;

export const PROD_URL = 'http://localhost:4173/air-whiteboard/';
export const BENCH_URL = 'http://localhost:4174/';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${fakeCamera}`,
      ],
    },
  },
  projects: [
    { name: 'prod', testIgnore: /bench\//, use: { baseURL: PROD_URL } },
    { name: 'bench', testMatch: /bench\/.*\.spec\.ts/, use: { baseURL: BENCH_URL } },
  ],
  webServer: [
    {
      command: 'npx vite preview --outDir dist --base /air-whiteboard/ --port 4173 --strictPort',
      url: PROD_URL,
      reuseExistingServer: reuse,
      stdout: 'ignore',
    },
    {
      command: 'npx vite preview --outDir dist-bench --mode bench --port 4174 --strictPort',
      url: BENCH_URL,
      reuseExistingServer: reuse,
      stdout: 'ignore',
    },
  ],
});
