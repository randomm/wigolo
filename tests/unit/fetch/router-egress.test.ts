// halo: egress-proxy-ssrf — fork-only. Router side paths: no direct-egress challenge retry and no
// escape-hatch rung while delegation is requested, and the PDF probe uses the egress proxy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

// Report the engine "ready" without a real install so browser-tier paths reach the mocked pool.
vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

import { SmartRouter, defaultPdfProbe } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface, BrowserFetchArgs } from '../../../src/fetch/router.js';
import { ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';
import { EGRESS_DELEGATION_ENV, __resetEgressForTests } from '../../../src/fetch/egress-proxy.js';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv, LOG_LEVEL: 'error' };
  delete process.env[EGRESS_DELEGATION_ENV];
  resetConfig();
});
afterEach(async () => {
  process.env = originalEnv;
  vi.restoreAllMocks();
  resetConfig();
  await __resetEgressForTests();
});

describe('retryDirectOnChallenge under delegation', () => {
  async function run(flag: string | undefined): Promise<BrowserFetchArgs[]> {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://proxy.example.com:8080';
    process.env.WIGOLO_PROXY_BYPASS_ON_CHALLENGE = 'true';
    if (flag !== undefined) process.env[EGRESS_DELEGATION_ENV] = flag;
    resetConfig();
    const calls: BrowserFetchArgs[] = [];
    const fetchWithBrowser = vi.fn(async (url: string, opts: BrowserFetchArgs = {}) => {
      calls.push(opts);
      throw new ChallengeBlockedError(url, undefined, undefined, 403);
    });
    const router = new SmartRouter({
      httpClient: { fetch: vi.fn() } as HttpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    return calls;
  }

  it('MUST-PASS control: without the flag the bypass knob still retries direct once', async () => {
    const calls = await run(undefined);
    expect(calls.filter((c) => c.forceNoProxy === true)).toHaveLength(1);
  });

  it.each(['1', 'yes'])('flag %j: never retries with forceNoProxy (bypass knob forced on)', async (flag) => {
    const calls = await run(flag);
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.forceNoProxy === true)).toBe(false);
  });
});

describe('escape-hatch rungs under delegation', () => {
  async function run(flag: string | undefined) {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://proxy.example.com:8080';
    process.env.WIGOLO_SOLVER_URL = 'http://solver.example.com:8191/v1';
    process.env.WIGOLO_HOSTED_READER_URL = 'https://reader.example.com/';
    if (flag !== undefined) process.env[EGRESS_DELEGATION_ENV] = flag;
    resetConfig();
    const solverFetch = vi.fn(async () => null);
    const hostedReaderFetch = vi.fn(async () => null);
    const router = new SmartRouter({
      httpClient: { fetch: vi.fn() } as HttpClient,
      browserPool: {
        fetchWithBrowser: vi.fn(async (url: string) => {
          throw new ChallengeBlockedError(url, undefined, undefined, 403);
        }),
      } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
      escapeHatch: { solverFetch, hostedReaderFetch },
    });
    const res = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    return { res, solverFetch, hostedReaderFetch };
  }

  it('MUST-PASS control: without the flag a challenge block tries the solver, then the hosted reader', async () => {
    const { solverFetch, hostedReaderFetch } = await run(undefined);
    expect(solverFetch).toHaveBeenCalledTimes(1);
    expect(hostedReaderFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['1', 'yes'])('flag %j: a challenge block never reaches either escape-hatch fetcher', async (flag) => {
    const { res, solverFetch, hostedReaderFetch } = await run(flag);
    expect(solverFetch).not.toHaveBeenCalled();
    expect(hostedReaderFetch).not.toHaveBeenCalled();
    expect(res).toMatchObject({ error: 'blocked_by_challenge' });
  });
});

describe('defaultPdfProbe egress', () => {
  function pdfFetch() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(null, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
  }

  it('delegated: passes the proxy dispatcher on the probe', async () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://127.0.0.1:3128';
    resetConfig();
    const f = pdfFetch();
    expect(await defaultPdfProbe('http://doc.example.test/a.pdf')).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0][1] as Record<string, unknown>).dispatcher).toBeDefined();
  });

  it('delegated: a squid refusal on the probe is a probe failure, not a PDF verdict', async () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://127.0.0.1:3128';
    resetConfig();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('denied', { status: 403, headers: { 'content-type': 'application/pdf', 'x-squid-error': 'ERR_ACCESS_DENIED 0' } }),
    );
    expect(await defaultPdfProbe('http://doc.example.test/a.pdf')).toBe(false);
  });

  it('misconfigured: returns false without fetching', async () => {
    process.env[EGRESS_DELEGATION_ENV] = '1';
    resetConfig();
    const f = pdfFetch();
    expect(await defaultPdfProbe('http://doc.example.test/a.pdf')).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('strict: no dispatcher key (upstream unchanged)', async () => {
    const f = pdfFetch();
    expect(await defaultPdfProbe('http://doc.example.test/a.pdf')).toBe(true);
    expect('dispatcher' in (f.mock.calls[0][1] as Record<string, unknown>)).toBe(false);
  });
});

describe('HTTP-tier egress refusals do not escalate to the browser', () => {
  function router(err: Error) {
    const fetchWithBrowser = vi.fn(async () => {
      throw new Error('browser must not be reached');
    });
    const httpFetch = vi.fn(async () => {
      throw err;
    });
    const r = new SmartRouter({
      httpClient: { fetch: httpFetch } as unknown as HttpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    return { r, httpFetch, fetchWithBrowser };
  }

  it('repeated refusals past the browser-fallback threshold never mark preferPlaywright or reach the browser', async () => {
    const { r, httpFetch, fetchWithBrowser } = router(
      new Error('egress proxy refused refused.example.test (proxy status 403, ERR_ACCESS_DENIED 0)'),
    );
    for (let i = 0; i < 5; i++) {
      await expect(r.fetch('http://refused.example.test/')).rejects.toThrow(/egress proxy refused/);
    }
    expect(httpFetch).toHaveBeenCalledTimes(5);
    expect(fetchWithBrowser).not.toHaveBeenCalled();
    expect(r.getDomainStats('refused.example.test')?.preferPlaywright ?? false).toBe(false);
    expect(r.getDomainStats('refused.example.test')?.failureCount ?? 0).toBe(0);
  });

  it('MUST-PASS control: an ordinary failure still escalates at the threshold', async () => {
    const { r, fetchWithBrowser } = router(new Error('socket hang up'));
    for (let i = 0; i < 3; i++) await r.fetch('http://flaky.example.test/').catch(() => {});
    expect(fetchWithBrowser).toHaveBeenCalled();
    expect(r.getDomainStats('flaky.example.test')?.preferPlaywright).toBe(true);
  });
});
