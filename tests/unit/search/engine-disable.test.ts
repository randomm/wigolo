/**
 * QS-4 — operator-controlled engine disable list (`WIGOLO_DISABLE_ENGINES`).
 *
 * Plan: docs/superpowers/plans/2026-11-14-wigolo-search-pool.md, Task 2.1
 * (design: docs/superpowers/specs/2026-11-14-wigolo-search-pool-design.md, QS-4).
 * These are the six QS-4 cases, RED (no production code exists yet — the
 * green step implements them).
 *
 * Contract pinned here (verbatim from the task block's Interfaces paragraph):
 *   - `config.searchDisabledEngines: Set<string>` — parsed from
 *     `WIGOLO_DISABLE_ENGINES` (env) or config.json `settings.disabledEngines`
 *     (comma-separated), precedence env > config.json > default.
 *   - tokens trimmed + matched case-insensitively against REGISTERED engine
 *     names. The registered name is `duckduckgo` (src/search/engines/
 *     duckduckgo.ts:20) — `ddg` is NOT an alias and does not exist, so `ddgX`
 *     must land as the unknown token in case (6).
 *   - unknown token ⇒ EXACTLY ONE warn listing all valid names (emitted once
 *     at config-parse time in config.ts — a per-vertical emit would double
 *     count, which the "exactly one" clause forbids), and valid tokens in a
 *     MIXED list still apply; a wholly-unknown list is a no-op (a typo never
 *     silently drops a valid sibling);
 *   - disable-all ⇒ error + UNfiltered roster — the pool is never zero-engine;
 *   - unset ⇒ both verticals' serialization (names + weights + secondary +
 *     probeOnly + quality) deep-equals the committed golden below.
 *
 * Every env flip in this file is bracketed by the mandated triple reset —
 * `resetConfig()` (src/config.ts:830) + `_resetGeneralEnginesForTest()`
 * (verticals/general.ts:61) + `_resetNewsEnginesForTest()` (verticals/news.ts:79)
 * — so neither the config memo nor either vertical's roster memo
 * (general.ts:25-28) can leak across cases. The single deliberate exception is
 * case (6)'s memoization-trap leg, which the design requires: rebuild WITHOUT
 * resets ⇒ stale roster; WITH resets ⇒ the new roster. Even there the flip is
 * preceded by the triple reset (the roster is read once first, which is what
 * repopulates the memos the trap depends on).
 *
 * Telemetry shape the assertions accept (verified against a working
 * implementation): warn/error lines are counted from process.stderr AND
 * process.stdout, and a line counts as a warn when it matches /warn/i — so
 * either `log.warn(...)` (JSON `"level":"warn"` / text `WARN`) or a bare
 * `[wigolo] warn: …` note à la config.ts's existing reranker note passes.
 * Note for the implementer: `createLogger()` must NOT be called from inside
 * `getConfig()` — logger.ts:82 calls `getConfig()`, so doing that during the
 * config build recurses (RangeError) or reads an uninitialized memo; emit the
 * unknown-token warn from the parse path with `process.stderr.write` (or defer
 * it), and use the logger from the verticals (news.ts already does).
 *
 * The disable-all guard is asserted at its observable edge — error + a roster
 * that still holds every engine — rather than against a hardcoded registry
 * size, so the guard keeps working if a roster ever shrinks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig, type Config } from '../../../src/config.js';
import {
  getGeneralEngines,
  _resetGeneralEnginesForTest,
} from '../../../src/search/core/verticals/general.js';
import {
  getNewsEngines,
  _resetNewsEnginesForTest,
} from '../../../src/search/core/verticals/news.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';

const ENV_DISABLE = 'WIGOLO_DISABLE_ENGINES';
const ENV_CONFIG_PATH = 'WIGOLO_CONFIG_PATH';

/**
 * Env vars this file owns. Each is saved/deleted in beforeEach and restored in
 * afterEach — several of them would otherwise make the "unset" golden
 * non-deterministic: BRAVE_API_KEY adds a key-gated engine
 * (verticals/general.ts:53-55), WIGOLO_MOJEEK_PROBE_ONLY flips `probeOnly`
 * (config.ts:639), WIGOLO_RSS_FEEDS attaches the rss-feed engine to the news
 * roster (news.ts:64-73).
 */
