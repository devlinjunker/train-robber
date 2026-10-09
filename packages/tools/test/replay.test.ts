import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayText } from '../src/replay';
import { recordGolden } from '../src/golden';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/golden.commands.ndjson');

describe('golden replay', () => {
  it('the checked-in replay reproduces every logged hash', () => {
    const r = replayText(readFileSync(GOLDEN, 'utf8'));
    expect(r.mismatches).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.checked).toBeGreaterThan(1);
    expect(r.actualHash).toBe(r.expectedHash);
    expect(r.ok).toBe(true);
  });
  it('the golden script still records the checked-in file', () => {
    // Fails when the sim, config or script changes; rerun `npm run golden:update` if intended.
    expect(recordGolden()).toBe(readFileSync(GOLDEN, 'utf8'));
  });
  it('a tampered command is detected', () => {
    const text = readFileSync(GOLDEN, 'utf8').replace('"x":127', '"x":126');
    expect(replayText(text).ok).toBe(false);
  });
});
