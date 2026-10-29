// halo: egress-proxy-ssrf — fork-only. The TLS tier hands wreq the egress proxy explicitly in
// delegated mode, refuses in misconfigured mode, and is unchanged in strict mode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/watch/ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/watch/ssrf.js')>();
  return { ...actual, guardResolvedHost: vi.fn(async () => ({ ok: true })) };
});

import { resetConfig } from '../../../src/config.js';
import { guardResolvedHost } from '../../../src/watch/ssrf.js';
import { tlsFetch, _setTlsBackendForTests, _resetTlsBackend } from '../../../src/fetch/tls-tier.js';
import { EGRESS_DELEGATION_ENV, __resetEgressForTests } from '../../../src/fetch/egress-proxy.js';

const PROXY = 'http://u:pw@wigolo-proxy:3128';
const BODY = `<html><body>${'real article text '.repeat(80)}</body></html>`;
const originalEnv = process.env;

type Hop = { url: string; init: Record<string, unknown> };
let hops: Hop[] = [];
let respond: (url: string) => { status: number; headers?: Record<string, string> };

function resp(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { entries: () => Object.entries(headers) },
    text: async () => BODY,
  };
}

beforeEach(() => {
  process.env = { ...originalEnv, LOG_LEVEL: 'error' };
  delete process.env[EGRESS_DELEGATION_ENV];
  hops = [];
  respond = () => ({ status: 200, headers: { 'content-type': 'text/html' } });
  _setTlsBackendForTests({
    fetch: vi.fn(async (url: string, init?: Record<string, unknown>) => {
      hops.push({ url, init: init ?? {} });
      const r = respond(url);
      return resp(r.status, r.headers);
    }),
  });
  vi.mocked(guardResolvedHost).mockClear();
  resetConfig();
});

afterEach(async () => {
  process.env = originalEnv;
  resetConfig();
  _setTlsBackendForTests(null);
  _resetTlsBackend();
  await __resetEgressForTests();
});

function delegate(): void {
  process.env[EGRESS_DELEGATION_ENV] = '1';
  process.env.USE_PROXY = 'true';
  process.env.PROXY_URL = PROXY;
  resetConfig();
}

// start (hostname) → public IP literal → second hostname → 200
const chain = (url: string) => {
  if (url.startsWith('https://start.example.test')) return { status: 302, headers: { location: 'http://93.184.216.34/mid' } };
  if (url.startsWith('http://93.184.216.34')) return { status: 301, headers: { location: 'https://end.example.test/' } };
  return { status: 200, headers: { 'content-type': 'text/html' } };
};

describe('tls-tier egress', () => {
  it('delegated: every hop, redirects and IP literals included, carries init.proxy', async () => {
    delegate();
    respond = chain;
    const r = await tlsFetch('https://start.example.test/');
    expect(r.statusCode).toBe(200);
    expect(hops.map((h) => h.url)).toEqual(['https://start.example.test/', 'http://93.184.216.34/mid', 'https://end.example.test/']);
    for (const h of hops) expect(h.init.proxy).toBe(PROXY);
    // The local resolved-IP guard still runs on every HOSTNAME hop.
    expect(vi.mocked(guardResolvedHost).mock.calls.map((c) => c[0])).toEqual(['start.example.test', 'end.example.test']);
  });

  it('strict: no proxy key at all, even with a proxy configured', async () => {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = PROXY;
    resetConfig();
    respond = chain;
    await tlsFetch('https://start.example.test/');
    expect(hops).toHaveLength(3);
    for (const h of hops) expect('proxy' in h.init).toBe(false);
  });

  it('misconfigured: throws before backend.fetch', async () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    resetConfig();
    await expect(tlsFetch('https://start.example.test/')).rejects.toThrow(/refusing to fetch/);
    expect(hops).toHaveLength(0);
  });

  it('delegated: x-squid-error on an http hop throws; on an https hop it is origin content', async () => {
    delegate();
    respond = () => ({ status: 403, headers: { 'x-squid-error': 'ERR_ACCESS_DENIED 0' } });
    await expect(tlsFetch('http://denied.example.test/')).rejects.toThrow(/egress proxy refused denied\.example\.test \(proxy status 403\)/);
    expect(hops).toHaveLength(1);
    const ok = await tlsFetch('https://tunnelled.example.test/');
    expect(ok.statusCode).toBe(403);
  });
});
