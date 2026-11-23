// Egress policy guard: this deployment's proxy only permits CONNECT to 443
// (plain http CONNECTs are denied at the proxy, not at the target). Every
// engine request URL must therefore be https. arXiv shipped as the lone
// http:// engine and its whole vertical died silently (2026-11-23) — this
// test is the ratchet that keeps the next engine from doing the same.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINES_DIR = 'src/search/engines';

describe('engine request URLs are https-only', () => {
  const files = readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.ts') && f !== 'user-agents.ts');
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    it(`${file} contains no plain-http URL literal`, () => {
      const offenders: string[] = [];
      const lines = readFileSync(join(ENGINES_DIR, file), 'utf-8').split('\n');
      lines.forEach((line, i) => {
        // Strip line comments (but not the "//" inside "://"): prose may
        // legitimately mention http:// URLs, code must not.
        const code = line.replace(/(?<!:)\/\/.*$/, '');
        if (code.includes('http://')) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
      expect(offenders, 'request URLs must use https (proxy CONNECTs 443 only)').toEqual([]);
    });
  }
});
