import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { DuckDuckGoEngine } from '../../../../src/search/engines/duckduckgo.js';
import { isBlockedError } from '../../../../src/search/engines/user-agents.js';
import { wrapWithRetryAndBreaker, classifyFailure, _resetBreakersForTest } from '../../../../src/search/core/engine-base.js';

const fixtureHtml = readFileSync('tests/fixtures/search/duckduckgo-results.html', 'utf-8');

describe('DuckDuckGoEngine', () => {
  const engine = new DuckDuckGoEngine();

  it('has name set to duckduckgo', () => {
    expect(engine.name).toBe('duckduckgo');
  });

  it('parses results from DDG lite HTML', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results.length).toBe(3);
    expect(results[0].title).toBe('React – Learn');
    expect(results[0].url).toBe('https://react.dev/learn');
    expect(results[0].snippet).toContain('official React');
    expect(results[0].engine).toBe('duckduckgo');
  });

  it('assigns position-based relevance scores', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
    expect(results[1].relevance_score).toBeGreaterThan(results[2].relevance_score);
  });

  it('respects maxResults limit', () => {
    const results = engine.parseResults(fixtureHtml, 2);
    expect(results).toHaveLength(2);
  });

  it('returns empty array for empty HTML', () => {
    const results = engine.parseResults('<html><body></body></html>', 10);
    expect(results).toEqual([]);
  });

  it('unwraps DDG redirect URLs to the canonical target', () => {
    const wrapped = [
      '<html><body><table>',
      '<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Flearn&rut=abc">React</a></td></tr>',
      '<tr><td class="result-snippet">official React</td></tr>',
      '<tr><td><a class="result-link" href="https://lite.duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F">Python docs</a></td></tr>',
      '<tr><td class="result-snippet">Python documentation</td></tr>',
      '</table></body></html>',
    ].join('');
    const results = engine.parseResults(wrapped, 10);
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe('https://react.dev/learn');
    expect(results[1].url).toBe('https://docs.python.org/3/');
  });

  it('leaves non-redirect URLs untouched', () => {
    const html = [
      '<html><body><table>',
      '<tr><td><a class="result-link" href="https://example.com/page">Example</a></td></tr>',
      '<tr><td class="result-snippet">Plain link</td></tr>',
      '</table></body></html>',
    ].join('');
    const results = engine.parseResults(html, 10);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/page');
  });

  // Live incident 2026-11-23: DDG lite serves HTTP 202 bot-challenge pages to
  // this egress IP. 202 is a 2xx, so `!response.ok` never fired — the engine
  // parsed the challenge page, found zero result links, and returned [] as a
  // SUCCESS. Telemetry showed outcome:"ok"/result_count:0 forever: no throw,
  // no UA rotation via onRetry, no breaker trip, no operator-visible signal.
  describe('HTTP 202 bot challenge (2026-11-23 incident)', () => {
    afterEach(() => vi.unstubAllGlobals());

    const challengeBody =
      '<html><body><div>If this error persists, please let us know</div></body></html>';

    function stubStatus(status: number, body = challengeBody) {
      const fetchMock = vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('throws on 202 instead of returning silent zero results', async () => {
      const fetchMock = stubStatus(202);
      await expect(new DuckDuckGoEngine().search('sqlite vector')).rejects.toThrow(/202/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('202 error matches isBlockedError so the wrapper rotates UA on retry', async () => {
      const fetchMock = stubStatus(202);
      const err = await new DuckDuckGoEngine().search('sqlite vector').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The retry/breaker wrapper only rotates the UA when isBlockedError
      // matches the thrown message — pin that contract here, not in the
      // wrapper's tests, so the message wording can never regress silently.
      expect(isBlockedError(err)).toBe(true);
    });

    it('202 with a results-looking body still throws (never parses a challenge as success)', async () => {
      // Falsifier: a naive "0 results => treat as error" heuristic is not the
      // fix; status decides. A 202 carrying result markup must still throw.
      stubStatus(202, [
        '<html><body><table>',
        '<tr><td><a class="result-link" href="https://example.com/x">X</a></td></tr>',
        '<tr><td class="result-snippet">s</td></tr>',
        '</table></body></html>',
      ].join(''));
      await expect(new DuckDuckGoEngine().search('q')).rejects.toThrow(/202/);
    });

    it('200 still parses normally (the fix must not over-fire)', async () => {
      const fetchMock = stubStatus(200, fixtureHtml);
      const results = await new DuckDuckGoEngine().search('react learn');
      expect(results.length).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('non-2xx like 500 still throws (regression guard)', async () => {
      stubStatus(500);
      await expect(new DuckDuckGoEngine().search('q')).rejects.toThrow(/500/);
    });
  });

  // Review round-1 (PR #4) test-quality lane: the raw-engine tests above do
  // not exercise onRetry rotation or the wrapper machinery the 202 fix exists
  // to trigger. These close the surviving mutants (no-op onRetry; message
  // reword flipping the breaker class).
  describe('202 handling end-to-end through the wrapper (review nits)', () => {
    function stub202CapturingUA() {
      const uas: string[] = [];
      vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
        uas.push(String((init?.headers as Record<string, string>)?.['User-Agent'] ?? ''));
        return { ok: true, status: 202, text: async () => '<html>challenge</html>' } as Response;
      });
      return uas;
    }

    beforeEach(() => _resetBreakersForTest());
    afterEach(() => vi.restoreAllMocks());

    it('onRetry after a 202 error rotates the User-Agent', async () => {
      const uas = stub202CapturingUA();
      const engine = new DuckDuckGoEngine();
      const err = await engine.search('q').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      engine.onRetry(1, err);
      await engine.search('q').catch(() => undefined);
      expect(uas).toHaveLength(2);
      expect(uas[0]).not.toBe('');
      // Kills the no-op-onRetry mutant: without rotation the second call
      // reuses the identical UA.
      expect(uas[1]).not.toBe(uas[0]);
    });

    it('wrapper retries 202 with a DIFFERENT UA and ultimately rejects', async () => {
      const uas = stub202CapturingUA();
      const wrapped = wrapWithRetryAndBreaker(new DuckDuckGoEngine(), { retryAttempts: 2 });
      await expect(wrapped.search('q')).rejects.toThrow(/202/);
      expect(uas).toHaveLength(2);
      expect(uas[1]).not.toBe(uas[0]);
    });

    it('the 202 error is classified "other" — deliberate pin (fingerprint block, not rate-limit)', () => {
      // This choice carries the full breaker cooldown + chronic counters
      // (a 'rate-limit' class would get the 5s transient window). If the
      // message is ever reworded onto /429|rate.?limit/, the breaker
      // semantics silently change — this assertion makes that fail loudly.
      // Synthetic error (no fetch): the message string is the contract.
      expect(classifyFailure(new Error('DDG blocked (bot challenge): HTTP 202'))).toBe('other');
    });
  });
});