const MANAGED_ENV = [
  ENV_DISABLE,
  ENV_CONFIG_PATH,
  'WIGOLO_DATA_DIR',
  'BRAVE_API_KEY',
  'WIGOLO_MOJEEK_PROBE_ONLY',
  'WIGOLO_RSS_FEEDS',
  // Telemetry observability: the logger writes to stderr unless WIGOLO_TUI_MODE
  // redirects it into a file, and LOG_LEVEL=error would swallow the warns these
  // cases count. Pin the defaults.
  'LOG_LEVEL',
  'LOG_FORMAT',
  'WIGOLO_TUI_MODE',
] as const;

// --------------------------------------------------------------------------
// Committed golden: the keyless, rss-less serialization of both rosters at
// HEAD (names + weights + secondary + probeOnly + quality), roster order
// included. Case (1) is the regression gate that stops the disable-list work
// from quietly altering the default pool.
// --------------------------------------------------------------------------

type SerializedEntry = {
  name: string;
  weight?: number;
  secondary?: boolean;
  probeOnly?: boolean;
  quality?: string;
};

const GOLDEN_GENERAL: SerializedEntry[] = [
  { name: 'bing', weight: 1, quality: 'medium' },
  { name: 'duckduckgo', weight: 1, quality: 'medium' },
  { name: 'wikipedia', weight: 0.6, quality: 'high' },
  { name: 'mojeek', weight: 0.8, secondary: true, probeOnly: true, quality: 'low' },
  { name: 'marginalia', weight: 0.6, secondary: true, quality: 'low' },
];

const GOLDEN_NEWS: SerializedEntry[] = [
  { name: 'hn-algolia', weight: 1.2, quality: 'medium' },
  { name: 'lobsters', weight: 1, quality: 'low' },
  { name: 'bing_news', weight: 0.9, quality: 'medium' },
  { name: 'duckduckgo', weight: 0.9, secondary: true, quality: 'medium' },
  { name: 'mojeek', weight: 0.7, secondary: true, probeOnly: true, quality: 'low' },
];

/** Every name an operator could legitimately disable (union of both rosters). */
const VALID_NAMES: string[] = [
  ...new Set([...GOLDEN_GENERAL.map((e) => e.name), ...GOLDEN_NEWS.map((e) => e.name)]),
];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function serializeRoster(entries: EngineEntry[]): SerializedEntry[] {
  return entries.map((e) => {
    const out: SerializedEntry = { name: e.engine.name, weight: e.weight };
    if (e.secondary !== undefined) out.secondary = e.secondary;
    if (e.probeOnly !== undefined) out.probeOnly = e.probeOnly;
    if (e.quality !== undefined) out.quality = e.quality;
    return out;
  });
}

function rosterNames(entries: EngineEntry[]): string[] {
  return entries.map((e) => e.engine.name);
}

/** Case-insensitive Set membership, tolerant of the stored token's casing. */
function setHasName(set: Set<string>, name: string): boolean {
  const needle = name.trim().toLowerCase();
  for (const raw of set) {
    if (String(raw).trim().toLowerCase() === needle) return true;
  }
  return false;
}

/** Whole-name match (so `bing` never matches inside `bing_news`). */
function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'i').test(text);
}

/**
 * Capture everything the config/roster build writes to stderr AND stdout — the
 * logger (src/logger.ts) emits to process.stderr in both json and text formats,
 * and config.ts also writes bare `[wigolo] …` notes, so neither channel alone
 * is authoritative.
 */
