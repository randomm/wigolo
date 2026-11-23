// Engine-policy surfacing tests (REQ-4 pre-work).
//
// WHY: "which engines are actually active" must be operator-visible without
// reading env — getEnginePolicy() is the machine-readable view (effective
// disable list + key-gated optional engines), and doctor renders it right
// under the engine-health summary. These tests pin: (1) the operator disable
// list is reflected, (2) each optional engine is active IFF its key/feed is
// configured (and not disabled), (3) the fail-safe shape when everything is
// unset, and (4) the view NEVER leaks secret values — names and booleans only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEnginePolicy,
  type EnginePolicy,
} from '../../../src/search/core/engine-health.js';
import { formatEnginePolicyLines } from '../../../src/cli/doctor.js';
import { resetConfig } from '../../../src/config.js';
import { _resetGeneralEnginesForTest } from '../../../src/search/core/verticals/general.js';
import { _resetImageEnginesForTest } from '../../../src/search/core/verticals/images.js';
import { _resetCodeEnginesForTest } from '../../../src/search/core/verticals/code.js';
import { _resetNewsEnginesForTest } from '../../../src/search/core/verticals/news.js';

const OPTIONAL_NAMES = ['brave', 'brave-image', 'github-code', 'rss-feed'] as const;

describe('getEnginePolicy', () => {
  const origEnv = process.env;

  // Start every case from "nothing configured": no keys, no feeds, no
  // operator disable list. WIGOLO_DATA_DIR is sandboxed by tests/setup.ts,
  // so no user config.json / rss-feeds.json can leak in.
  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.BRAVE_API_KEY;
    delete process.env.WIGOLO_GITHUB_TOKEN;
    delete process.env.WIGOLO_RSS_FEEDS;
    delete process.env.WIGOLO_DISABLE_ENGINES;
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetImageEnginesForTest();
    _resetCodeEnginesForTest();
    _resetNewsEnginesForTest();
  });

  afterEach(() => {
    process.env = origEnv;
    resetConfig();
    _resetGeneralEnginesForTest();
    _resetImageEnginesForTest();
    _resetCodeEnginesForTest();
    _resetNewsEnginesForTest();
  });

  function activeOf(policy: EnginePolicy, name: string): boolean | undefined {
    return policy.optional_engines.find((e) => e.name === name)?.active;
  }

  it('fail-safe: everything unset still yields the full sensible shape', () => {
    const policy = getEnginePolicy();
    expect(Array.isArray(policy.disabled)).toBe(true);
    expect(policy.disabled).toEqual([]);
    expect(policy.optional_engines.map((e) => e.name).sort()).toEqual(
      [...OPTIONAL_NAMES].sort(),
    );
    // Nothing is configured in this sandbox, so nothing is active.
    for (const name of OPTIONAL_NAMES) {
      expect(activeOf(policy, name)).toBe(false);
    }
  });

  it('reflects the operator disable list (WIGOLO_DISABLE_ENGINES) sorted', () => {
    process.env.WIGOLO_DISABLE_ENGINES = 'ddg-image,brave';
    resetConfig();
    const policy = getEnginePolicy();
    expect(policy.disabled).toEqual(['brave', 'ddg-image']);
  });

  it('marks brave/brave-image active only when BRAVE_API_KEY is set', () => {
    const before = getEnginePolicy();
    expect(activeOf(before, 'brave')).toBe(false);
    expect(activeOf(before, 'brave-image')).toBe(false);

    process.env.BRAVE_API_KEY = 'test-key';
    resetConfig();
    const after = getEnginePolicy();
    expect(activeOf(after, 'brave')).toBe(true);
    expect(activeOf(after, 'brave-image')).toBe(true);
    // Unrelated engines are unaffected by the Brave key.
    expect(activeOf(after, 'github-code')).toBe(false);
    expect(activeOf(after, 'rss-feed')).toBe(false);
  });

  it('marks github-code active only when WIGOLO_GITHUB_TOKEN is set', () => {
    expect(activeOf(getEnginePolicy(), 'github-code')).toBe(false);
    process.env.WIGOLO_GITHUB_TOKEN = 'test-token';
    resetConfig();
    expect(activeOf(getEnginePolicy(), 'github-code')).toBe(true);
  });

  it('marks rss-feed active when feeds are configured (env feeds)', () => {
    expect(activeOf(getEnginePolicy(), 'rss-feed')).toBe(false);
    process.env.WIGOLO_RSS_FEEDS = 'https://feeds.example.com/news.xml';
    resetConfig();
    expect(activeOf(getEnginePolicy(), 'rss-feed')).toBe(true);
  });

  it('an optional engine configured BUT operator-disabled is not active', () => {
    process.env.BRAVE_API_KEY = 'test-key';
    process.env.WIGOLO_DISABLE_ENGINES = 'brave';
    resetConfig();
    const policy = getEnginePolicy();
    expect(policy.disabled).toContain('brave');
    expect(activeOf(policy, 'brave')).toBe(false);
    // The sibling sharing the same key stays active — the disable list is
    // per-engine, not per-key.
    expect(activeOf(policy, 'brave-image')).toBe(true);
  });

  it('never leaks secret values — the view carries names and booleans only', () => {
    process.env.BRAVE_API_KEY = 'SECRET-BRAVE-VALUE';
    process.env.WIGOLO_GITHUB_TOKEN = 'SECRET-GH-VALUE';
    resetConfig();
    const policy = getEnginePolicy();
    const serialized = JSON.stringify(policy);
    expect(serialized).not.toMatch(/SECRET-BRAVE-VALUE/);
    expect(serialized).not.toMatch(/SECRET-GH-VALUE/);
    // Strict shape: every optional entry has EXACTLY { name, active }.
    for (const e of policy.optional_engines) {
      expect(Object.keys(e).sort()).toEqual(['active', 'name']);
      expect(typeof e.name).toBe('string');
      expect(typeof e.active).toBe('boolean');
    }
    expect(policy.disabled.every((n) => typeof n === 'string')).toBe(true);
  });
});

describe('formatEnginePolicyLines', () => {
  it('renders disabled list and per-engine active state', () => {
    const lines = formatEnginePolicyLines({
      disabled: ['brave', 'ddg-image'],
      optional_engines: [
        { name: 'brave', active: false },
        { name: 'brave-image', active: true },
        { name: 'github-code', active: false },
        { name: 'rss-feed', active: true },
      ],
    });
    const text = lines.join('\n');
    expect(text).toMatch(/disabled:.*brave.*ddg-image/);
    expect(text).toMatch(/brave=inactive/);
    expect(text).toMatch(/brave-image=active/);
    expect(text).toMatch(/github-code=inactive/);
    expect(text).toMatch(/rss-feed=active/);
  });

  it('renders an explicit "(none)" for an empty disable list instead of blank', () => {
    const lines = formatEnginePolicyLines({
      disabled: [],
      optional_engines: [{ name: 'brave', active: false }],
    });
    expect(lines.join('\n')).toMatch(/disabled:.*\(none\)/);
  });
});
