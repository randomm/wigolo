/**
 * Operator disable list vs plugin engines (fork rule, closes the gap left
 * when upstream cba8623c made plugin engines join the default general pool).
 *
 * `getGeneralEngines()` appends `getPluginEngineEntries()` AFTER
 * `getBuiltInGeneralEngines()` ran `filterDisabledEngines` — so a plugin
 * engine named in WIGOLO_DISABLE_ENGINES / settings.disabledEngines currently
 * stays in the roster. An operator's disable list must mean the same thing
 * for every engine in the pool, built-in or plugin-loaded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { getGeneralEngines, _resetGeneralEnginesForTest } from '../../../src/search/core/verticals/general.js';
import { setPluginSearchEngines } from '../../../src/search/core/plugin-engines.js';
import type { SearchEngine } from '../../../src/types.js';

const ENV_DISABLE = 'WIGOLO_DISABLE_ENGINES';

function stubEngine(name: string): SearchEngine {
  return {
    name,
    search: async () => [],
  } as unknown as SearchEngine;
}

describe('WIGOLO_DISABLE_ENGINES applies to plugin engines in the general roster', () => {
  const saved = process.env[ENV_DISABLE];

  beforeEach(() => {
    delete process.env[ENV_DISABLE];
    resetConfig();
    setPluginSearchEngines([]);
    _resetGeneralEnginesForTest();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_DISABLE];
    else process.env[ENV_DISABLE] = saved;
    setPluginSearchEngines([]);
    _resetGeneralEnginesForTest();
    resetConfig();
  });

  it('drops a plugin engine named in the disable list', () => {
    process.env[ENV_DISABLE] = 'acme-search';
    resetConfig();
    setPluginSearchEngines([stubEngine('acme-search')]);
    _resetGeneralEnginesForTest();

    const names = getGeneralEngines().map((e) => e.engine.name);
    expect(names).not.toContain('acme-search');
  });

  it('keeps plugin engines that are not disabled, and does not double-filter', () => {
    process.env[ENV_DISABLE] = 'acme-search';
    resetConfig();
    setPluginSearchEngines([stubEngine('acme-search'), stubEngine('other-plugin')]);
    _resetGeneralEnginesForTest();

    const entries = getGeneralEngines();
    const names = entries.map((e) => e.engine.name);
    expect(names).not.toContain('acme-search');
    expect(names).toContain('other-plugin');
    // Built-ins survived the second pass intact (duckduckgo is in every pool).
    expect(names).toContain('duckduckgo');
  });

  it('disabling a plugin engine never trips the empty-roster guard', () => {
    // The guard only fires when the WHOLE pool would vanish; plugins are part
    // of the pool now, so disabling one plugin with built-ins left is silent.
    process.env[ENV_DISABLE] = 'acme-search';
    resetConfig();
    setPluginSearchEngines([stubEngine('acme-search')]);
    _resetGeneralEnginesForTest();

    const stderr: string[] = [];
    const realWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const names = getGeneralEngines().map((e) => e.engine.name);
      expect(names).toContain('bing');
      expect(names).not.toContain('acme-search');
    } finally {
      process.stderr.write = realWrite;
    }
    expect(stderr.join('')).not.toContain('would disable every engine');
  });
});
