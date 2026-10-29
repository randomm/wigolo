// halo: egress-proxy-ssrf — fork-only. The http-client invariant "a hostname hop is pinned or
// proxied" must fire if a rebase drops the pin branch. Simulated by a pin factory that yields
// nothing while the mode is strict (so no proxy dispatcher exists either).
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/fetch/pinned-dispatcher.js', () => ({ createPinnedAgent: vi.fn(() => undefined) }));

import { httpFetch } from '../../../src/fetch/http-client.js';

describe('pinned-or-proxied invariant', () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_q, r) => {
      hits++;
      r.end('should not be reached');
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('an unpinned, unproxied hostname hop is refused before any socket opens', async () => {
    const err = await httpFetch(`http://localhost:${port}/`).catch((e: unknown) => e);
    expect((err as Error).message).toBe('internal: unpinned, unproxied hostname hop refused');
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    expect(hits).toBe(0);
  });
});
