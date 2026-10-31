import { describe, it, expect } from 'vitest';
import { looksLikeBaitSerp } from '../../../../src/search/engines/bing.js';
import type { RawSearchResult } from '../../../../src/types.js';

const r = (title: string, snippet: string): RawSearchResult => ({
  title,
  url: 'https://example.com/' + title.length,
  snippet,
  relevance_score: 0.5,
  engine: 'bing',
});

// The 2026-10-31 live incident: Bing soft-block bait SERP served for a
// Node.js release query — HTTP 200, well-formed HTML, off-topic pages.
const BAIT = [
  r('Kalshi Free $25 Bonus (How It Works + My Honest Review)', 'The prediction market for trading the future. Sign up today and claim your bonus.'),
  r('All things micro and macro prediction trading', 'Discussion about market odds, sports betting and event contracts.'),
  r('Kalshi - Prediction Market for Trading the Future', 'Trade on real world events. Sports, politics, econ.'),
  r('Read Customer Service Reviews of kalshi.com', 'Trustpilot reviews of the trading platform.'),
];

// Same query, clean SERP shape (abridged from the live curl capture).
const CLEAN = [
  r('Download Node.js®', 'Download the current version of Node.js for your platform. Version 25.0.0.'),
  r('Node.js — Node.js Releases', 'List of all Node.js releases, versions and changelogs.'),
  r('Node.js Latest Version - Support Lifecycle, LTS & EOL', 'Track the latest stable release, LTS and end-of-life dates for Node.js.'),
  r('Releases · nodejs/node', 'GitHub release notes for every Node.js version.'),
];

const QUERY = 'current stable release version of Node.js';

describe('looksLikeBaitSerp', () => {
  interface Case { description: string; query: string; results: RawSearchResult[]; expected: boolean }
  const cases: Case[] = [
    { description: 'live-incident bait SERP is flagged', query: QUERY, results: BAIT, expected: true },
    { description: 'clean SERP is not flagged', query: QUERY, results: CLEAN, expected: false },
    { description: 'thin SERP (2 results) is inconclusive, never flagged', query: QUERY, results: BAIT.slice(0, 2), expected: false },
    { description: 'single-token query does not false-positive on bait', query: 'kalshi', results: BAIT, expected: false },
    { description: 'empty results are not a bait signal', query: QUERY, results: [], expected: false },
  ];
  for (const c of cases) {
    it(c.description, () => {
      expect(looksLikeBaitSerp(c.query, c.results)).toBe(c.expected);
    });
  }
});