function startCapture(): {
  lines: () => string[];
  mentioning: (token: string) => string[];
} {
  const lines: string[] = [];
  const sink = (chunk: unknown): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  vi.spyOn(process.stderr, 'write').mockImplementation(sink);
  vi.spyOn(process.stdout, 'write').mockImplementation(sink);
  return {
    lines: () => lines.slice(),
    mentioning: (token: string) =>
      lines.filter((l) => l.toLowerCase().includes(token.toLowerCase())),
  };
}

/** Lines that carry disable-list telemetry at warn or error level. */
function disableTelemetry(lines: string[]): string[] {
  return lines.filter((l) => /warn|error/i.test(l) && /disable/i.test(l));
}

function configPath(): string {
  return process.env[ENV_CONFIG_PATH] as string;
}

function writeConfigJson(settings: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify({ version: 1, settings }), 'utf8');
}

/** The mandated triple reset (config memo + both roster memos). */
function resetAll(): void {
  resetConfig();
  _resetGeneralEnginesForTest();
  _resetNewsEnginesForTest();
}

/**
 * The mandated sequence for EVERY env flip in this file: triple reset →
 * config.json fixture write + env flip → triple reset. The leading reset is
 * what the task block demands ("every env flip preceded by resetConfig() +
 * _resetGeneralEnginesForTest() + _resetNewsEnginesForTest()"); the trailing
 * one makes the flip visible to the next getConfig()/get*Engines() call.
 */
function applyDisableList(opts: { env?: string | null; settings?: Record<string, unknown> }): void {
  resetAll();
  writeConfigJson(opts.settings ?? {});
  if (opts.env === undefined || opts.env === null) {
    delete process.env[ENV_DISABLE];
  } else {
    process.env[ENV_DISABLE] = opts.env;
  }
  resetAll();
}

/** Reads the interface the task block pins: `config.searchDisabledEngines: Set<string>`. */
function disabledSet(): Set<string> {
  const cfg = getConfig() as Config & { searchDisabledEngines?: unknown };
  expect(
    cfg.searchDisabledEngines,
    'config.searchDisabledEngines must be exposed as Set<string> (plan Task 2.1 Interfaces)',
  ).toBeInstanceOf(Set);
  return cfg.searchDisabledEngines as Set<string>;
}

/**
 * Non-throwing read of the same field, so a missing interface never masks the
 * behavioural assertions of a case (each test asserts on it at its end).
 */
function rawDisabled(): unknown {
  return (getConfig() as Config & { searchDisabledEngines?: unknown }).searchDisabledEngines;
}

// --------------------------------------------------------------------------
// Fixture lifecycle
// --------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmp = mkdtempSync(join(tmpdir(), 'wigolo-engine-disable-'));
  // Own the data dir: rss auto-attach reads <dataDir>/rss-feeds.json, and the
  // persisted-config read must come from a file this file fully controls.
  process.env.WIGOLO_DATA_DIR = join(tmp, 'data');
  mkdirSync(process.env.WIGOLO_DATA_DIR, { recursive: true });
  process.env[ENV_CONFIG_PATH] = join(tmp, 'config.json');
  writeConfigJson({});
  resetAll();
});

