// halo: egress-proxy-ssrf — fork-only tests with a controlled resolver: delegation keeps the local
// resolved-IP guard for names that DO resolve, and a misconfigured delegation refuses before DNS.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() =>
  vi.fn((host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, addrs?: unknown) => void) => {
    const table: Record<string, { address: string; family: number }[]> = {
      'internal.test': [{ address: '10.0.0.5', family: 4 }],
      'mixed.test': [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    };
    const hit = table[host];
    if (hit) cb(null, hit);
    else cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
  }),
);

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, default: { ...actual, lookup }, lookup };
});

// The REST dispatcher pulls in every tool; only the fetch guard path is exercised here.
vi.mock('../../../src/tools/fetch.js', () => ({ handleFetch: vi.fn() }));
vi.mock('../../../src/tools/search.js', () => ({ handleSearch: vi.fn() }));
vi.mock('../../../src/tools/crawl.js', () => ({ handleCrawl: vi.fn() }));
vi.mock('../../../src/tools/cache.js', () => ({ handleCache: vi.fn() }));
vi.mock('../../../src/tools/extract.js', () => ({ handleExtract: vi.fn() }));
vi.mock('../../../src/tools/find-similar.js', () => ({ handleFindSimilar: vi.fn() }));
vi.mock('../../../src/tools/research.js', () => ({ handleResearch: vi.fn() }));
vi.mock('../../../src/tools/agent.js', () => ({ handleAgent: vi.fn() }));
vi.mock('../../../src/tools/diff.js', () => ({ handleDiff: vi.fn() }));
vi.mock('../../../src/tools/watch.js', () => ({ handleWatch: vi.fn() }));
vi.mock('../../../src/watch/scheduler.js', () => ({ scheduleOverdueCheck: vi.fn() }));

import { resetConfig } from '../../../src/config.js';
import { httpFetch } from '../../../src/fetch/http-client.js';
import { EGRESS_DELEGATION_ENV, __resetEgressForTests } from '../../../src/fetch/egress-proxy.js';
import { dispatchTool, type DispatchContext } from '../../../src/daemon/rest/dispatch.js';
import { handleFetch } from '../../../src/tools/fetch.js';
import type { Subsystems } from '../../../src/server.js';
import { FakeForwardProxy } from '../helpers/fake-forward-proxy.js';

const originalEnv = process.env;
let proxy: FakeForwardProxy;

beforeAll(async () => {
  proxy = await new FakeForwardProxy().start();
});
afterAll(async () => {
  await proxy.stop();
});
beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.LOG_LEVEL = 'error'; // quiet the once-per-test egress announcement
  proxy.hits.length = 0;
  lookup.mockClear();
  resetConfig();
});
afterEach(async () => {
  process.env = originalEnv;
  resetConfig();
  await __resetEgressForTests();
});

function delegate(): void {
  process.env[EGRESS_DELEGATION_ENV] = '1';
  process.env.USE_PROXY = 'true';
  process.env.PROXY_URL = proxy.url;
  resetConfig();
}

describe('delegated mode keeps the local resolved-IP guard', () => {
  it.each([
    ['internal.test', '10.0.0.5'],
    ['mixed.test', '169.254.169.254'],
  ])('%s is rejected with the existing reason and never reaches the proxy', async (host, bad) => {
    delegate();
    const err = await httpFetch(`http://${host}/`).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(new RegExp(`resolves to a blocked address \\(${bad.replace(/\./g, '\\.')}\\)`));
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    expect(proxy.hits).toHaveLength(0);
  });

  it('REST fetch still answers 400 ssrf_private_target for a privately-resolving name', async () => {
    delegate();
    const ctx = {
      subsystems: { searchEngines: [], router: {}, backendStatus: {} } as unknown as Subsystems,
      bindIsLoopback: true,
    } as DispatchContext;
    const r = await dispatchTool('fetch', { url: 'http://internal.test/' }, ctx);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('ssrf_private_target');
    expect(handleFetch).not.toHaveBeenCalled();
    expect(proxy.hits).toHaveLength(0);
  });
});

describe('misconfigured delegation', () => {
  it('refuses before any DNS lookup or socket (flag "1", USE_PROXY unset)', async () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    delete process.env.USE_PROXY;
    process.env.PROXY_URL = proxy.url;
    resetConfig();
    const err = await httpFetch('http://internal.test/').catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `egress proxy delegation requested (${EGRESS_DELEGATION_ENV}=1) but USE_PROXY is not true; refusing to fetch`,
    );
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(proxy.hits).toHaveLength(0);
  });
});
