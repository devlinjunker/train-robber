// Shared by generated-seeds-*.test.ts: the map checks over a block of seeds with the default
// generator settings, for loops and for the open line. Split over several files so test workers run them side by side.
import { it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveMapGen } from '@train-robber/config';
import { generateLine, generateMap } from '@train-robber/mapgen';
import { CONTENT_DIR, readJson } from '../src/content';
import { mapProblems, minRadius } from '../src/maps/checks';

export function checkSeeds(from: number, to: number, chunk = 50): void {
  const settings = resolveMapGen(readJson(join(CONTENT_DIR, 'base/map-gen.json')));
  for (let a = from; a < to; a += chunk) {
    it(`seeds gen-${a} to gen-${Math.min(to, a + chunk) - 1}`, () => {
      const bad: string[] = [];
      for (let k = a; k < Math.min(to, a + chunk); k++) {
        const { map, scenery } = generateMap(`gen-${k}`, settings);
        for (const p of mapProblems(map, scenery, minRadius(map))) bad.push(`gen-${k}: ${p}`);
      }
      expect(bad.slice(0, 10)).toEqual([]);
    }, 60_000);
  }
}

/** The same checks on open lines (`?map=line`), seeds line-<from> to line-<to - 1>. A line takes about two seconds to build. */
export function checkLineSeeds(from: number, to: number, chunk = 10): void {
  const settings = resolveMapGen(readJson(join(CONTENT_DIR, 'base/map-gen.json')));
  for (let a = from; a < to; a += chunk) {
    it(`seeds line-${a} to line-${Math.min(to, a + chunk) - 1}`, () => {
      const bad: string[] = [];
      for (let k = a; k < Math.min(to, a + chunk); k++) {
        const { map, scenery } = generateLine(`line-${k}`, settings);
        for (const p of mapProblems(map, scenery, minRadius(map))) bad.push(`line-${k}: ${p}`);
      }
      expect(bad.slice(0, 10)).toEqual([]);
    }, 120_000);
  }
}
