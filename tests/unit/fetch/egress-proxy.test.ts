// halo: egress-proxy-ssrf — fork-only tests for the egress-mode predicate, the refusal classifier
// and the npm-undici ProxyAgent / Node bundled-fetch pairing the patch depends on.
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyAgent } from 'undici';
import { getConfig, resetConfig, type Config } from '../../../src/config.js';
import {
  EGRESS_DELEGATION_ENV,
  __resetEgressForTests,
  announceEgressMode,
  egressBrowserLaunchHardening,
  egressDelegationRequested,
  egressMode,
  isEgressPolicyError,
  proxyRefusal,
  squidErrorRefusal,
} from '../../../src/fetch/egress-proxy.js';
import { FakeForwardProxy } from '../helpers/fake-forward-proxy.js';

const P = 'http://wigolo-proxy:3128';

type Line = { level: string; msg: string };
let lines: Line[] = [];
let raw = '';

function cfgWith(over: Partial<Config> = {}): Config {
  return {
    ...getConfig(),
    useProxy: true,
    proxyUrl: P,
    proxyBypassOnChallenge: false,
    browserChannel: 'chromium',
    browserHeadful: false,
    fetchAllowPrivate: false,
    cdpDirect: 'off',
    cdpUrl: null,
    scrapingBrowserWss: null,
    ...over,
  };
}

/** Env with every advisory satisfied, so a test can break exactly one. */
function envWith(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { [EGRESS_DELEGATION_ENV]: '1', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: P, HTTPS_PROXY: P, ...over };
}

beforeEach(() => {
  resetConfig();
  lines = [];
  raw = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    const s = String(chunk);
    raw += s;
    for (const l of s.split('\n').filter(Boolean)) {
      try {
        lines.push(JSON.parse(l) as Line);
      } catch {
        /* not a logger line */
      }
    }
    return true;
  }) as typeof process.stderr.write);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetConfig();
  await __resetEgressForTests();
});

