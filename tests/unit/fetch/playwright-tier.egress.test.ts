// halo: egress-proxy-ssrf — fork-only. The stealth daemon browser launches through the egress proxy
// in delegated mode, refuses in misconfigured mode, and keeps upstream's bare launch in strict mode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
// What the daemon page's main navigation answers.
const nav = vi.hoisted(() => ({ status: 200, url: 'https://example.com/', headers: {} as Record<string, string> }));
const WEBRTC_FLAG = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';

vi.mock('playwright', () => {
  const chromium = {
    // Any existing file satisfies detectPlaywrightInstall.
    executablePath: () => process.execPath,
    launch: vi.fn(async (opts: Record<string, unknown>) => {
      launchCalls.push(opts);
      return {
        newContext: vi.fn(async () => ({
          close: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            goto: vi.fn(async () => ({ status: () => nav.status, url: () => nav.url, headers: () => nav.headers })),
            content: vi.fn(async () => '<html><body>page body</body></html>'),
            evaluate: vi.fn(async () => 'page body'),
            close: vi.fn(async () => {}),
          })),
        })),
        close: vi.fn(async () => {}),
      };
    }),
  };
  return { chromium };
});

vi.mock('../../../src/fetch/settle.js', () => ({
  POST_GOTO_CAP_MS: 1000,
  settlePage: vi.fn(async () => ({ completeness: 'complete' })),
}));

import { resetConfig } from '../../../src/config.js';
import { getDaemonBrowser, closeDaemonBrowser, fetchWithPlaywright } from '../../../src/fetch/playwright-tier.js';
import { EGRESS_DELEGATION_ENV, __resetEgressForTests } from '../../../src/fetch/egress-proxy.js';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv, LOG_LEVEL: 'error' };
  delete process.env[EGRESS_DELEGATION_ENV];
  launchCalls.length = 0;
  Object.assign(nav, { status: 200, url: 'https://example.com/', headers: {} });
  resetConfig();
});
afterEach(async () => {
  await closeDaemonBrowser();
  process.env = originalEnv;
  resetConfig();
  await __resetEgressForTests();
});

describe('getDaemonBrowser egress', () => {
  it('delegated: passes the structured proxy option and a proxy-stripped env', async () => {
    Object.assign(process.env, {
      [EGRESS_DELEGATION_ENV]: '1',
      USE_PROXY: 'true',
      PROXY_URL: 'http://alice:s3cret@wigolo-proxy:3128',
      HTTPS_PROXY: 'http://alice:s3cret@wigolo-proxy:3128',
      HTTP_PROXY: 'http://alice:s3cret@wigolo-proxy:3128',
    });
    resetConfig();
    await getDaemonBrowser();
    expect(launchCalls).toHaveLength(1);
    const opts = launchCalls[0];
    expect(opts.headless).toBe(true);
    expect(opts.args).toEqual([WEBRTC_FLAG]); // WebRTC UDP is not covered by the proxy option
    expect(opts.proxy).toEqual({ server: 'http://wigolo-proxy:3128/', username: 'alice', password: 's3cret' });
    const env = opts.env as Record<string, string | undefined>;
    expect(env).toBeDefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  it('misconfigured: throws and never launches', async () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    resetConfig();
    await expect(getDaemonBrowser()).rejects.toThrow(/refusing to fetch/);
    expect(launchCalls).toHaveLength(0);
  });

  it('strict: launches with { headless: true } alone, even with a proxy configured', async () => {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://wigolo-proxy:3128';
    resetConfig();
    await getDaemonBrowser();
    expect(launchCalls).toEqual([{ headless: true }]);
  });

  it("delegated: squid's error page for an http:// navigation is a refusal, never content", async () => {
    Object.assign(process.env, { [EGRESS_DELEGATION_ENV]: '1', USE_PROXY: 'true', PROXY_URL: 'http://wigolo-proxy:3128' });
    resetConfig();
    Object.assign(nav, { status: 403, url: 'http://denied.example.test/', headers: { 'x-squid-error': 'ERR_ACCESS_DENIED 0' } });
    await expect(fetchWithPlaywright('http://denied.example.test/')).rejects.toThrow(
      /egress proxy refused denied\.example\.test \(proxy status 403, ERR_ACCESS_DENIED 0\)/,
    );
  });

  it('strict: the same header is not treated as a proxy refusal (upstream unchanged)', async () => {
    Object.assign(nav, { status: 200, url: 'http://plain.example.test/', headers: { 'x-squid-error': 'ERR_ACCESS_DENIED 0' } });
    const res = await fetchWithPlaywright('http://plain.example.test/');
    expect(res.html).toContain('page body');
  });
});
