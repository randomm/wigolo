/**
 * QS-4 coverage closure — the operator engine disable list
 * (`WIGOLO_DISABLE_ENGINES` / config.json `settings.disabledEngines`) must
 * apply to ALL SIX vertical roster builders, not just general + news.
 *
 * Today only `verticals/general.ts` and `verticals/news.ts` call
 * `filterDisabledEngines` at construction, and `SEARCH_ENGINE_NAMES` lists
 * only those two verticals' engine names. The four rosters built in
 * `code.ts`, `images.ts`, `docs.ts` and `papers.ts` therefore ignore the
 * operator's disable list entirely: an operator cannot take a key-gated
 * metered Brave (or any other engine) out of the code/images/docs/papers
 * pools even with WIGOLO_DISABLE_ENGINES set. This file is the RED for that
 * hole; the contract mirrors tests/unit/search/engine-disable.test.ts
 * (style model) for the general + news verticals.
 *
 * Engine names have NO aliases: each entry is matched exactly on the engine
 * class's registered `name` (e.g. `duckduckgo`, `bing_news`, `ddg-image`,
 * `brave-image`). Disabling `brave` must never take `brave-image` with it.
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
import {
  getCodeEngines,
  _resetCodeEnginesForTest,
} from '../../../src/search/core/verticals/code.js';
import {
  getImageEngines,
  _resetImageEnginesForTest,
} from '../../../src/search/core/verticals/images.js';
import {
  getDocsEngines,
  _resetDocsEnginesForTest,
} from '../../../src/search/core/verticals/docs.js';
import {
  getPapersEngines,
  _resetPapersEnginesForTest,
} from '../../../src/search/core/verticals/papers.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';

const ENV_DISABLE = 'WIGOLO_DISABLE_ENGINES';
const ENV_CONFIG_PATH = 'WIGOLO_CONFIG_PATH';

/**
 * Env vars this file owns. Each is saved/deleted in beforeEach and restored
 * in afterEach — several would otherwise make the "unset" goldens
 * non-deterministic: BRAVE_API_KEY adds brave (general + code) and
 * brave-image (images), WIGOLO_GITHUB_TOKEN adds github-code (code),
 * WIGOLO_RSS_FEEDS attaches rss-feed to news, WIGOLO_MOJEEK_PROBE_ONLY
 * flips `probeOnly`. LOG_LEVEL/LOG_FORMAT/WIGOLO_TUI_MODE are pinned so the
 * logger cannot swallow or redirect the telemetry these cases count.
 */
const MANAGED_ENV = [
  ENV_DISABLE,
  ENV_CONFIG_PATH,
  'WIGOLO_DATA_DIR',
  'BRAVE_API_KEY',
  'WIGOLO_GITHUB_TOKEN',
  'WIGOLO_MOJEEK_PROBE_ONLY',
  'WIGOLO_RSS_FEEDS',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'WIGOLO_TUI_MODE',
] as const;

const BRAVE_KEY = 'test-key-not-a-real-credential';
const GITHUB_TOKEN = 'test-token-not-a-real-credential';

// --------------------------------------------------------------------------
// Committed goldens: the keyless serialization of the four unfiltered
// rosters (names + weights + secondary + quality), roster order included.
// These are the regression gate: closing the coverage hole must not
// silently re-weight or reorder the default pools.
// --------------------------------------------------------------------------

type SerializedEntry = {
  name: string;
  weight?: number;
  secondary?: boolean;
  probeOnly?: boolean;
  quality?: string;
};

/** code.ts with NO github token and NO brave key. */
const GOLDEN_CODE: SerializedEntry[] = [
  { name: 'stackoverflow', weight: 1, quality: 'high' },
  { name: 'devdocs', weight: 0.6, quality: 'low' },
  { name: 'duckduckgo', weight: 0.8, quality: 'medium' },
  { name: 'mdn', weight: 0.3, secondary: true, quality: 'high' },
  { name: 'crates-io', weight: 0.3, secondary: true, quality: 'high' },
];

