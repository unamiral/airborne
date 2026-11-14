import { expect, type Page } from '@playwright/test';

/** State recorded by the instrumentation init script. */
export interface Probe {
  gumCalls: number;
  streams: MediaStream[];
  cspViolations: string[];
}

type GumMode = 'real' | 'deny' | 'notfound' | 'busy' | 'pending' | 'absent' | 'insecure';

/**
 * Instruments the page before any app script runs: counts getUserMedia calls,
 * keeps the returned streams (to check they are stopped), records CSP
 * violations, and optionally replaces getUserMedia with a failure.
 */
export async function instrument(page: Page, mode: GumMode = 'real'): Promise<void> {
  await page.addInitScript((m: GumMode) => {
    const probe = { gumCalls: 0, streams: [] as MediaStream[], cspViolations: [] as string[] };
    (window as unknown as { __probe: typeof probe }).__probe = probe;
    document.addEventListener('securitypolicyviolation', (e) => {
      probe.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
    if (m === 'absent') {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      return;
    }
    if (m === 'insecure') {
      Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    }
    const md = navigator.mediaDevices;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      probe.gumCalls++;
      if (m === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
      if (m === 'notfound') throw new DOMException('Requested device not found', 'NotFoundError');
      if (m === 'busy') throw new DOMException('Could not start video source', 'NotReadableError');
      if (m === 'pending') return new Promise<MediaStream>(() => undefined);
      const stream = await original(constraints);
      probe.streams.push(stream);
      return stream;
    };
  }, mode);
}

export async function probe(page: Page): Promise<{ gumCalls: number; liveTracks: number; cspViolations: string[] }> {
  return page.evaluate(() => {
    const p = (window as unknown as { __probe: { gumCalls: number; streams: MediaStream[]; cspViolations: string[] } }).__probe;
    const liveTracks = p.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length;
    return { gumCalls: p.gumCalls, liveTracks, cspViolations: p.cspViolations };
  });
}

/** Counts non-white pixels on the board canvas. */
export async function inkPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const board = document.querySelector<HTMLCanvasElement>('canvas.board');
    if (board === null) return -1;
    const copy = document.createElement('canvas');
    copy.width = board.width;
    copy.height = board.height;
    const ctx = copy.getContext('2d');
    if (ctx === null) return -1;
    ctx.drawImage(board, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! < 200 || data[i + 1]! < 200 || data[i + 2]! < 200) count++;
    }
    return count;
  });
}

export async function drawWithMouse(page: Page, points: ReadonlyArray<readonly [number, number]>): Promise<void> {
  const box = await page.locator('canvas.board').boundingBox();
  expect(box).not.toBeNull();
  const [first, ...rest] = points;
  if (first === undefined || box === null) return;
  await page.mouse.move(box.x + first[0], box.y + first[1]);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  await page.mouse.up();
}