describe('egressMode — activation', () => {
  it.each([undefined, '', '0'])('flag %j → strict, even with USE_PROXY and PROXY_URL set', (v) => {
    expect(egressMode(cfgWith(), envWith({ [EGRESS_DELEGATION_ENV]: v }))).toEqual({ kind: 'strict' });
    expect(egressDelegationRequested({ [EGRESS_DELEGATION_ENV]: v })).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it('"1" with a valid http proxy → delegated, display without userinfo', () => {
    const m = egressMode(cfgWith({ proxyUrl: 'http://u:p@h:3128' }), envWith({ HTTP_PROXY: 'http://h:3128', HTTPS_PROXY: 'http://h:3128' }));
    expect(m).toEqual({ kind: 'delegated', proxyUrl: 'http://u:p@h:3128', display: 'http://h:3128/' });
  });

  const misconfigured: Array<[string, Partial<Config>, Record<string, string | undefined>, RegExp]> = [
    ['flag "true"', {}, { [EGRESS_DELEGATION_ENV]: 'true' }, /must be exactly "1"/],
    ['flag "yes"', {}, { [EGRESS_DELEGATION_ENV]: 'yes' }, /must be exactly "1"/],
    ['flag " 1"', {}, { [EGRESS_DELEGATION_ENV]: ' 1' }, /must be exactly "1"/],
    ['useProxy false', { useProxy: false }, {}, /USE_PROXY is not true/],
    ['proxyUrl null', { proxyUrl: null }, {}, /PROXY_URL is not set/],
    ['proxyUrl unparseable', { proxyUrl: 'not a url' }, {}, /unparseable/],
    ['https proxy', { proxyUrl: 'https://u:secretpw@h:3128' }, {}, /scheme must be http:/],
    ['socks5 proxy', { proxyUrl: 'socks5://u:secretpw@h:1080' }, {}, /scheme must be http:/],
    ['socks5h proxy', { proxyUrl: 'socks5h://h:1080' }, {}, /scheme must be http:/],
    ['proxy with a path', { proxyUrl: 'http://u:secretpw@h:3128/x' }, {}, /host:port/],
    ['proxy with a query', { proxyUrl: 'http://h:3128/?a=1' }, {}, /host:port/],
    ['proxyBypassOnChallenge', { proxyBypassOnChallenge: true }, {}, /BYPASS_ON_CHALLENGE/],
    // Full Chrome / headful Chromium ignore the WebRTC launch switch (STUN / TURN UDP past squid).
    ['browserChannel chrome', { browserChannel: 'chrome' }, {}, /BROWSER_CHANNEL/],
    ['browserChannel auto', { browserChannel: 'auto' }, {}, /BROWSER_CHANNEL/],
    ['browserHeadful', { browserHeadful: true }, {}, /BROWSER_HEADFUL/],
  ];

  it.each(misconfigured)('%s → misconfigured with a specific reason', (_n, cfg, env, re) => {
    const m = egressMode(cfgWith(cfg), envWith(env));
    expect(m.kind).toBe('misconfigured');
    const reason = (m as { reason: string }).reason;
    expect(reason).toMatch(re);
    // No reason string ever carries the credentials.
    expect(reason).not.toMatch(/secretpw/);
    expect(raw).not.toMatch(/secretpw/);
    expect(egressDelegationRequested(envWith(env))).toBe(true);
  });

  const advisories: Array<[string, Partial<Config>, Record<string, string | undefined>, RegExp]> = [
    ['cdpDirect auto', { cdpDirect: 'auto' }, {}, /CDP_DIRECT/],
    ['cdpUrl set', { cdpUrl: 'http://127.0.0.1:9222' }, {}, /CDP_URL/],
    ['scrapingBrowserWss set', { scrapingBrowserWss: 'wss://u:secretpw@sb.example:9222' }, {}, /SCRAPING_BROWSER_WSS/],
    ['fetchAllowPrivate', { fetchAllowPrivate: true }, {}, /ALLOW_PRIVATE/],
    ['NODE_USE_ENV_PROXY unset', {}, { NODE_USE_ENV_PROXY: undefined }, /NODE_USE_ENV_PROXY/],
    ['HTTPS_PROXY origin differs', {}, { HTTPS_PROXY: 'http://other:3128' }, /HTTP\(S\)_PROXY/],
  ];

  it('the advisory baseline itself produces no warning', () => {
    expect(egressMode(cfgWith(), envWith()).kind).toBe('delegated');
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0);
  });

  it.each(advisories)('%s → still delegated, exactly one warning, no throw', (_n, cfg, env, re) => {
    expect(egressMode(cfgWith(cfg), envWith(env)).kind).toBe('delegated');
    const warns = lines.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(re);
    expect(raw).not.toMatch(/secretpw/);
  });
});

describe('announceEgressMode', () => {
  it('delegated: info once per process, with the redacted proxy only', () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://u:secretpw@h:3128';
    try {
      resetConfig();
      announceEgressMode();
      announceEgressMode();
      egressMode();
      const infos = lines.filter((l) => l.level === 'info');
      expect(infos).toHaveLength(1);
      expect(infos[0].msg).toContain('delegated to proxy http://h:3128/');
      expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);
      expect(raw).not.toMatch(/secretpw/);
    } finally {
      delete process.env[EGRESS_DELEGATION_ENV];
      delete process.env.USE_PROXY;
      delete process.env.PROXY_URL;
    }
  });

  it('misconfigured: error once per process (first egressMode() call announces lazily)', () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    try {
      resetConfig();
      egressMode();
      egressMode();
      announceEgressMode();
      const errors = lines.filter((l) => l.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].msg).toMatch(/USE_PROXY is not true; refusing to fetch/);
    } finally {
      delete process.env[EGRESS_DELEGATION_ENV];
    }
  });

  it('strict: logs nothing', () => {
    announceEgressMode();
    egressMode();
    expect(lines).toHaveLength(0);
  });
});

describe('proxyRefusal', () => {
  const squid = () => new Response('<html>denied</html>', { status: 403, headers: { 'X-Squid-Error': 'ERR_ACCESS_DENIED 0' } });

  it('x-squid-error on an http target is a refusal; on an https target it is not', () => {
    expect(proxyRefusal(squid(), 'http://example.org/')).toEqual({ status: 403, detail: 'ERR_ACCESS_DENIED 0' });
    expect(proxyRefusal(squid(), 'https://example.org/')).toBeNull();
    expect(proxyRefusal(new Response('ok'), 'http://example.org/')).toBeNull();
  });

  it('recognises undici CONNECT and 407 errors anywhere in the cause chain', () => {
    const connect = new TypeError('fetch failed', { cause: new Error('Proxy response (403) !== 200 when HTTP Tunneling') });
    expect(proxyRefusal(connect, 'https://x.test/')).toEqual({ status: 403, detail: 'CONNECT refused' });
    const auth = new TypeError('fetch failed', { cause: new Error('Proxy Authentication Required (407)') });
    expect(proxyRefusal(auth, 'http://x.test/')).toEqual({ status: 407, detail: 'proxy auth' });
  });

  it('unrelated errors are not refusals', () => {
    expect(proxyRefusal(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }), 'http://x.test/')).toBeNull();
    expect(proxyRefusal(undefined, 'http://x.test/')).toBeNull();
    expect(proxyRefusal('boom', 'http://x.test/')).toBeNull();
  });
});