/** code.ts with token AND key: github-code leads, brave sits after duckduckgo. */
const GOLDEN_CODE_FULL: SerializedEntry[] = [
  { name: 'github-code', weight: 1.2, quality: 'medium' },
  ...GOLDEN_CODE.slice(0, 3),
  { name: 'brave', weight: 1, quality: 'medium' },
  ...GOLDEN_CODE.slice(3),
];

/** images.ts with NO brave key: the zero-key ddg-image floor alone. */
const GOLDEN_IMAGES: SerializedEntry[] = [
  { name: 'ddg-image', weight: 1.2 },
];

/** images.ts with the brave key: brave-image joins. */
const GOLDEN_IMAGES_FULL: SerializedEntry[] = [
  { name: 'ddg-image', weight: 1.2 },
  { name: 'brave-image', weight: 1.2 },
];

const GOLDEN_DOCS: SerializedEntry[] = [
  { name: 'mdn', weight: 1.2, quality: 'high' },
  { name: 'devdocs', weight: 0.8, quality: 'low' },
  { name: 'bing', weight: 0.7, secondary: true, quality: 'medium' },
  { name: 'duckduckgo', weight: 0.7, secondary: true, quality: 'medium' },
];

const GOLDEN_PAPERS: SerializedEntry[] = [
  { name: 'arxiv', weight: 1.1, quality: 'medium' },
  { name: 'semantic-scholar', weight: 1, quality: 'medium' },
  { name: 'openalex', weight: 0.8, secondary: true, quality: 'medium' },
  { name: 'dblp', weight: 0.7, secondary: true, quality: 'low' },
  { name: 'openreview', weight: 0.6, secondary: true, quality: 'medium' },
];

/** Every name an operator could legitimately disable, across ALL SIX verticals. */
const ALL_VERTICAL_NAMES: string[] = [
  ...new Set([
    'bing', 'duckduckgo', 'wikipedia', 'brave', 'mojeek', 'marginalia',
    'hn-algolia', 'lobsters', 'bing_news', 'rss-feed',
    'github-code', 'stackoverflow', 'devdocs', 'mdn', 'crates-io',
    'ddg-image', 'brave-image',
    'arxiv', 'semantic-scholar', 'openalex', 'dblp', 'openreview',
  ]),
];

// --------------------------------------------------------------------------
// Helpers (mirrors engine-disable.test.ts)
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
 * Capture everything the config/roster build writes to stderr AND stdout —
 * the logger emits to process.stderr in both formats, and config.ts also
 * writes bare `[wigolo] …` notes, so neither channel alone is authoritative.
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

/** The mandated reset: config memo + ALL SIX roster memos. */
function resetAll(): void {
  resetConfig();
  _resetGeneralEnginesForTest();
  _resetNewsEnginesForTest();
  _resetCodeEnginesForTest();
  _resetImageEnginesForTest();
  _resetDocsEnginesForTest();
  _resetPapersEnginesForTest();
}

/**
 * The mandated sequence for EVERY env flip: resetAll() → config.json fixture
 * write + env flip → resetAll(). The leading reset clears any memo the
 * previous case populated; the trailing one makes the flip visible to the
 * next getConfig()/get*Engines() call.
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

/** Read the pinned interface, `config.searchDisabledEngines`. */
function disabledSet(): Set<string> {
  const cfg = getConfig() as Config & { searchDisabledEngines?: unknown };
  const value = cfg.searchDisabledEngines;
  expect(value, 'config.searchDisabledEngines must be a Set<string>').toBeInstanceOf(Set);
  return value as Set<string>;
}

