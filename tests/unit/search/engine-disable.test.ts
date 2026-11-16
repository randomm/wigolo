/**
 * QS-4 — operator engine disable list (`WIGOLO_DISABLE_ENGINES` / config.json
 * `settings.disabledEngines`), plan Task 2.1:
 * docs/superpowers/plans/2026-11-14-wigolo-search-pool.md; design QS-4:
 * docs/superpowers/specs/2026-11-14-wigolo-search-pool-design.md. Cases (1)-(6)
 * are the QS-4 contract; (7)-(11) and (a)-(f) pin the rest of the contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getConfig,
  resetConfig,
  SEARCH_ENGINE_NAMES,
  type Config,
} from '../../../src/config.js';
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
 * non-deterministic: BRAVE_API_KEY adds a key-gated engine,
 * WIGOLO_MOJEEK_PROBE_ONLY flips `probeOnly`, WIGOLO_RSS_FEEDS attaches the
 * rss-feed engine to the news roster. LOG_LEVEL/LOG_FORMAT/WIGOLO_TUI_MODE are
 * pinned so the logger cannot swallow or redirect the warns these cases count.
 */
const MANAGED_ENV = [
  ENV_DISABLE,
  ENV_CONFIG_PATH,
  'WIGOLO_DATA_DIR',
  'BRAVE_API_KEY',
  'WIGOLO_MOJEEK_PROBE_ONLY',
  'WIGOLO_RSS_FEEDS',
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

/** warn-level disable-list telemetry only ("exactly ONE warn" cases). */
function warnTelemetry(lines: string[]): string[] {
  return lines.filter((l) => /warn/i.test(l) && /disable/i.test(l));
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

/**
 * Read the pinned interface, `config.searchDisabledEngines`. Deliberately
 * non-throwing: a missing/wrong-typed field shows up as the behavioural
 * asserts failing (an absent set can never satisfy a "must be disabled"
 * assert), never as a helper crash that hides the rest of the case.
 */
function disabledSet(): Set<string> {
  const cfg = getConfig() as Config & { searchDisabledEngines?: unknown };
  const value = cfg.searchDisabledEngines;
  // The type contract is still pinned here — a non-Set would otherwise be
  // silently coerced to empty and the behavioural asserts below would pass.
  expect(value, 'config.searchDisabledEngines must be a Set<string>').toBeInstanceOf(Set);
  return value as Set<string>;
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
  });

  it('(3) disable-all ⇒ error, roster left UNfiltered, ≥1 engine per vertical', () => {
    applyDisableList({ env: VALID_NAMES.join(',') });
    const cap = startCapture();

    // Never zero-engine: the roster is deliberately left UNfiltered.
    const general = getGeneralEngines();
    const news = getNewsEngines();
    expect(serializeRoster(general)).toEqual(GOLDEN_GENERAL);
    expect(serializeRoster(news)).toEqual(GOLDEN_NEWS);

    const errors = cap.lines().filter((l) => /error/i.test(l) && /engine/i.test(l));
    expect(
      errors.length,
      'disable-all must surface an error rather than empty the pool, got: ' +
        JSON.stringify(cap.lines()),
    ).toBeGreaterThanOrEqual(1);

    // The list can have come from either source, so the error names both.
    const errorText = errors.join('\n');
    expect(errorText).toContain('WIGOLO_DISABLE_ENGINES');
    expect(errorText).toContain('settings.disabledEngines');

    // The list itself is still parsed; only the roster is spared.
    expect([...disabledSet()].sort()).toEqual([...VALID_NAMES].sort());
  });

  it('(4) subset (`marginalia,mojeek`) ⇒ exactly those absent from general AND news, all others byte-equal', () => {
    applyDisableList({ env: 'marginalia,mojeek' });
    const cap = startCapture();

    const general = getGeneralEngines();
    const news = getNewsEngines();

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
    const fromFile = disabledSet();

    expect(serializeRoster(getGeneralEngines())).toEqual(
      GOLDEN_GENERAL.filter((e) => e.name !== 'mojeek'),
    );
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS.filter((e) => e.name !== 'mojeek'));

    // (b) env wins over config.json — and it REPLACES it, it does not merge.
    applyDisableList({ env: 'marginalia', settings: { disabledEngines: 'mojeek' } });
    const fromEnv = disabledSet();

    expect(rosterNames(getGeneralEngines())).toEqual(['bing', 'duckduckgo', 'wikipedia', 'mojeek']);
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);

    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `valid lists must emit no telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);

    expect(setHasName(fromFile, 'mojeek'), 'config.json settings.disabledEngines must apply').toBe(true);
    expect(setHasName(fromEnv, 'marginalia')).toBe(true);
    expect(
      setHasName(fromEnv, 'mojeek'),
      'env must override config.json, not union with it',
    ).toBe(false);
  });

  it('(6) normalization + memoization (` Bing ,, duckduckgo ,, ddgX `)', () => {
    applyDisableList({ env: ' Bing ,, duckduckgo ,, ddgX ' });
    const cap = startCapture();
    const set = disabledSet();

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

    // `ddgX` is the unknown token (`ddg` is not an alias); the empty token
    // between the doubled commas is not a token at all, so the list still
    // produces exactly one warn.
    // assert BEFORE trap section (trap's resetAll re-emits warns)
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

    expect(setHasName(set, 'bing')).toBe(true);
    expect(setHasName(set, 'duckduckgo')).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Operator-input edges (triage items 1-3)
  // ------------------------------------------------------------------------

  it('(7) defined-but-blank env counts as UNSET ⇒ config.json still applies', () => {
    applyDisableList({ env: '   ', settings: { disabledEngines: 'mojeek' } });
    const cap = startCapture();

    // The kill-switch must not be silently re-armed by an empty variable.
    expect(serializeRoster(getGeneralEngines())).toEqual(
      GOLDEN_GENERAL.filter((e) => e.name !== 'mojeek'),
    );
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS.filter((e) => e.name !== 'mojeek'));
    expect(disableTelemetry(cap.lines()), 'a blank env is not an operator error').toEqual([]);
    expect(setHasName(disabledSet(), 'mojeek')).toBe(true);
  });

  it('(8) non-string settings.disabledEngines ⇒ one warn naming key + typeof, value ignored', () => {
    const badValue: unknown = ['mojeek', 'bing'];
    applyDisableList({ env: null, settings: { disabledEngines: badValue } });
    const cap = startCapture();

    // Ignored, not honoured: neither silently nor partially.
    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);
    expect([...disabledSet()]).toEqual([]);

    const warns = warnTelemetry(cap.lines());
    expect(warns.length, `exactly one warn for the bad value, got: ${JSON.stringify(warns)}`).toBe(1);
    expect(warns[0]).toContain('settings.disabledEngines');
    expect(warns[0]).toContain(typeof badValue);
  });

  it('(9) warn hardening: unknown tokens are quoted, never echoed raw', () => {
    const forged = 'evil\n[wigolo] error: forged'; // < 40 chars ⇒ not truncated
    applyDisableList({ env: forged });
    const cap = startCapture();

    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);

    const warns = warnTelemetry(cap.lines());
    expect(warns.length, `exactly one warn line, got: ${JSON.stringify(warns)}`).toBe(1);
    expect(warns[0]).toContain(JSON.stringify(forged));
    // The raw control char must never split a second `[wigolo] error:` line.
    const forgedLines = cap.lines().join('').split('\n').filter((l) => /^\[wigolo\] error:/i.test(l));
    expect(forgedLines, `forged telemetry line emitted: ${JSON.stringify(forgedLines)}`).toEqual([]);
  });

  it('(10) warn hardening: each token display is capped at 40 chars', () => {
    applyDisableList({ env: `bingg,${'x'.repeat(60)}` });
    const cap = startCapture();

    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);

    const warns = warnTelemetry(cap.lines());
    expect(warns.length, `exactly one warn line, got: ${JSON.stringify(warns)}`).toBe(1);
    expect(warns[0]).toContain(JSON.stringify('x'.repeat(40)));
    expect(warns[0], 'token display must be truncated at 40 chars').not.toContain('x'.repeat(41));
  });

  it('(11) warn hardening: at most 10 tokens listed, remainder as …(+N more)', () => {
    const tokens = Array.from({ length: 13 }, (_, i) => `nope${i}`);
    applyDisableList({ env: tokens.join(',') });
    const cap = startCapture();

    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);

    const warns = warnTelemetry(cap.lines());
    expect(warns.length, `exactly one warn line, got: ${JSON.stringify(warns)}`).toBe(1);
    const line = warns[0] as string;
    expect(line).toContain(JSON.stringify('nope9'));
    expect(line).not.toContain(JSON.stringify('nope10'));
    expect(line).toContain('…(+3 more)');
  });

  // ------------------------------------------------------------------------
  // Mutant-kill cases (a)-(e) + the allow-list drift pin (f)
  // ------------------------------------------------------------------------

  it('(a) two unknown tokens ⇒ EXACTLY ONE warn line naming both', () => {
    applyDisableList({ env: 'bingg,ddgX' });
    const cap = startCapture();

    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);

    // One warn for the WHOLE list, not one per token.
    const warns = warnTelemetry(cap.lines());
    expect(warns.length, `exactly one warn for the whole list, got: ${JSON.stringify(warns)}`).toBe(1);
    expect(warns[0]).toContain('bingg');
    expect(warns[0]).toContain('ddgx');
  });

  it('(b) all-but-one of general disabled ⇒ sole survivor kept, zero error lines', () => {
    const survivor = 'marginalia';
    const rest = GOLDEN_GENERAL.map((e) => e.name).filter((n) => n !== survivor);
    applyDisableList({ env: rest.join(',') });
    const cap = startCapture();

    // One survivor is not zero survivors: the guard must not fire.
    expect(serializeRoster(getGeneralEngines())).toEqual(
      GOLDEN_GENERAL.filter((e) => e.name === survivor),
    );
    const errors = cap.lines().filter((l) => /error/i.test(l));
    expect(errors, `never-zero must not fire for one survivor: ${JSON.stringify(errors)}`).toEqual([]);
  });

  it('(c1) brave joins when BRAVE_API_KEY is set, and drops when named in the list', () => {
    process.env.BRAVE_API_KEY = 'test-key-not-a-real-credential';
    resetAll();
    expect(serializeRoster(getGeneralEngines())).toEqual([
      ...GOLDEN_GENERAL,
      { name: 'brave', weight: 1.1, quality: 'medium' },
    ]);

    applyDisableList({ env: 'brave' });
    const cap = startCapture();
    expect(serializeRoster(getGeneralEngines())).toEqual(GOLDEN_GENERAL);
    expect(
      disableTelemetry(cap.lines()),
      'a configured key-gated engine must be a valid disable-list name',
    ).toEqual([]);
  });

  it('(c2) rss-feed joins when WIGOLO_RSS_FEEDS is set, and drops when named in the list', () => {
    process.env.WIGOLO_RSS_FEEDS = 'https://example.com/feed.xml';
    resetAll();
    expect(serializeRoster(getNewsEngines())).toEqual([
      ...GOLDEN_NEWS,
      { name: 'rss-feed', weight: 1.5, quality: 'medium' },
    ]);

    applyDisableList({ env: 'rss-feed' });
    const cap = startCapture();
    expect(serializeRoster(getNewsEngines())).toEqual(GOLDEN_NEWS);
    expect(
      disableTelemetry(cap.lines()),
      'a configured key-gated engine must be a valid disable-list name',
    ).toEqual([]);
  });

  it('(d) doubled commas are not tokens: `bing,,brave` ⇒ 2 names, no "" in the warn', () => {
    applyDisableList({ env: 'bing,,brave' });
    const cap = startCapture();

    const set = disabledSet();
    expect(set.size, `empty gap must not become a token, got: ${JSON.stringify([...set])}`).toBe(2);
    expect(setHasName(set, 'bing')).toBe(true);
    expect(setHasName(set, 'brave')).toBe(true);

    // An empty gap is not an unknown token either: nothing to warn about.
    const warns = warnTelemetry(cap.lines());
    expect(warns, `empty gap reported as an unknown token: ${JSON.stringify(warns)}`).toEqual([]);
  });

  it('(e) the roster memo holds the FILTERED pool (resetConfig() alone must not un-filter it)', () => {
    applyDisableList({ env: 'mojeek' });
    const filtered = serializeRoster(getGeneralEngines());
    expect(filtered).toEqual(GOLDEN_GENERAL.filter((e) => e.name !== 'mojeek'));
    const filteredNews = serializeRoster(getNewsEngines());
    expect(filteredNews).toEqual(GOLDEN_NEWS.filter((e) => e.name !== 'mojeek'));

    // Drop ONLY the config memo — both roster memos stay populated — then clear
    // the disable list. Filtering at construction is what keeps it filtered.
    resetConfig();
    process.env[ENV_DISABLE] = '';
    expect(
      serializeRoster(getGeneralEngines()),
      'roster memo must hold the filtered pool, not re-filter per return',
    ).toEqual(filtered);
    expect(
      serializeRoster(getNewsEngines()),
      'news roster memo must hold the filtered pool too',
    ).toEqual(filteredNews);
    expect([...disabledSet()]).toEqual([]);
  });

  it('(f) SEARCH_ENGINE_NAMES equals the live union of both rosters', () => {
    process.env.BRAVE_API_KEY = 'test-key-not-a-real-credential';
    process.env.WIGOLO_RSS_FEEDS = 'https://example.com/feed.xml';
    resetAll();

    const live = [
      ...new Set([...rosterNames(getGeneralEngines()), ...rosterNames(getNewsEngines())]),
    ];
    expect(
      [...live].sort(),
      'the disable allow-list must equal the union of both verticals\' roster names',
    ).toEqual([...SEARCH_ENGINE_NAMES].sort());
  });
});