describe('squidErrorRefusal (browser-tier half of proxyRefusal)', () => {
  it('only an http:// target with an x-squid-error value is a refusal', () => {
    expect(squidErrorRefusal('http://x.test/', 403, 'ERR_ACCESS_DENIED 0')).toEqual({ status: 403, detail: 'ERR_ACCESS_DENIED 0' });
    expect(squidErrorRefusal('https://x.test/', 403, 'ERR_ACCESS_DENIED 0')).toBeNull();
    expect(squidErrorRefusal('http://x.test/', 403, undefined)).toBeNull();
    expect(squidErrorRefusal('not a url', 403, 'ERR_ACCESS_DENIED 0')).toBeNull();
    expect(squidErrorRefusal('http://x.test/', 503, `ERR_DNS_FAIL\r\n${'x'.repeat(100)}`)?.detail).toHaveLength(64);
  });
});

describe('isEgressPolicyError', () => {
  it('matches refusals and misconfiguration, not ordinary fetch failures', () => {
    expect(isEgressPolicyError(new Error('egress proxy refused x.test (proxy status 403, ERR_ACCESS_DENIED 0)'))).toBe(true);
    expect(isEgressPolicyError(new Error('egress proxy delegation requested (X=1) but USE_PROXY is not true; refusing to fetch'))).toBe(true);
    expect(isEgressPolicyError(new Error('fetch failed'))).toBe(false);
    expect(isEgressPolicyError('egress proxy refused')).toBe(false);
  });
});

describe('egressBrowserLaunchHardening (WebRTC is not covered by the Playwright proxy option)', () => {
  it('chromium: no non-proxied UDP', () => {
    expect(egressBrowserLaunchHardening('chromium')).toEqual({
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
  });
  it('firefox: RTCPeerConnection disabled', () => {
    expect(egressBrowserLaunchHardening('firefox').firefoxUserPrefs).toMatchObject({ 'media.peerconnection.enabled': false });
  });
  it('webkit: refused (no switch keeps its WebRTC on the proxy)', () => {
    expect(() => egressBrowserLaunchHardening('webkit')).toThrow(/webkit browser launch refused/);
  });
});

// Spec test 28: npm-undici ProxyAgent({proxyTunnel:false}) as `dispatcher` to Node's BUNDLED fetch.
// The two undici copies differ in version, so this pins the pairing the http tier relies on.
describe('npm-undici ProxyAgent through Node bundled fetch', () => {
  const tlsDir = fileURLToPath(new URL('../../fixtures/tls/', import.meta.url));
  const cert = readFileSync(`${tlsDir}localhost-cert.pem`);
  const key = readFileSync(`${tlsDir}localhost-key.pem`);
  let proxy: FakeForwardProxy;
  let origin: HttpsServer;
  let originPort = 0;

  beforeAll(async () => {
    origin = createHttpsServer({ cert, key }, (_q, r) => r.end('tls-origin'));
    await new Promise<void>((res) => origin.listen(0, '127.0.0.1', () => res()));
    originPort = (origin.address() as { port: number }).port;
    proxy = await new FakeForwardProxy().start();
    proxy.answer = (hit) => (hit.method === 'CONNECT' ? { status: 200, tunnelTo: originPort } : { status: 200, body: 'via-proxy' });
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((res) => origin.close(() => res()));
  });

  it('runs on a Node whose bundled fetch accepts an external dispatcher (24.x, or >= 22.21)', () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    expect(maj > 22 || (maj === 22 && min >= 21)).toBe(true);
  });

  it('http target → absolute-form request line, no CONNECT; https target → CONNECT :port, TLS through the tunnel', async () => {
    const agent = new ProxyAgent({ uri: proxy.url, proxyTunnel: false, requestTls: { ca: cert } });
    try {
      const r1 = await fetch('http://plain.example.test/a?b=1', { dispatcher: agent } as RequestInit);
      expect(await r1.text()).toBe('via-proxy');
      const r2 = await fetch(`https://localhost:${originPort}/`, { dispatcher: agent } as RequestInit);
      expect(await r2.text()).toBe('tls-origin');
    } finally {
      await agent.close();
    }
    expect(proxy.hits.map((h) => `${h.method} ${h.target}`)).toEqual([
      'GET http://plain.example.test/a?b=1',
      `CONNECT localhost:${originPort}`,
    ]);
  });
});
