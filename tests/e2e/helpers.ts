import { expect, type Page } from '@playwright/test';
import type { SessionState } from '../../src/app/camera-session';
// Brings the bench-only `window.__air` declaration into this program.
import type {} from '../../src/dev/devtools';

// `window.__air` is declared by src/dev/devtools.ts and only exists in the
// bench build. Production tests must not rely on it.

export async function sessionKind(page: Page): Promise<SessionState['kind'] | null> {
  return page.evaluate(() => window.__air?.session.state.kind ?? null);
}

export async function waitForSession(page: Page, kind: SessionState['kind'], timeout = 60_000): Promise<void> {
  await expect.poll(() => sessionKind(page), { timeout }).toBe(kind);
}
