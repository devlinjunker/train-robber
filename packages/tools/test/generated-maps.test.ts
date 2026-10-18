// The procedural map generator (packages/mapgen, ?map=gen): every seed must pass the same checks
// as the hand-made maps, and a seed must give the same map on every machine.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMapGen } from '@train-robber/config';
import { dcos, dsin, generateMap, GENERATED_MAP_ID } from '@train-robber/mapgen';
import { createHash } from 'node:crypto';
import { CONTENT_DIR, readJson, REPO_ROOT } from '../src/content';
import { mapProblems, minRadius } from '../src/maps/checks';
import { lapProblems, trainGapProblems } from '../src/maps/simChecks';

const defaults = readJson(join(CONTENT_DIR, 'base/map-gen.json'));
const settings = resolveMapGen(defaults);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

// The 300 seeds run in generated-seeds-*.test.ts, split so test workers share them.
describe('generated maps pass the map checks', () => {
  it('with other sizes, curviness and river counts', () => {
    const variants: Record<string, unknown>[] = [
      { size: { cols: 240, rows: 160 } }, { size: { cols: 600, rows: 300 } }, { track: { curviness: 1 } },
      { track: { curviness: 0 } }, { track: { harmonics: [5, 8] } }, { rivers: { count: [3, 4] } },
    ];
    const bad: string[] = [];
    for (const v of variants) {
      const s = resolveMapGen(defaults, v);
      for (let k = 0; k < 10; k++) {
        const { map, scenery } = generateMap(`v-${k}`, s);
        for (const p of mapProblems(map, scenery, minRadius(map))) bad.push(`${JSON.stringify(v)} v-${k}: ${p}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 60_000);

  it('start their trains, run a full lap and keep trains apart', () => {
    for (let k = 0; k < 8; k++) {
      const { map } = generateMap(`gen-${k}`, settings);
      expect(lapProblems(map, `gen-${k}`), `gen-${k}`).toEqual([]);
      expect(trainGapProblems(map, `gen-${k}`), `gen-${k}`).toEqual([]);
    }
  }, 60_000);

  it('the checks do catch a broken map', () => {
    const { map, scenery } = generateMap('gen-0', settings);
    // Paint the whole map blocked except the spawn: rock under the cars, no lane, nothing reachable.
    const total = map.size.cols * map.size.rows;
    const broken = { ...map, zones: [[total, 2]] as [number, number][] };
    expect(mapProblems(broken, scenery, minRadius(broken)).length).toBeGreaterThan(3);
  });
});

describe('generated maps are deterministic', () => {
  it('the same seed and settings give the same map; another seed gives another', () => {
    const a = generateMap('repeat-me', settings), b = generateMap('repeat-me', settings);
    expect(JSON.stringify(a.map)).toBe(JSON.stringify(b.map));
    expect(JSON.stringify(a.scenery)).toBe(JSON.stringify(b.scenery));
    expect(a.map.id).toBe(GENERATED_MAP_ID);
    expect(generateMap('repeat-me-too', settings).map.source.hash).not.toBe(a.map.source.hash);
  });

  it('a pinned seed still gives the pinned map (bump GENERATOR_VERSION and update these if the generator changes on purpose)', () => {
    // Fails if the output drifts on this machine or this engine; CI runs it too.
    const { map, scenery } = generateMap('pinned-1', settings);
    expect(sha(map)).toBe(PINNED.map);
    expect(sha(scenery)).toBe(PINNED.scenery);
  });

  it('uses no engine-dependent maths (Math.sin, cos, pow, hypot, random and friends, or **)', () => {
    const dir = join(REPO_ROOT, 'packages/mapgen/src');
    for (const f of readdirSync(dir)) {
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, f).not.toMatch(/Math\.(sin|cos|tan|asin|acos|atan|atan2|pow|hypot|exp|expm1|log|log2|log10|log1p|cbrt|sinh|cosh|tanh|random)\b/);
      expect(code, f).not.toMatch(/\*\*/);
    }
  });

  it('dsin and dcos match Math.sin and Math.cos closely', () => {
    for (let x = -50; x <= 50; x += 0.0137) {
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-10);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-10);
    }
  });
});

const PINNED = { map: '269cc27b2b4cb336', scenery: '9553f7b7f4f8b000' };
