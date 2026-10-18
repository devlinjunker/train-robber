// Shared by generated-seeds-*.test.ts: the map checks over a block of seeds with the default
// generator settings. Split over three files so test workers run them side by side.
import { it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveMapGen } from '@train-robber/config';
import { generateMap } from '@train-robber/mapgen';
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
