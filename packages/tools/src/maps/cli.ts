import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONTENT_DIR, REPO_ROOT } from '../content';
import { buildMapFile, stringifyMap } from './build';

export const MAPS_SRC = join(CONTENT_DIR, 'maps-src');
export const MAPS_OUT = join(CONTENT_DIR, 'base/maps');

/** Build every maps-src/*.tmj into base/maps. With `check`, only report stale or missing outputs. */
export function buildMaps(check: boolean): number {
  const sources = readdirSync(MAPS_SRC).filter((f) => f.endsWith('.tmj')).sort();
  let failed = 0;
  for (const f of sources) {
    const out = join(MAPS_OUT, f.replace(/\.tmj$/, '.json'));
    const rel = relative(REPO_ROOT, out);
    try {
      const { map, warnings, minRadiusTiles } = buildMapFile(join(MAPS_SRC, f));
      for (const w of warnings) console.warn(`warning: ${f}: ${w}`);
      const text = stringifyMap(map);
      const routes = map.routes.map((r) => `${r.id} ${r.length.toFixed(1)} tiles, ${r.samples.x.length} samples`).join('; ');
      if (check) {
        const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
        if (current !== text) { console.error(`error: ${rel} is ${current === null ? 'missing' : 'stale'}; run npm run maps`); failed++; continue; }
        console.log(`ok ${rel} (${routes})`);
      } else {
        mkdirSync(MAPS_OUT, { recursive: true });
        writeFileSync(out, text);
        console.log(`wrote ${rel} (${routes}; min radius ${minRadiusTiles.toFixed(1)} tiles)`);
      }
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}
