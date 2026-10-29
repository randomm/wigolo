// halo: egress-proxy-ssrf — fork-only tests: http-client in strict vs delegated egress mode,
// against a fake forward proxy shaped like squid.
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyAgent } from 'undici';
import { resetConfig } from '../../../src/config.js';
import { httpFetch } from '../../../src/fetch/http-client.js';
import {
  EGRESS_DELEGATION_ENV,
  __resetEgressForTests,
  __setMaxHttpOriginsForTests,
  egressMode,
  egressProxyDispatcher,
} from '../../../src/fetch/egress-proxy.js';
import { FakeForwardProxy } from '../helpers/fake-forward-proxy.js';

const originalEnv = process.env;
let proxy: FakeForwardProxy;
let target: Server;
let targetPort = 0;
let targetHits = 0;

beforeAll(async () => {
  proxy = await new FakeForwardProxy().start();
  target = createServer((_q, r) => {
    targetHits++;
    r.end('direct-hit');
  });
  await new Promise<void>((res) => target.listen(0, '127.0.0.1', () => res()));
  targetPort = (target.address() as { port: number }).port;
});

afterAll(async () => {
  await proxy.stop();
  await new Promise<void>((res) => target.close(() => res()));
});

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.LOG_LEVEL = 'error'; // quiet the once-per-test egress announcement
  delete process.env[EGRESS_DELEGATION_ENV];
  proxy.hits.length = 0;
  proxy.connections = 0;
  proxy.answer = (hit) => (hit.method === 'CONNECT' ? { status: 403 } : { status: 200, body: 'via-proxy' });
  targetHits = 0;
  resetConfig();
});

afterEach(async () => {
  process.env = originalEnv;
  vi.restoreAllMocks();
  resetConfig();
  await __resetEgressForTests();
});

function delegate(proxyUrl = proxy.url): void {
  process.env[EGRESS_DELEGATION_ENV] = '1';
  process.env.USE_PROXY = 'true';
  process.env.PROXY_URL = proxyUrl;
  resetConfig();
}

describe('strict mode: a configured proxy alone relaxes nothing', () => {
  beforeEach(() => {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = proxy.url;
    resetConfig();
  });

  it('refuses a hostname that produced no validated addresses, without touching the proxy', async () => {
    const err = await httpFetch('http://nothing-resolves-here.invalid/').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/refusing to connect without pinning/i);
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    expect(proxy.hits).toHaveLength(0);
  }, 30000);

  it('a hostname that resolves is still fetched directly (pinned), not via the proxy', async () => {
    const res = await httpFetch(`http://localhost:${targetPort}/`);
    expect(res.html).toBe('direct-hit');
    expect(proxy.hits).toHaveLength(0);
  }, 30000);
});