afterEach(() => {
  resetAll();
  vi.restoreAllMocks();
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// --------------------------------------------------------------------------
// QS-4's six cases
// --------------------------------------------------------------------------

describe('WIGOLO_DISABLE_ENGINES (QS-4)', () => {
  it('(1) unset ⇒ both rosters deep-equal the committed golden, no telemetry', () => {
    applyDisableList({ env: null, settings: {} });
    const cap = startCapture();

    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);

    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `unset must emit no disable-list telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);

    const set = disabledSet();
    expect([...set]).toEqual([]);
  });

  it('(2) wholly-unknown list (`bingg`) ⇒ exactly one warn listing valid names, rosters unchanged', () => {
    applyDisableList({ env: 'bingg' });
    const cap = startCapture();

    // A wholly-unknown list must not silently drop a valid sibling.
    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);

    const hits = cap.mentioning('bingg');
    expect(hits.length, `exactly one warn for the unknown token, got: ${JSON.stringify(hits)}`).toBe(1);
    expect(hits[0]).toMatch(/warn/i);
    const missing = VALID_NAMES.filter((n) => !mentionsName(hits[0] as string, n));
    expect(
      missing,
      `the warn must list every valid engine name; missing from the message: ${missing.join(', ')}`,
    ).toEqual([]);

    const set = disabledSet();
    expect(setHasName(set, 'bing')).toBe(false);
    expect(setHasName(set, 'bingg')).toBe(false);
  });

  it('(3) disable-all ⇒ error, roster left UNfiltered, ≥1 engine per vertical', () => {
    applyDisableList({ env: VALID_NAMES.join(',') });
    const cap = startCapture();

    // Never zero-engine: the roster is deliberately left UNfiltered.
    const general = getGeneralEngines();
    const news = getNewsEngines();
    expect(serializeRoster(general)).toEqual(GOLDEN_GENERAL);
    expect(serializeRoster(news)).toEqual(GOLDEN_NEWS);
    expect(general.length, 'general vertical must never be emptied').toBeGreaterThan(0);
    expect(news.length, 'news vertical must never be emptied').toBeGreaterThan(0);

    const errors = cap.lines().filter((l) => /error/i.test(l) && /engine/i.test(l));
    expect(
      errors.length,
      'disable-all must surface an error rather than empty the pool, got: ' +
        JSON.stringify(cap.lines()),
    ).toBeGreaterThanOrEqual(1);

    // The interface still has to exist; its contents are moot here precisely
    // because the roster was left unfiltered.
    disabledSet();
  });

  it('(4) subset (`marginalia,mojeek`) ⇒ exactly those absent from general AND news, all others byte-equal', () => {
    applyDisableList({ env: 'marginalia,mojeek' });
    const cap = startCapture();

    const general = getGeneralEngines();
    const news = getNewsEngines();
    expect(rosterNames(general)).not.toContain('marginalia');
    expect(rosterNames(general)).not.toContain('mojeek');
    expect(rosterNames(news)).not.toContain('mojeek');
    expect(rosterNames(news)).not.toContain('marginalia');

    // Survivors are byte-equal to their golden twins (same fields, same order).
    const kept = (name: string) => (e: SerializedEntry) => e.name !== name;
    expect(serializeRoster(general)).toEqual(
      GOLDEN_GENERAL.filter(kept('marginalia')).filter(kept('mojeek')),
    );
    expect(serializeRoster(news)).toEqual(GOLDEN_NEWS.filter(kept('mojeek')));

    // A wholly-valid list is not an operator error: no warn, no error.
    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `valid list must emit no telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);

    const set = disabledSet();
    expect(setHasName(set, 'marginalia')).toBe(true);
    expect(setHasName(set, 'mojeek')).toBe(true);
    expect(setHasName(set, 'bing')).toBe(false);
  });

  it('(5) precedence ⇒ config.json alone applies, env overrides config.json', () => {
    // (a) config.json alone: settings.disabledEngines.
    applyDisableList({ env: null, settings: { disabledEngines: 'mojeek' } });
    const cap = startCapture();
    const fromFile = rawDisabled();

    expect(serializeRoster(getGeneralEngines())).toEqual(
      GOLDEN_GENERAL.filter((e) => e.name !== 'mojeek'),
    );
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS.filter((e) => e.name !== 'mojeek'));

    // (b) env wins over config.json — and it REPLACES it, it does not merge.
    applyDisableList({ env: 'marginalia', settings: { disabledEngines: 'mojeek' } });
    const fromEnv = rawDisabled();

    expect(rosterNames(getGeneralEngines())).toEqual(['bing', 'duckduckgo', 'wikipedia', 'mojeek']);
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);

    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `valid lists must emit no telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);

    expect(fromFile, 'config.searchDisabledEngines must be a Set<string>').toBeInstanceOf(Set);
    expect(fromEnv, 'config.searchDisabledEngines must be a Set<string>').toBeInstanceOf(Set);
    expect(setHasName(fromFile as Set<string>, 'mojeek'), 'config.json settings.disabledEngines must apply').toBe(true);
    expect(setHasName(fromEnv as Set<string>, 'marginalia')).toBe(true);
    expect(
      setHasName(fromEnv as Set<string>, 'mojeek'),
      'env must override config.json, not union with it',
    ).toBe(false);
  });

  it('(6) normalization + memoization (` Bing ,, duckduckgo ,, ddgX `)', () => {
    applyDisableList({ env: ' Bing ,, duckduckgo ,, ddgX ' });
    const cap = startCapture();
    const normalized = rawDisabled();

    const general = getGeneralEngines();
    const news = getNewsEngines();
    // Trimmed + case-insensitive: ' Bing ' and ' duckduckgo ' both match.
    expect(serializeRoster(general)).toEqual(
      GOLDEN_GENERAL.filter((e) => e.name !== 'bing' && e.name !== 'duckduckgo'),
    );
    // Exact matching, not prefix matching: `bing` must NOT take `bing_news`
    // with it, and duckduckgo is filtered from news too.
    expect(serializeRoster(news)).toEqual(GOLDEN_NEWS.filter((e) => e.name !== 'duckduckgo'));
    expect(rosterNames(news)).toContain('bing_news');

    // `ddgX` is the unknown token (`ddg` is not an alias — engines/duckduckgo.ts:20);
    // the empty token between the doubled commas is not a token at all, so the
    // list still produces exactly one warn.
    const hits = cap.mentioning('ddgX');
    expect(hits.length, `exactly one warn naming ddgX, got: ${JSON.stringify(hits)}`).toBe(1);
    expect(hits[0]).toMatch(/warn/i);
    const missing = VALID_NAMES.filter((n) => !mentionsName(hits[0] as string, n));
    expect(
      missing,
      `the warn must list every valid engine name; missing: ${missing.join(', ')}`,
    ).toEqual([]);

    // --- memoization trap (design QS-4 target) ---------------------------
    // Rebuilding the rosters after an env flip WITHOUT the resets must keep
    // serving the stale memo; WITH them, the new roster appears. The flip is
    // still preceded by the mandated triple reset — the reads below are what
    // repopulate the memos the trap depends on.
    resetAll();
    const beforeStale = serializeRoster(getGeneralEngines());
    expect(beforeStale).toEqual(GOLDEN_GENERAL.filter((e) => e.name !== 'bing' && e.name !== 'duckduckgo'));
    const staleNews = serializeRoster(getNewsEngines());

    process.env[ENV_DISABLE] = 'wikipedia'; // flipped after the resetAll() above

    expect(
      serializeRoster(getGeneralEngines()),
      'memoization trap: without the resets the roster must NOT change',
    ).toEqual(beforeStale);
    expect(serializeRoster(getNewsEngines())).toEqual(staleNews);

    resetAll();
    expect(
      serializeRoster(getGeneralEngines()),
      'with the resets the rebuilt roster reflects the new disable list',
    ).toEqual(GOLDEN_GENERAL.filter((e) => e.name !== 'wikipedia'));
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);

    expect(normalized, 'config.searchDisabledEngines must be a Set<string>').toBeInstanceOf(Set);
    const set = normalized as Set<string>;
    expect(setHasName(set, 'bing')).toBe(true);
    expect(setHasName(set, 'duckduckgo')).toBe(true);
    expect(setHasName(set, 'ddg')).toBe(false);
  });
});
