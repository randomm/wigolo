import { describe, it, expect, vi, beforeEach } from 'vitest';

// `fastembed` is mocked: these tests cover how texts are split into ONNX runs.
const h = vi.hoisted(() => ({
  batchSizes: [] as number[],
}));

vi.mock('fastembed', () => ({
  FlagEmbedding: {
    init: vi.fn(async () => ({
      async *embed(texts: string[], batchSize: number) {
        for (let i = 0; i < texts.length; i += batchSize) {
          const chunk = texts.slice(i, i + batchSize);
          h.batchSizes.push(chunk.length);
          yield chunk.map(t => [Number(t)]);
        }
      },
    })),
  },
  EmbeddingModel: { BGESmallENV15: 'BGESmallENV15' },
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo-batch-test' }),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { FastembedEmbedProvider, FASTEMBED_MAX_BATCH } from '../../../src/embedding/fastembed-provider.js';

describe('FastembedEmbedProvider.embed batching', () => {
  beforeEach(() => {
    h.batchSizes = [];
  });

  it('never runs more than FASTEMBED_MAX_BATCH texts at once', async () => {
    const texts = Array.from({ length: FASTEMBED_MAX_BATCH * 5 + 3 }, (_, i) => String(i));
    await new FastembedEmbedProvider().embed(texts);

    expect(Math.max(...h.batchSizes)).toBeLessThanOrEqual(FASTEMBED_MAX_BATCH);
    expect(h.batchSizes.reduce((a, b) => a + b, 0)).toBe(texts.length);
  });

  it('returns one vector per text, in input order', async () => {
    const texts = Array.from({ length: FASTEMBED_MAX_BATCH * 2 + 1 }, (_, i) => String(i));
    const out = await new FastembedEmbedProvider().embed(texts);

    expect(out.map(v => v[0])).toEqual(texts.map(Number));
  });
});
