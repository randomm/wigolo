import { describe, it, expect, vi, beforeEach } from 'vitest';

// `@huggingface/transformers` is mocked: these tests cover how candidates are
// split into ONNX runs. The model scores a document by its numeric text.
const h = vi.hoisted(() => ({ batchSizes: [] as number[] }));

vi.mock('@huggingface/transformers', () => {
  const tokenizer = (queries: string[], opts: { text_pair: string[] }) => ({
    __docs: opts.text_pair,
    input_ids: { dims: [queries.length, 16] },
  });
  const model = async (inputs: { __docs: string[] }) => {
    h.batchSizes.push(inputs.__docs.length);
    return { logits: { data: new Float32Array(inputs.__docs.map(Number)), dims: [inputs.__docs.length, 1] } };
  };
  return {
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => model) },
    env: { cacheDir: '' },
  };
});

vi.mock('../../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo-rerank-batch-test' }),
}));

import {
  TransformersRerankProvider,
  RERANK_MAX_BATCH,
} from '../../../../src/search/reranker/transformers-rerank-provider.js';

describe('TransformersRerankProvider.rerank batching', () => {
  beforeEach(() => {
    h.batchSizes = [];
  });

  it('never runs more than RERANK_MAX_BATCH pairs at once', async () => {
    const candidates = Array.from({ length: RERANK_MAX_BATCH * 6 + 5 }, (_, i) => ({ id: `c${i}`, text: String(i) }));
    await new TransformersRerankProvider().rerank('q', candidates);

    expect(Math.max(...h.batchSizes)).toBeLessThanOrEqual(RERANK_MAX_BATCH);
    expect(h.batchSizes.reduce((a, b) => a + b, 0)).toBe(candidates.length);
  });

  it('scores every candidate against its own logit across batches', async () => {
    const candidates = Array.from({ length: RERANK_MAX_BATCH * 2 + 3 }, (_, i) => ({ id: `c${i}`, text: String(i) }));
    const out = await new TransformersRerankProvider().rerank('q', candidates, 3);

    const n = candidates.length;
    expect(out).toEqual([
      { id: `c${n - 1}`, score: n - 1 },
      { id: `c${n - 2}`, score: n - 2 },
      { id: `c${n - 3}`, score: n - 3 },
    ]);
  });
});
