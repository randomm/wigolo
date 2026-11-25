import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import {
  cdpDirectFetch,
  sweepOrphanCdpChildren,
  _setCdpDirectFetchDepsForTests,
  _setProcessKillForTests,
  _setOrphanSweepDepsForTests,
  _resetOrphanSweepForTests,
  type CdpDirectFetchDeps,
  type CdpTransport,
  type OrphanSweepDeps,
} from '../../../src/fetch/cdp-direct.js';

/**
 * Boot orphan sweep (Phase 0, Task 0.4(c)). The raw-CDP rung spawns Chrome
 * `detached: true` (own process group) and tears it down in a `finally`. When
 * wigolo itself is SIGKILLed — the OOM killer is exactly the Phase 0 pressure
 * regime — that finally never runs, and every group it had spawned survives as
 * an orphan holding a profile dir and (under load) hundreds of MB each, across
 * restarts. The sweep finds processes whose cmdline carries our unique
 * `--user-data-dir=<tmp>/wigolo-cdp-direct-*` marker AND whose parent is init
 * (ppid 1 — i.e. truly reparented, never a live rung's child of this process),
 * and SIGKILLs them. It runs ONCE per process, on first use of the rung.
 */

function proc(cmdline: string, ppid: number): { cmdline: string; ppid: number } {
  return { cmdline, ppid };
}

const OUR_MARKER = '--user-data-dir=/tmp/wigolo-cdp-direct-abc123';

function fakeSweep(procs: Record<number, { cmdline: string; ppid: number }>, selfPid: number) {
  const killed: Array<{ pid: number; signal: string }> = [];
  const deps: OrphanSweepDeps = {
    listPids: () => Object.keys(procs).map(Number),
    readCmdline: (pid) => procs[pid]?.cmdline ?? null,
    readPpid: (pid) => procs[pid]?.ppid ?? null,
    kill: (pid, signal) => {
      killed.push({ pid, signal: String(signal) });
    },
  };
  return { deps, killed };
}

describe('cdp-direct boot orphan sweep (Task 0.4c)', () => {
  it('kills only our orphaned (reparented-to-init) chrome processes', () => {
    const { deps, killed } = fakeSweep(
      {
        1: proc('/init', 0),
        100: proc('node /app/dist/index.js', 99), // unrelated process
        201: proc(`/usr/bin/chrome ${OUR_MARKER} --type=zygote`, 1), // OURS, orphaned
        202: proc(`/usr/bin/chrome ${OUR_MARKER} --type=renderer`, 1), // OURS, orphaned child
        203: proc('/usr/bin/chrome --user-data-dir=/home/u/genuine-profile', 1), // not ours
        204: proc(`/usr/bin/chrome ${OUR_MARKER} --type=gpu-process`, 100), // ours but LIVE parent — never touch
      },
      100,
    );
    const killedPids = sweepOrphanCdpChildren(deps, 100);
    expect(killedPids.sort()).toEqual([201, 202]);
    expect(killed).toEqual([
      { pid: 201, signal: 'SIGKILL' },
      { pid: 202, signal: 'SIGKILL' },
    ]);
  });

  it('skips itself, init, and unreadable /proc entries; never throws', () => {
    const procs: Record<number, { cmdline: string; ppid: number }> = {
      1: proc('/init', 0),
      50: proc(`/usr/bin/chrome ${OUR_MARKER}`, 1), // == selfPid, must be skipped
      51: proc(`/usr/bin/chrome ${OUR_MARKER}`, 1), // killed
    };
    const deps: OrphanSweepDeps = {
      listPids: () => [1, 50, 51, 52, 53],
      readCmdline: (pid) => {
        if (pid === 52) throw new Error('EACCES'); // vanished mid-scan
        if (pid === 53) return null; // unreadable
        return procs[pid]?.cmdline ?? '';
      },
      readPpid: (pid) => procs[pid]?.ppid ?? 1,
      kill: () => {},
    };
    expect(() => sweepOrphanCdpChildren(deps, 50)).not.toThrow();
    expect(sweepOrphanCdpChildren(deps, 50)).toEqual([51]);
  });

  it('a sweep failure never breaks the rung, and runs at most once per process', async () => {
    resetConfig();
    const h = { navigated: [] as string[] };
    const transport: CdpTransport = {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Page.navigate') {
          h.navigated.push(String(params?.url));
          return { frameId: 'F1' };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Runtime.evaluate') {
          const expr = String(params?.expression ?? '');
          if (expr.includes('location')) return { result: { type: 'string', value: 'https://example.com/' } };
          return { result: { type: 'string', value: '<html><body>' + 'x'.repeat(2000) + '</body></html>' } };
        }
        if (method === 'Browser.getVersion') return { userAgent: 'Mozilla/5.0 Chrome/151.0.7922.72' };
        return {};
      }),
      close: vi.fn(async () => {}),
    };
    const fetchDeps: CdpDirectFetchDeps = {
      resolveChrome: () => '/fake/chrome',
      spawn: () => ({ pid: 4242, on: vi.fn(), kill: vi.fn(), exitCode: 0, signalCode: null } as never),
      isReachable: async () => true,
      mkdtemp: async (p: string) => p + 'tmp',
      rm: async () => {},
      connectTransport: async () => transport,
    };
    let listCalls = 0;
    const sweep = fakeSweep({}, 1);
    const countingDeps: OrphanSweepDeps = {
      ...sweep.deps,
      listPids: () => {
        listCalls++;
        return sweep.deps.listPids();
      },
    };

    _setProcessKillForTests(() => {});
    _setCdpDirectFetchDepsForTests(fetchDeps);
    _setOrphanSweepDepsForTests(countingDeps);
    _resetOrphanSweepForTests();
    try {
      const r1 = await cdpDirectFetch('https://a.example/');
      expect(r1).not.toBeNull();
      const r2 = await cdpDirectFetch('https://b.example/');
      expect(r2).not.toBeNull();
      expect(h.navigated.length).toBe(2); // both rungs worked
      expect(listCalls).toBe(1); // swept once, not per-fetch
    } finally {
      _setCdpDirectFetchDepsForTests(undefined);
      _setProcessKillForTests(undefined);
      _setOrphanSweepDepsForTests(undefined);
      _resetOrphanSweepForTests();
    }
  });
});
