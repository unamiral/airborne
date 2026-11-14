import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchInterruptions } from '../../src/app/interruptions';
import { PALETTE, WIDTHS, commandForTarget } from '../../src/ui/toolbar';

afterEach(() => vi.useRealTimers());

function fakeTargets() {
  const winListeners = new Map<string, () => void>();
  const docListeners = new Map<string, () => void>();
  const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (t: string, f: () => void) => docListeners.set(t, f), removeEventListener: () => undefined };
  const win = {
    addEventListener: (t: string, f: () => void) => winListeners.set(t, f),
    removeEventListener: () => undefined,
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) as unknown as number,
    clearTimeout: (h: number) => clearTimeout(h),
  };
  return { win, doc, winListeners, docListeners };
}

describe('page interruptions (F25)', () => {
  it('suspends immediately when hidden and stops the camera only after the hidden limit', () => {
    vi.useFakeTimers();
    const t = fakeTargets();
    const calls: string[] = [];
    watchInterruptions({ window: t.win as never, document: t.doc as never }, () => 30_000, {
      suspend: (r) => calls.push(`suspend:${r}`),
      hiddenTooLong: () => calls.push('stop'),
      pageHide: () => calls.push('pagehide'),
    });
    t.doc.visibilityState = 'hidden';
    t.docListeners.get('visibilitychange')!();
    expect(calls).toEqual(['suspend:hidden']);
    vi.advanceTimersByTime(29_000);
    expect(calls).toEqual(['suspend:hidden']);
    vi.advanceTimersByTime(1_500);
    expect(calls).toEqual(['suspend:hidden', 'stop']);
  });

  it('cancels the camera stop when the tab becomes visible again in time', () => {
    vi.useFakeTimers();
    const t = fakeTargets();
    const calls: string[] = [];
    watchInterruptions({ window: t.win as never, document: t.doc as never }, () => 30_000, {
      suspend: (r) => calls.push(`suspend:${r}`),
      hiddenTooLong: () => calls.push('stop'),
      pageHide: () => calls.push('pagehide'),
    });
    t.doc.visibilityState = 'hidden';
    t.docListeners.get('visibilitychange')!();
    vi.advanceTimersByTime(5_000);
    t.doc.visibilityState = 'visible';
    t.docListeners.get('visibilitychange')!();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['suspend:hidden']);
    t.winListeners.get('blur')!();
    t.winListeners.get('pagehide')!();
    expect(calls).toEqual(['suspend:hidden', 'suspend:blur', 'pagehide']);
  });
});

describe('toolbar routing (F20, F21)', () => {
  it('maps every hand target to exactly one command', () => {
    for (const c of PALETTE) expect(commandForTarget(`color-${c.id}`)).toEqual({ kind: 'color', value: c.value });
    for (const w of WIDTHS) expect(commandForTarget(`width-${w.id}`)).toEqual({ kind: 'width', px: w.px });
    expect(commandForTarget('tool-eraser')).toEqual({ kind: 'tool', tool: 'eraser' });
    expect(commandForTarget('clear')).toEqual({ kind: 'clear' });
    expect(commandForTarget('nope')).toBeNull();
  });

  it('offers six distinct colors and three increasing widths', () => {
    expect(new Set(PALETTE.map((c) => c.value)).size).toBe(6);
    expect(WIDTHS.map((w) => w.px)).toEqual([2, 4, 8]);
  });

  it('uses palette colors with at least 4.5:1 contrast on white', () => {
    const lum = (hex: string) => {
      const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
    };
    for (const c of PALETTE) expect((1.05 / (lum(c.value) + 0.05)), c.name).toBeGreaterThanOrEqual(4.5);
  });
});
