import { ArxivEngine } from '../../engines/arxiv.js';
import { SemanticScholarEngine } from '../../engines/semantic-scholar.js';
import { OpenAlexEngine } from '../../engines/openalex.js';
import { DblpEngine } from '../../engines/dblp.js';
import { OpenReviewEngine } from '../../engines/openreview.js';
import { wrapWithRetryAndBreaker, registerEngineMinInterval, ARXIV_MIN_INTERVAL_MS, type EngineEntry } from '../engine-base.js';
import { filterDisabledEngines } from '../../../config.js';

// arXiv asks API clients to stay at ≤1 request / 3 s; inside the interval the
// throttle skips the engine (same as-skip semantics as marginalia) instead of
// queueing, so fan-out deadlines stay clean.
registerEngineMinInterval('arxiv', ARXIV_MIN_INTERVAL_MS);

// arXiv + Semantic Scholar are the canonical primary sources. OpenAlex, DBLP,
// and OpenReview broaden coverage (open metadata, CS conference bibliography,
// peer-reviewed venues) as SECONDARY signals: the orchestrator demotes results
// only they contribute when lexical alignment is low, so they add recall
// without outranking a strong arXiv/S2 hit. OpenAlex and OpenReview return real
// abstracts (medium); DBLP is bibliographic metadata only — author + venue +
// year, no abstract — so it takes the low tier, matching devdocs.
let cached: EngineEntry[] | null = null;

export function getPapersEngines(): EngineEntry[] {
  if (cached) return cached;
  const entries: EngineEntry[] = [
    // arXiv's API doesn't accept a date range natively; the engine filters
    // client-side. We still flag supportsDateFilter: true so the orchestrator
    // can treat date-aware queries uniformly.
    { engine: wrapWithRetryAndBreaker(new ArxivEngine()), weight: 1.1, supportsDateFilter: true, quality: 'medium' },
    { engine: wrapWithRetryAndBreaker(new SemanticScholarEngine()), weight: 1.0, supportsDateFilter: true, quality: 'medium' },
    { engine: wrapWithRetryAndBreaker(new OpenAlexEngine()), weight: 0.8, supportsDateFilter: false, secondary: true, quality: 'medium' },
    { engine: wrapWithRetryAndBreaker(new DblpEngine()), weight: 0.7, supportsDateFilter: false, secondary: true, quality: 'low' },
    { engine: wrapWithRetryAndBreaker(new OpenReviewEngine()), weight: 0.6, supportsDateFilter: false, secondary: true, quality: 'medium' },
  ];

  cached = filterDisabledEngines(entries, 'papers');
  return cached;
}

export function _resetPapersEnginesForTest(): void {
  cached = null;
}