/** Build a roster with key-gated engines present (brave key + github token). */
function withKeys(): void {
  process.env.BRAVE_API_KEY = BRAVE_KEY;
  process.env.WIGOLO_GITHUB_TOKEN = GITHUB_TOKEN;
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
  tmp = mkdtempSync(join(tmpdir(), 'wigolo-engine-disable-vert-'));
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
// (a) The verified hole: a key-gated metered Brave in the code + images
// rosters must be disable-able, and exact-name matching must hold.
// --------------------------------------------------------------------------

describe('WIGOLO_DISABLE_ENGINES on code/images (brave key set)', () => {
  it('(a1) disable `brave` ⇒ absent from the code roster, survivors byte-equal', () => {
    withKeys();

    // Baseline sanity (env UNSET): with the key, brave IS in the code roster.
    resetAll();
    expect(serializeRoster(getCodeEngines())).toEqual(GOLDEN_CODE_FULL);

    applyDisableList({ env: 'brave' });
    const cap = startCapture();
    expect(
      serializeRoster(getCodeEngines()),
      'WIGOLO_DISABLE_ENGINES=brave must drop brave from the code roster',
    ).toEqual(GOLDEN_CODE_FULL.filter((e) => e.name !== 'brave'));

    // Exact-name matching: brave-image (a SEPARATE registered name) is a
    // different engine and must survive a bare `brave` disable.
    expect(
      serializeRoster(getImageEngines()),
      '`brave` must not take `brave-image` with it (no aliases, exact match)',
    ).toEqual(GOLDEN_IMAGES_FULL);

    // A wholly-valid list is not an operator error: no warn, no error.
    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `valid list must emit no telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);
  });

  it('(a2) disable `brave-image` ⇒ absent from the images roster, ddg-image byte-equal', () => {
    process.env.BRAVE_API_KEY = BRAVE_KEY;
    applyDisableList({ env: 'brave-image' });
    const cap = startCapture();

    expect(
      serializeRoster(getImageEngines()),
      'WIGOLO_DISABLE_ENGINES=brave-image must drop brave-image from the images roster',
    ).toEqual(GOLDEN_IMAGES);

    const noisy = disableTelemetry(cap.lines());
    expect(
      noisy,
      'a configured key-gated engine must be a valid disable-list name; got: ' +
        JSON.stringify(noisy),
    ).toEqual([]);

    expect(setHasName(disabledSet(), 'brave-image')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// (b) One secondary/primary engine per remaining vertical: the disable list
// must reach code, images, docs and papers rosters.
// --------------------------------------------------------------------------

describe('WIGOLO_DISABLE_ENGINES reaches every vertical roster', () => {
  it('(b1) disable `stackoverflow` + `crates-io` ⇒ both absent from code, others byte-equal', () => {
    applyDisableList({ env: 'stackoverflow,crates-io' });
    const cap = startCapture();

    expect(serializeRoster(getCodeEngines())).toEqual(
      GOLDEN_CODE.filter((e) => e.name !== 'stackoverflow' && e.name !== 'crates-io'),
    );
    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `valid list must emit no telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);
  });

  it('(b2) disable `mdn` ⇒ absent from BOTH the code and the docs rosters', () => {
    applyDisableList({ env: 'mdn' });
    const cap = startCapture();

    expect(
      serializeRoster(getCodeEngines()),
      'mdn must drop from the code roster (secondary engine)',
    ).toEqual(GOLDEN_CODE.filter((e) => e.name !== 'mdn'));
    expect(
      serializeRoster(getDocsEngines()),
      'mdn must drop from the docs roster (primary engine)',
    ).toEqual(GOLDEN_DOCS.filter((e) => e.name !== 'mdn'));

    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `valid list must emit no telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);
  });

  it('(b3) disable `ddg-image` (with brave key set) ⇒ images roster keeps only brave-image', () => {
    process.env.BRAVE_API_KEY = BRAVE_KEY;
    applyDisableList({ env: 'ddg-image' });
    const cap = startCapture();

    expect(
      serializeRoster(getImageEngines()),
      'ddg-image must drop from the images roster; brave-image remains (1 survivor ≠ 0)',
    ).toEqual(GOLDEN_IMAGES_FULL.filter((e) => e.name !== 'ddg-image'));

    // One survivor is not zero survivors: the never-zero guard must not fire.
    const errors = cap.lines().filter((l) => /error/i.test(l));
    expect(errors, `never-zero must not fire for one survivor: ${JSON.stringify(errors)}`).toEqual([]);
  });

  it('(b4) disable `devdocs` ⇒ absent from code AND docs rosters, others byte-equal', () => {
    applyDisableList({ env: 'devdocs' });

    expect(serializeRoster(getCodeEngines())).toEqual(
      GOLDEN_CODE.filter((e) => e.name !== 'devdocs'),
    );
    expect(serializeRoster(getDocsEngines())).toEqual(
      GOLDEN_DOCS.filter((e) => e.name !== 'devdocs'),
    );
  });

  it('(b5) disable `dblp` + `openreview` ⇒ both absent from papers, others byte-equal', () => {
    applyDisableList({ env: 'dblp,openreview' });
    const cap = startCapture();

    expect(
      serializeRoster(getPapersEngines()),
      'secondary papers engines must drop when named',
    ).toEqual(
      GOLDEN_PAPERS.filter((e) => e.name !== 'dblp' && e.name !== 'openreview'),
    );
    const noisy = disableTelemetry(cap.lines());
    expect(noisy, `valid list must emit no telemetry, got: ${JSON.stringify(noisy)}`).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// (c) Never-zero rule, per vertical: disabling a whole roster leaves it
// UNfiltered and surfaces an error — same contract as general/news.
// --------------------------------------------------------------------------

describe('never-zero rule on the four unfiltered verticals', () => {
  it('(c1) disable every code engine ⇒ roster left UNfiltered + error naming both sources', () => {
    withKeys();
    const allCode = ['github-code', 'stackoverflow', 'devdocs', 'duckduckgo', 'brave', 'mdn', 'crates-io'];
    applyDisableList({ env: allCode.join(',') });
    const cap = startCapture();

    expect(serializeRoster(getCodeEngines())).toEqual(GOLDEN_CODE_FULL);

    const errors = cap.lines().filter((l) => /error/i.test(l) && /engine/i.test(l));
    expect(
      errors.length,
      'disable-all must surface an error rather than empty the code pool, got: ' +
        JSON.stringify(cap.lines()),
    ).toBeGreaterThanOrEqual(1);
    const errorText = errors.join('\n');
    expect(errorText).toContain('WIGOLO_DISABLE_ENGINES');
    expect(errorText).toContain('settings.disabledEngines');
  });

  it('(c2) disable every papers engine ⇒ roster left UNfiltered + error', () => {
    const allPapers = GOLDEN_PAPERS.map((e) => e.name);
    applyDisableList({ env: allPapers.join(',') });
    const cap = startCapture();

    expect(serializeRoster(getPapersEngines())).toEqual(GOLDEN_PAPERS);

    const errors = cap.lines().filter((l) => /error/i.test(l) && /engine/i.test(l));
    expect(
      errors.length,
      'disable-all must surface an error rather than empty the papers pool, got: ' +
        JSON.stringify(cap.lines()),
    ).toBeGreaterThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------
// (d) Wholly-unknown token ⇒ rosters unchanged + exactly ONE warn that
// names every valid engine name — now across ALL SIX verticals.
// --------------------------------------------------------------------------

describe('unknown token against the four unfiltered verticals', () => {
  it('(d) `nope-engine` ⇒ all four rosters byte-equal to goldens, one warn listing every valid name', () => {
    applyDisableList({ env: 'nope-engine' });
    const cap = startCapture();

    expect(serializeRoster(getCodeEngines())).toEqual(GOLDEN_CODE);
    expect(serializeRoster(getImageEngines())).toEqual(GOLDEN_IMAGES);
    expect(serializeRoster(getDocsEngines())).toEqual(GOLDEN_DOCS);
    expect(serializeRoster(getPapersEngines())).toEqual(GOLDEN_PAPERS);

    const hits = cap.mentioning('nope-engine');
    expect(hits.length, `exactly one warn for the unknown token, got: ${JSON.stringify(hits)}`).toBe(1);
    expect(hits[0]).toMatch(/warn/i);
    const missing = ALL_VERTICAL_NAMES.filter((n) => !mentionsName(hits[0] as string, n));
    expect(
      missing,
      `the warn must list every valid engine name across all six verticals; missing from the message: ${missing.join(', ')}`,
    ).toEqual([]);

    // halo contract change: unknown tokens are KEPT in the set so they can
    // name plugin-loaded engines (whose names are not in the built-in
    // registry); inertness for built-ins is guaranteed by exact-name matching
    // — the byte-equal golden rosters above are that proof, not set emptiness.
    expect(setHasName(disabledSet(), 'nope-engine')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// (e) Drift pin: SEARCH_ENGINE_NAMES must equal the live union of ALL SIX
// verticals' registered engine names. Key-gated engines built into the
// rosters (brave/brave-image via BRAVE_API_KEY, github-code via
// WIGOLO_GITHUB_TOKEN, rss-feed via WIGOLO_RSS_FEEDS) so the union is complete.
// --------------------------------------------------------------------------

describe('SEARCH_ENGINE_NAMES drift pin (all six verticals)', () => {
  it('(e) allow-list deep-equals the union of every vertical roster', () => {
    withKeys();
    process.env.WIGOLO_RSS_FEEDS = 'https://example.com/feed.xml';
    resetAll();

    const live = [
      ...new Set([
        ...rosterNames(getGeneralEngines()),
        ...rosterNames(getNewsEngines()),
        ...rosterNames(getCodeEngines()),
        ...rosterNames(getImageEngines()),
        ...rosterNames(getDocsEngines()),
        ...rosterNames(getPapersEngines()),
      ]),
    ];
    expect(
      [...live].sort(),
      'the disable allow-list must equal the union of ALL SIX verticals\' roster names',
    ).toEqual([...SEARCH_ENGINE_NAMES].sort());
  });
});

// --------------------------------------------------------------------------
// (f) Same-process memoization guard: the roster memos must be invalidated
// by the resets (mirror of engine-disable.test.ts case (6) trap section).
// --------------------------------------------------------------------------

describe('memoization guard on the four unfiltered verticals', () => {
  it('(f) roster changes only WITH the resets; stays stale without them', () => {
    applyDisableList({ env: null });
    resetAll();

    // Populate all four memos from a clean baseline.
    const staleCode = serializeRoster(getCodeEngines());
    const staleDocs = serializeRoster(getDocsEngines());
    expect(staleCode).toEqual(GOLDEN_CODE);
    expect(staleDocs).toEqual(GOLDEN_DOCS);

    process.env[ENV_DISABLE] = 'mdn'; // flipped AFTER the reads above, no resets

    expect(
      serializeRoster(getCodeEngines()),
      'memoization trap: without the resets the code roster must NOT change',
    ).toEqual(staleCode);
    expect(
      serializeRoster(getDocsEngines()),
      'memoization trap: without the resets the docs roster must NOT change',
    ).toEqual(staleDocs);

    resetAll();
    expect(
      serializeRoster(getCodeEngines()),
      'with the resets the rebuilt code roster reflects the new disable list',
    ).toEqual(GOLDEN_CODE.filter((e) => e.name !== 'mdn'));
    expect(
      serializeRoster(getDocsEngines()),
      'with the resets the rebuilt docs roster reflects the new disable list',
    ).toEqual(GOLDEN_DOCS.filter((e) => e.name !== 'mdn'));
  });
});
