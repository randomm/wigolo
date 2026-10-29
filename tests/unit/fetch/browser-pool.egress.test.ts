// halo: egress-proxy-ssrf — fork-only. While delegation is requested no browser may launch without
// the egress proxy: stealth forceNoProxy launches and unproxied pool launches are refused, and the
// cdp-direct rung is skipped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { EGRESS_DELEGATION_ENV, __resetEgressForTests } from '../../../src/fetch/egress-proxy.js';

const launchCalls: Array<Record<string, unknown>> = [];
const WEBRTC_FLAG = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';
// What the main navigation answers; a test may swap in squid's error page.
let navResponse: { status: number; url: string; headers: Record<string, string> } | null = null;

function makePage() {
  return {
    goto: vi.fn().mockImplementation(async () => {
      const r = navResponse ?? { status: 200, url: 'https://example.com', headers: { 'content-type': 'text/html' } };
      return { status: () => r.status, url: () => r.url, headers: () => r.headers };
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockResolvedValue('<html><body>ok content long enough to pass</body></html>'),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    launchCalls.push(opts);
    return Promise.resolve({
      newContext: vi.fn().mockResolvedValue(makeContext()),
      close: vi.fn().mockResolvedValue(undefined),
    });
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

// The cdp-direct rung serves content whenever it is reached, so a test can see whether it was.
const cdpDirectCalls: string[] = [];
vi.mock('../../../src/fetch/cdp-direct.js', () => ({
  cdpDirectFetch: vi.fn().mockImplementation((url: string) => {
    cdpDirectCalls.push(url);
    return Promise.resolve({
      url,
      finalUrl: url,
      html: '<html><body>cdp-direct-rung</body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'browser',
      headers: {},
    });
  }),
}));

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

const originalEnv = process.env;
const PROXY = 'http://alice:s3cret@proxy.example.com:8080';

describe('browser-pool launches under egress delegation', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error', WIGOLO_BROWSER_CHANNEL: 'chromium' };
    delete process.env[EGRESS_DELEGATION_ENV];
    launchCalls.length = 0;
    cdpDirectCalls.length = 0;
    navResponse = null;
    resetConfig();
  });
  afterEach(async () => {
    process.env = originalEnv;
    resetConfig();
    await __resetEgressForTests();
  });

  function setEnv(vars: Record<string, string>) {
    Object.assign(process.env, vars);
    resetConfig();
  }

  it('stealth forceNoProxy launch is refused when delegation is requested', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: PROXY });
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://example.com', { stealth: true, forceNoProxy: true })).rejects.toThrow(
      /direct-egress browser launch refused/,
    );
    expect(launchCalls).toHaveLength(0);
  });

  it('pool launch is refused when delegation is requested but the mode is not delegated', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1' }); // USE_PROXY unset → misconfigured
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://example.com', {})).rejects.toThrow(/browser proxy unavailable/);
    expect(launchCalls).toHaveLength(0);
  });

  it('delegated: pool and stealth launches go ahead, always with the proxy option', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: PROXY });
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {});
    await pool.fetchWithBrowser('https://example.com', { stealth: true });
    expect(launchCalls.length).toBeGreaterThan(0);
    for (const c of launchCalls) expect((c.proxy as { server?: string })?.server).toContain('proxy.example.com:8080');
  });

  it('strict: forceNoProxy still launches without a proxy (upstream unchanged)', async () => {
    setEnv({ USE_PROXY: 'true', PROXY_URL: PROXY });
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', { stealth: true, forceNoProxy: true });
    expect(launchCalls.length).toBeGreaterThan(0);
    for (const c of launchCalls) expect(c.proxy).toBeUndefined();
  });

  it('strict without a proxy: plain launch has no proxy option', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {});
    expect(launchCalls.length).toBeGreaterThan(0);
    for (const c of launchCalls) expect(c.proxy).toBeUndefined();
  });

  it('stealth launch without forceNoProxy is refused when delegation is requested but misconfigured', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1' }); // USE_PROXY unset → misconfigured, no proxy option
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://example.com', { stealth: true })).rejects.toThrow(
      /direct-egress browser launch refused/,
    );
    expect(launchCalls).toHaveLength(0);
  });

  it('pool launch is refused when the flag is not exactly "1" even though a proxy is configured', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: 'yes', USE_PROXY: 'true', PROXY_URL: PROXY }); // misconfigured, proxy defined
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://example.com', {})).rejects.toThrow(/browser proxy unavailable/);
    expect(launchCalls).toHaveLength(0);
  });

  it('delegated: chromium pool and stealth launches keep WebRTC UDP on the proxy', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: PROXY });
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {});
    await pool.fetchWithBrowser('https://example.com', { stealth: true });
    expect(launchCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of launchCalls) expect(c.args as string[]).toContain(WEBRTC_FLAG);
    // The stealth args survive alongside the WebRTC policy.
    expect(launchCalls.some((c) => (c.args as string[]).includes('--disable-blink-features=AutomationControlled'))).toBe(true);
  });

  it('delegated: firefox launches with RTCPeerConnection disabled; webkit is refused', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: PROXY });
    const firefox = new MultiBrowserPool({ browserTypes: ['firefox'] });
    await firefox.fetchWithBrowser('https://example.com', {});
    expect(launchCalls).toHaveLength(1);
    // The dedicated stealth launch builds its own options, so it needs the prefs too.
    await firefox.fetchWithBrowser('https://example.com', { stealth: true });
    expect(launchCalls).toHaveLength(2);
    for (const c of launchCalls) expect(c.firefoxUserPrefs).toMatchObject({ 'media.peerconnection.enabled': false });
    launchCalls.length = 0;
    await expect(new MultiBrowserPool({ browserTypes: ['webkit'] }).fetchWithBrowser('https://example.com', {})).rejects.toThrow(
      /webkit browser launch refused/,
    );
    expect(launchCalls).toHaveLength(0);
  });

  // Full Chrome / headful Chromium ignore the WebRTC launch switch, so these configs are misconfigured.
  it.each([
    ['WIGOLO_BROWSER_CHANNEL=chrome', { WIGOLO_BROWSER_CHANNEL: 'chrome' }],
    ['WIGOLO_BROWSER_CHANNEL=auto', { WIGOLO_BROWSER_CHANNEL: 'auto' }],
    ['WIGOLO_BROWSER_HEADFUL=1', { WIGOLO_BROWSER_HEADFUL: '1' }],
  ])('delegation requested + %s: no pool or stealth launch happens', async (_n, extra) => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: PROXY, ...extra });
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://example.com', { stealth: true })).rejects.toThrow(
      /direct-egress browser launch refused/,
    );
    await expect(pool.fetchWithBrowser('https://example.com', {})).rejects.toThrow(/browser proxy unavailable/);
    expect(launchCalls).toHaveLength(0);
  });

  it('strict: no WebRTC policy is added (upstream launch options unchanged)', async () => {
    setEnv({ USE_PROXY: 'true', PROXY_URL: PROXY });
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {});
    await pool.fetchWithBrowser('https://example.com', { stealth: true });
    expect(launchCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of launchCalls) {
      expect((c.args as string[] | undefined) ?? []).not.toContain(WEBRTC_FLAG);
      expect(c.firefoxUserPrefs).toBeUndefined();
    }
  });

  it("delegated: squid's error page for an http:// navigation is a refusal, never content", async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: PROXY });
    navResponse = {
      status: 403,
      url: 'http://denied.example.test/',
      headers: { 'content-type': 'text/html', 'x-squid-error': 'ERR_ACCESS_DENIED 0' },
    };
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('http://denied.example.test/', {})).rejects.toThrow(
      /egress proxy refused denied\.example\.test \(proxy status 403, ERR_ACCESS_DENIED 0\)/,
    );
  });

  it('misconfigured + WIGOLO_CDP_DIRECT=on: the cdp-direct rung is skipped and the fetch is refused', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', WIGOLO_CDP_DIRECT: 'on' }); // USE_PROXY unset → misconfigured
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://example.com', {})).rejects.toThrow(/browser proxy unavailable/);
    expect(cdpDirectCalls).toHaveLength(0);
    expect(launchCalls).toHaveLength(0);
  });

  it('delegated + WIGOLO_CDP_DIRECT=on: the rung is skipped; the proxied browser tier serves', async () => {
    setEnv({ [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: PROXY, WIGOLO_CDP_DIRECT: 'on' });
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://example.com', {});
    expect(res.html).not.toContain('cdp-direct-rung');
    expect(cdpDirectCalls).toHaveLength(0);
    expect(launchCalls.length).toBeGreaterThan(0);
    for (const c of launchCalls) expect((c.proxy as { server?: string })?.server).toContain('proxy.example.com:8080');
  });

  it('strict + WIGOLO_CDP_DIRECT=on: the rung still runs (upstream unchanged)', async () => {
    setEnv({ WIGOLO_CDP_DIRECT: 'on' });
    const res = await new MultiBrowserPool().fetchWithBrowser('https://example.com', {});
    expect(res.html).toContain('cdp-direct-rung');
    expect(cdpDirectCalls).toEqual(['https://example.com']);
  });

  it('strict: the same header is not treated as a proxy refusal (upstream unchanged)', async () => {
    navResponse = {
      status: 200,
      url: 'http://plain.example.test/',
      headers: { 'content-type': 'text/html', 'x-squid-error': 'ERR_ACCESS_DENIED 0' },
    };
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('http://plain.example.test/', {});
    expect(res.statusCode).toBe(200);
  });
});
