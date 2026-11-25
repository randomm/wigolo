import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

/**
 * Zombie-leak guards (Phase 0, scaling spec Task 0.4). Two live leak paths under
 * memory pressure (the OOM-kill regime the 6 GiB cap now makes reachable):
 *
 *  (b) launchBrowser caches typePool.browser but never registers
 *      browser.on('disconnected'). A browser killed out-of-band (OOM killer,
 *      crash) leaves the pool holding a DEAD browser forever: every later
 *      acquire launches contexts on it and every fetch fails — a permanent
 *      poisoning, not a transient error, with no Chrome process to reap.
 *
 *  (d) shutdown() drains pool contexts and idle timers but NEVER stealthWaitQueue.
 *      A stealth fetch queued on a held slot when shutdown arrives waits on a
 *      promise nobody can ever resolve — the request hangs past process teardown.
 */

interface ZombieState {
  browsersLaunched: number;
  contextsCreated: number;
  disconnectHandlers: Array<() => void>;
  gotoHang: boolean;
}

const state: ZombieState = {
  browsersLaunched: 0,
  contextsCreated: 0,
  disconnectHandlers: [],
  gotoHang: false,
};

function makePage() {
  return {
    goto: vi.fn().mockImplementation((url: string) => {
      // gotoHang is read at CALL time so a test can flip it after launching.
      if (state.gotoHang) return new Promise<never>(() => {});
      return Promise.resolve({
        status: () => 200,
        url: () => url,
        headers: () => ({ 'content-type': 'text/html' }),
      });
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

interface FakeBrowser {
  dead: boolean;
  newContext: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function makeContext(browser: FakeBrowser) {
  state.contextsCreated++;
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockImplementation(() => {
      // A context born from a dead browser cannot serve pages — mirrors
      // Playwright's "Target closed" on a disconnected browser.
      if (browser.dead) return Promise.reject(new Error('Target closed: browser has been disconnected'));
      return Promise.resolve(makePage());
    }),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser(): FakeBrowser {
  state.browsersLaunched++;
  const browser: FakeBrowser = {
    dead: false,
    newContext: vi.fn().mockImplementation(() => Promise.resolve(makeContext(browser))),
    close: vi.fn().mockImplementation(() => {
      browser.dead = true;
      return Promise.resolve(undefined);
    }),
    on: vi.fn().mockImplementation((event: string, cb: () => void) => {
      if (event === 'disconnected') state.disconnectHandlers.push(cb);
    }),
  };
  return browser;
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function resetState() {
  state.browsersLaunched = 0;
  state.contextsCreated = 0;
  state.disconnectHandlers = [];
  state.gotoHang = false;
}

describe('browser-pool zombie guards (Task 0.4)', () => {
  beforeEach(() => {
    process.env.WIGOLO_STEALTH_DRIVER = 'playwright';
    resetConfig();
    resetState();
  });
  afterEach(() => {
    process.env.WIGOLO_STEALTH_DRIVER = 'playwright';
    delete process.env.MAX_BROWSERS;
    resetConfig();
  });

  it('(b) a disconnected pooled browser is dropped: the next fetch relaunches instead of reusing the corpse', async () => {
    const pool = new MultiBrowserPool();

    // First fetch launches the pooled browser and releases its context to the pool.
    const r1 = await pool.fetchWithBrowser('https://a.example', {});
    expect(r1.method).toBe('browser');
    expect(state.browsersLaunched).toBe(1);
    expect(state.disconnectHandlers.length).toBeGreaterThan(0); // the fix registers one

    // The browser is killed out-of-band (OOM killer / crash): Playwright emits
    // 'disconnected'; its contexts can no longer serve pages.
    for (const cb of state.disconnectHandlers) cb();

    // The idle context belonged to the dead browser — it must not sit in the
    // pool waiting to be handed to the next fetch.
    expect(pool.getStats()[0].pooledCount).toBe(0);

    // The pool must LAUNCH A FRESH browser for the next fetch rather than
    // launching a context on the corpse (which would reject every request).
    const r2 = await pool.fetchWithBrowser('https://b.example', {});
    expect(r2.method).toBe('browser');
    expect(state.browsersLaunched).toBe(2);

    await pool.shutdown();
  });

  it('(d) shutdown releases queued stealth waiters with an error instead of hanging them', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();
    state.gotoHang = true; // first fetch holds its slot indefinitely

    const pool = new MultiBrowserPool();
    const ac1 = new AbortController();
    const p1 = pool.fetchWithBrowser('https://a.example', { stealth: true, signal: ac1.signal });
    await new Promise((r) => setTimeout(r, 10)); // slot acquired

    const p2settled = pool.fetchWithBrowser('https://b.example', { stealth: true }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20)); // p2 is queued on the full semaphore

    await pool.shutdown();

    // The queued waiter must settle (rejected, "shutting down") — not wait on a
    // promise nobody will resolve.
    const outcome = await Promise.race([
      p2settled,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(outcome).not.toBe('timeout');
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toMatch(/shut ?ting down/i);

    // Release the hung first fetch so nothing dangles for the runner.
    state.gotoHang = false;
    ac1.abort(new DOMException('test teardown', 'AbortError'));
    await expect(p1).rejects.toBeTruthy();
  });
});
