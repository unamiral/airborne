import type { Browser, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname } from 'node:path';

export interface BenchEnvironment {
  readonly date: string;
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly os: string;
  readonly browser: string;
  readonly mode: string;
  readonly gpuRenderer: string;
  readonly viewport: string;
  readonly devicePixelRatio: number;
  readonly camera: string;
  readonly powerMode: string;
  readonly displayRefresh: string;
}

export async function describeEnvironment(browser: Browser, page: Page): Promise<BenchEnvironment> {
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const vp = page.viewportSize();
  return {
    date: new Date().toISOString(),
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    os: `${platform()} ${release()}`,
    browser: `Chromium ${browser.version()}`,
    mode: 'new headless (channel=chromium), Playwright-controlled',
    gpuRenderer: gpu,
    viewport: vp ? `${vp.width}x${vp.height}` : 'unknown',
    devicePixelRatio: dpr,
    camera: 'Chromium fake device playing tests/.cache/fake-camera.mjpeg (640x480, 30 fps, MediaPipe test photos)',
    powerMode: 'not controlled (development laptop, unknown power source/thermal state)',
    displayRefresh: 'headless: no physical display',
  };
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`);
}

export function round(values: ArrayLike<number>, digits = 1): number[] {
  const f = 10 ** digits;
  return Array.from(values, (v) => Math.round(v * f) / f);
}
