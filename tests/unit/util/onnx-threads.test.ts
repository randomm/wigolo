import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { limitOrtIntraOpThreads } from '../../../src/util/onnx-threads.js';

function fakeSession() {
  const calls: unknown[][] = [];
  return { calls, session: { create: vi.fn(async (...args: unknown[]) => { calls.push(args); return {}; }) } };
}

describe('limitOrtIntraOpThreads', () => {
  it('adds intraOpNumThreads and keeps the caller options', async () => {
    const { calls, session } = fakeSession();
    expect(limitOrtIntraOpThreads(session, 4)).toBe(true);

    await session.create('/m.onnx', { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });

    expect(calls[0]).toEqual([
      '/m.onnx',
      { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 4 },
    ]);
  });

  it('appends options when the caller passed none', async () => {
    const { calls, session } = fakeSession();
    limitOrtIntraOpThreads(session, 2);

    await session.create('/m.onnx');

    expect(calls[0]).toEqual(['/m.onnx', { intraOpNumThreads: 2 }]);
  });

  it('does not mistake a model buffer for options', async () => {
    const { calls, session } = fakeSession();
    limitOrtIntraOpThreads(session, 2);
    const model = new Uint8Array([1, 2, 3]);

    await session.create(model);

    expect(calls[0]).toEqual([model, { intraOpNumThreads: 2 }]);
  });

  it('leaves the factory alone for 0 and wraps only once', async () => {
    const { calls, session } = fakeSession();
    expect(limitOrtIntraOpThreads(session, 0)).toBe(false);
    expect(limitOrtIntraOpThreads(session, 4)).toBe(true);
    expect(limitOrtIntraOpThreads(session, 8)).toBe(false);

    await session.create('/m.onnx', {});

    expect(calls[0]).toEqual(['/m.onnx', { intraOpNumThreads: 4 }]);
  });
});