describe('delegated mode', () => {
  it('an http target the container cannot resolve goes absolute-form through the proxy, no CONNECT', async () => {
    delegate();
    const res = await httpFetch('http://nothing-resolves-here.invalid/x');
    expect(res.statusCode).toBe(200);
    expect(res.html).toBe('via-proxy');
    expect(proxy.hits.map((h) => `${h.method} ${h.target}`)).toEqual(['GET http://nothing-resolves-here.invalid/x']);
  }, 30000);

  it('an https target is CONNECTed to :443; a refused CONNECT is a non-retryable egress refusal', async () => {
    delegate();
    const err = await httpFetch('https://nothing-resolves-here.invalid/').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/egress proxy refused/);
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    expect(proxy.hits.map((h) => `${h.method} ${h.target}`)).toEqual(['CONNECT nothing-resolves-here.invalid:443']);
  }, 30000);

  it('a squid 403 page on an http target is rejected, never returned as content', async () => {
    delegate();
    proxy.answer = () => ({ status: 403, headers: { 'X-Squid-Error': 'ERR_ACCESS_DENIED 0' }, body: '<html>Access Denied</html>' });
    const err = await httpFetch('http://denied.example.test/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/egress proxy refused denied\.example\.test \(proxy status 403, ERR_ACCESS_DENIED 0\)/);
    expect((err as Error).message).not.toContain('Access Denied</html>');
    expect(proxy.hits).toHaveLength(1);
  }, 30000);

  it('a squid 503 ERR_DNS_FAIL is rejected and NOT retried (503 is otherwise retryable)', async () => {
    delegate();
    proxy.answer = () => ({ status: 503, headers: { 'X-Squid-Error': 'ERR_DNS_FAIL 0' }, body: 'dns fail' });
    const err = await httpFetch('http://gone.example.test/').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/egress proxy refused .*503, ERR_DNS_FAIL 0/);
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    expect(proxy.hits).toHaveLength(1);
  }, 30000);

  it('a proxied 302 to the metadata literal is blocked by the literal guard after one proxy hit', async () => {
    delegate();
    proxy.answer = () => ({ status: 302, headers: { Location: 'http://169.254.169.254/latest' } });
    const err = await httpFetch('http://start.example.test/').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^Redirect blocked/);
    expect(proxy.hits).toHaveLength(1);
  }, 30000);

  it('a proxied 302 to another public host goes through the proxy again', async () => {
    delegate();
    proxy.answer = (hit) =>
      hit.target.includes('start.')
        ? { status: 302, headers: { Location: 'http://next.example.test/landing' } }
        : { status: 200, body: 'landed' };
    const res = await httpFetch('http://start.example.test/');
    expect(res.html).toBe('landed');
    expect(res.finalUrl).toBe('http://next.example.test/landing');
    expect(proxy.hits.map((h) => h.target)).toEqual(['http://start.example.test/', 'http://next.example.test/landing']);
  }, 30000);

  it.each([
    ['default env', {}],
    ['NO_PROXY=* and NODE_USE_ENV_PROXY unset', { NO_PROXY: '*', no_proxy: '*', NODE_USE_ENV_PROXY: undefined }],
  ])('a loopback IP literal goes through the proxy, never direct (%s)', async (_n, env) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delegate();
    const res = await httpFetch(`http://127.0.0.1:${targetPort}/`);
    expect(res.html).toBe('via-proxy');
    expect(proxy.hits.map((h) => h.target)).toEqual([`http://127.0.0.1:${targetPort}/`]);
    expect(targetHits).toBe(0);
  }, 30000);

  it('sequential and concurrent fetches share ONE ProxyAgent that is not closed while in use', async () => {
    delegate();
    const m = egressMode();
    if (m.kind !== 'delegated') throw new Error('expected delegated');
    const agent = egressProxyDispatcher(m) as ProxyAgent;
    // Instance spies: a prototype spy would also count another test's agent settling its close.
    const destroy = vi.spyOn(agent, 'destroy');
    const close = vi.spyOn(agent, 'close');
    await httpFetch('http://one.example.test/');
    await httpFetch('http://two.example.test/');
    await Promise.all([httpFetch('http://three.example.test/'), httpFetch('http://four.example.test/')]);
    expect(egressProxyDispatcher(m)).toBe(agent);
    expect(proxy.hits).toHaveLength(4);
    expect(destroy).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  }, 30000);

  it('proxy credentials travel only as Proxy-Authorization and never reach the logs', async () => {
    let logged = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
      logged += String(c);
      return true;
    }) as typeof process.stderr.write);
    process.env.LOG_LEVEL = 'debug';
    delegate(`http://u:p%40ss@127.0.0.1:${proxy.port}`);
    const res = await httpFetch('http://cred.example.test/');
    expect(res.html).toBe('via-proxy');
    expect(proxy.hits[0].proxyAuthorization).toBe(`Basic ${Buffer.from('u:p@ss').toString('base64')}`);
    expect(logged).toContain('delegated to proxy'); // the announce ran, so the check below is meaningful
    expect(logged).not.toContain('p%40ss');
    expect(logged).not.toContain('p@ss');
    expect(logged).not.toContain('u:p');
  }, 30000);

  // undici never drops an http-origin entry from a ProxyAgent({proxyTunnel:false}) (its wrapper
  // emits no 'disconnect'); white-box read of that map, so the bound below is measured, not assumed.
  function retainedOrigins(d: unknown): number {
    const sym = (o: object, desc: string) => Object.getOwnPropertySymbols(o).find((x) => x.description === desc)!;
    const inner = (d as Record<symbol, object>)[sym(d as object, 'proxy agent')];
    return ((inner as Record<symbol, Map<string, unknown>>)[sym(inner, 'clients')]).size;
  }

  it('distinct http origins do not accumulate without bound: the shared agent is retired at the cap', async () => {
    delegate();
    __setMaxHttpOriginsForTests(4);
    const m = egressMode();
    if (m.kind !== 'delegated') throw new Error('expected delegated');
    const first = egressProxyDispatcher(m);
    for (let i = 0; i < 13; i++) {
      const res = await httpFetch(`http://origin-${i}.example.test/`);
      expect(res.html).toBe('via-proxy');
      expect(retainedOrigins(egressProxyDispatcher(m))).toBeLessThanOrEqual(4);
    }
    expect(egressProxyDispatcher(m)).not.toBe(first);
    expect(proxy.hits).toHaveLength(13);
  }, 30000);

  it('distinct http origins share ONE Pool (one keep-alive connection) to the proxy', async () => {
    delegate();
    const m = egressMode();
    if (m.kind !== 'delegated') throw new Error('expected delegated');
    const agent = egressProxyDispatcher(m);
    for (let i = 0; i < 6; i++) {
      expect((await httpFetch(`http://pool-${i}.example.test/`)).html).toBe('via-proxy');
    }
    expect(egressProxyDispatcher(m)).toBe(agent);
    expect(proxy.hits).toHaveLength(6);
    // A Pool per origin would open one connection per origin here.
    expect(proxy.connections).toBe(1);
  }, 30000);

  it('a retired agent is closed after a grace period via close(), never a direct destroy()', async () => {
    delegate();
    __setMaxHttpOriginsForTests(1);
    const m = egressMode();
    if (m.kind !== 'delegated') throw new Error('expected delegated');
    const old = egressProxyDispatcher(m) as ProxyAgent;
    await httpFetch('http://only.example.test/'); // the one http origin the cap allows
    const close = vi.spyOn(old, 'close');
    const destroy = vi.spyOn(old, 'destroy');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      expect(egressProxyDispatcher(m)).not.toBe(old);
      expect(close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_000);
      expect(close).toHaveBeenCalled(); // close() re-enters itself with a callback, so no exact count
      expect(destroy).not.toHaveBeenCalled(); // undici's own close→destroy step has not run yet
    } finally {
      vi.useRealTimers();
    }
    // Let the close settle inside this test, so its trailing destroy() never lands in the next one.
    await vi.waitFor(() => expect(old.destroyed).toBe(true));
  }, 30000);

  it('the dispatcher is looked up per hop: a redirect after the cap lands on the new agent', async () => {
    delegate();
    __setMaxHttpOriginsForTests(1);
    const m = egressMode();
    if (m.kind !== 'delegated') throw new Error('expected delegated');
    const first = egressProxyDispatcher(m) as ProxyAgent;
    const firstDispatch = vi.spyOn(first, 'dispatch');
    proxy.answer = (hit) =>
      hit.target.includes('a.example.test')
        ? { status: 302, headers: { Location: 'http://b.example.test/' } }
        : { status: 200, body: 'landed' };
    const res = await httpFetch('http://a.example.test/');
    expect(res.html).toBe('landed');
    expect(proxy.hits.map((h) => h.target)).toEqual(['http://a.example.test/', 'http://b.example.test/']);
    // Hop 1 filled the first agent to its cap, so hop 2 must have looked up (and used) a fresh one;
    // a lookup hoisted out of the redirect loop would put both origins on the retired agent.
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(retainedOrigins(first)).toBe(1);
  }, 30000);
});
