// halo: egress-proxy-ssrf — fork-only. The daemon announces the egress mode at BOOT, so a
// misconfigured delegation shows up in the boot log instead of on the first fetch.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { EGRESS_DELEGATION_ENV, __resetEgressForTests } from '../../../src/fetch/egress-proxy.js';

vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../../src/fetch/browser-pool.js', () => {
  class MockMultiBrowserPool {
    shutdown = vi.fn().mockResolvedValue(undefined);
    fetchWithBrowser = vi.fn();
    getConfiguredTypes = vi.fn().mockReturnValue(['chromium']);
    getStats = vi.fn().mockReturnValue([]);
  }
  return { MultiBrowserPool: MockMultiBrowserPool, BrowserPool: MockMultiBrowserPool };
});

vi.mock('../../../src/fetch/router.js', () => ({
  SmartRouter: class MockSmartRouter {
    fetch = vi.fn();
    getDomainStats = vi.fn();
  },
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  resolveSearchBackend: vi.fn().mockResolvedValue({ type: 'scraping' }),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

import { DaemonHttpServer } from '../../../src/daemon/http-server.js';

const originalEnv = process.env;
let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-egress-boot-'));
  process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir };
  delete process.env[EGRESS_DELEGATION_ENV];
  delete process.env.USE_PROXY;
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;
  resetConfig();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = originalEnv;
  resetConfig();
  await __resetEgressForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

async function bootLog(): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
    lines.push(...String(c).split('\n').filter(Boolean));
    return true;
  }) as typeof process.stderr.write);
  const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
  try {
    await daemon.start();
  } finally {
    await daemon.stop();
  }
  return lines;
}

describe('daemon boot egress announcement', () => {
  it('a misconfigured delegation is logged once, at error level, during start() with no fetch made', async () => {
    process.env[EGRESS_DELEGATION_ENV] = '1'; // USE_PROXY unset → misconfigured
    resetConfig();
    const refusals = (await bootLog()).filter((l) => /refusing to fetch/.test(l));
    expect(refusals).toHaveLength(1);
    expect(JSON.parse(refusals[0]).level).toBe('error');
  });

  it('strict mode (flag unset) logs nothing about egress', async () => {
    const lines = await bootLog();
    expect(lines.some((l) => /egress/.test(l))).toBe(false);
  });
});
