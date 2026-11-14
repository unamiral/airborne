import { defineConfig } from '@playwright/test';
import base, { BENCH_URL } from './playwright.config.ts';

/**
 * Hardware benchmarks. Uses Chromium's full browser in new-headless mode
 * (`channel: 'chromium'`), which on macOS renders WebGL through ANGLE/Metal
 * on the real GPU. The default headless shell uses SwiftShader (software)
 * and must not be used for GPU numbers.
 */
export default defineConfig({
  ...base,
  testDir: 'tests/benchmarks',
  testMatch: /.*\.bench\.ts$/,
  timeout: 15 * 60_000,
  globalSetup: './tests/e2e/global-setup.ts',
  projects: [
    {
      name: 'hardware',
      use: {
        ...base.use,
        baseURL: BENCH_URL,
        channel: 'chromium',
        launchOptions: {
          args: [...(base.use?.launchOptions?.args ?? []), '--enable-gpu', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
});
