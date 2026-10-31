// The open line (packages/mapgen line.ts, ?map=line): built piece by piece so it can grow forever,
// the same on every machine, and a whole run plays on it start to finish. The 200 seeds of map
// checks run in line-seeds-*.test.ts.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveMapGen } from '@train-robber/config';
import { generateLine, generateLineTrack, growLine, LINE_MAP_ID } from '@train-robber/mapgen';
import { countdownSystem, createSim, lineClock, LINE_CLOCK_MIN_SEC, routeOf, trainSpeed, type RunState } from '@train-robber/sim';
import { CONTENT_DIR, loadConfig, readJson } from '../src/content';
import { mapProblems, minRadius } from '../src/maps/checks';
import { lineRunProblems, lineTrafficProblems } from '../src/maps/simChecks';

const defaults = readJson(join(CONTENT_DIR, 'base/map-gen.json'));
const settings = resolveMapGen(defaults);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('the open line grows piece by piece', () => {
  it('heads within maxHeadingDeg of east and never comes back within selfGapTiles of itself', () => {
    const l = settings.line;
    const maxH = (l.maxHeadingDeg * Math.PI) / 180;
    // Points this many steps apart are far enough along the line that they must keep selfGapTiles apart.
    const apart = Math.ceil((2 * l.selfGapTiles) / l.stepTiles) + 2 + Math.ceil((3 * l.selfGapTiles) / l.stepTiles);
    let back = 0, closest = Infinity;
    for (let k = 0; k < 40; k++) {
      const pts: { x: number; y: number }[] = [];
      let n = 0;
      for (const piece of growLine(`grow-${k}`, l, l.widthTiles)) {
        for (const p of piece.points) {
          const prev = pts[pts.length - 1];
          if (prev) {
            expect(Math.abs(Math.atan2(p.y - prev.y, p.x - prev.x))).toBeLessThanOrEqual(maxH + 1e-9);
            if (p.x < prev.x) back++;
          }
          for (let i = 0; i < pts.length - apart; i++) closest = Math.min(closest, Math.hypot(pts[i]!.x - p.x, pts[i]!.y - p.y));
          pts.push(p);
        }
        // Far longer than any map: the generator has no end.
        if (++n > 40) break;
      }
    }
    expect(closest).toBeGreaterThan(l.selfGapTiles);
    // Past 90 degrees it does run north or south and a little back west at times.
    expect(back).toBeGreaterThan(0);
  });

  it('a longer line starts with exactly the samples of a shorter one', () => {
    for (const seed of ['prefix-1', 'prefix-2', 'prefix-3']) {
      const short = generateLineTrack(seed, settings.line, 1000, settings.line.widthTiles).route.samples;
      const long = generateLineTrack(seed, settings.line, 3000, settings.line.widthTiles).route.samples;
      const n = short.x.length;
      expect(long.x.length).toBeGreaterThan(n);
      expect(long.x.slice(0, n)).toEqual(short.x);
      expect(long.y.slice(0, n)).toEqual(short.y);
      expect(long.s.slice(0, n)).toEqual(short.s);
      // The last sample of the shorter line copies the tangent before it; every other one matches.
      expect(long.tx.slice(0, n - 1)).toEqual(short.tx.slice(0, n - 1));
    }
  });
});

describe('open line maps', () => {
  it('run across the map from off one end to off the other, with one or two towns in clearings and one off each end', () => {
    const { map, info } = generateLine('shape-1', settings);
    expect(map.id).toBe(LINE_MAP_ID);
    expect(map.size).toEqual({ cols: settings.line.lengthTiles, rows: settings.line.widthTiles });
    const r = map.routes[0]!;
    expect(r.closed).toBe(false);
    expect(r.samples.x[0]).toBeLessThan(0);
    expect(r.samples.x.at(-1)).toBeGreaterThan(map.size.cols);
    expect(map.openLine?.headwayTiles).toBe(settings.line.trainHeadwayTiles);
    expect(map.openLine?.headwaySpreadTiles).toBe(settings.line.trainHeadwaySpreadTiles);
    const inner = map.towns!.filter((t) => !t.end);
    expect(inner.length).toBeGreaterThanOrEqual(1);
    expect(inner.length).toBeLessThanOrEqual(2);
    expect(info.towns).toBe(inner.length);
    for (const t of inner) expect(map.markers[t.id]).toBeTruthy();
    expect(map.towns!.filter((t) => t.end).map((t) => t.d)).toEqual([0, r.length]);
  });

  it('pass the map checks with other lengths, widths, curviness, towns and themes', () => {
    const variants: Record<string, unknown>[] = [
      { line: { lengthTiles: 1200 } }, { line: { lengthTiles: 8000 } }, { line: { widthTiles: 300 } },
      { line: { curviness: 0 } }, { line: { maxHeadingDeg: 75 } }, { line: { pieceTiles: [100, 120] } },
      { line: { towns: { count: [2, 2], minGapTiles: 600 } } }, { line: { swingChance: 1 } },
      { line: { maxHeadingDeg: 120 } }, { line: { direction: 'west' } }, { line: { trainHeadwaySpreadTiles: 0 } },
      ...['forest', 'rocks', 'mesas', 'water', 'mud'].map((t) => ({ mix: { themes: [t], busyness: [0.06, 0.06] } })),
    ];
    const bad: string[] = [];
    for (const v of variants) {
      const s = resolveMapGen(defaults, v);
      for (let k = 0; k < 2; k++) {
        const { map, scenery } = generateLine(`lv-${k}`, s);
        for (const p of mapProblems(map, scenery, minRadius(map))) bad.push(`${JSON.stringify(v)} lv-${k}: ${p}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 180_000);

  it('run west with direction west: the same line mirrored, trains running right to left', () => {
    const east = generateLine('west-1', settings);
    const west = generateLine('west-1', resolveMapGen(defaults, { line: { direction: 'west' } }));
    const cols = west.map.size.cols;
    const r = west.map.routes[0]!, e = east.map.routes[0]!;
    expect(r.samples.x[0]).toBeGreaterThan(cols);
    expect(r.samples.x.at(-1)).toBeLessThan(0);
    expect(r.samples.x.slice(0, 50)).toEqual(e.samples.x.slice(0, 50).map((x) => Math.round((cols - x) * 1e4) / 1e4));
    expect(r.samples.tx[10]).toBeCloseTo(-e.samples.tx[10]!, 6);
    expect(west.map.towns!.map((t) => [t.d, t.x])).toEqual(east.map.towns!.map((t) => [t.d, Math.round((cols - t.x) * 1e4) / 1e4]));
    expect(lineTrafficProblems(west.map, 'west-1')).toEqual([]);
    expect(lineRunProblems(west.map, 'west-1')).toEqual([]);
  }, 120_000);

  it('the checks catch a line whose ends are on the map', () => {
    const { map, scenery } = generateLine('line-0', settings);
    const r = map.routes[0]!;
    const cut = 400;
    const short = { ...map, routes: [{ ...r, length: r.samples.s[r.samples.s.length - cut]!, samples: Object.fromEntries(Object.entries(r.samples).map(([k, v]) => [k, v.slice(cut, -cut)])) as typeof r.samples }] };
    expect(mapProblems(short, scenery, minRadius(short)).join('\n')).toMatch(/starts or ends on the map/);
  });

  it('keep trains running one way: they leave past the end, new ones enter, none touch', () => {
    for (let k = 0; k < 3; k++) {
      const { map } = generateLine(`line-${k}`, settings);
      expect(lineTrafficProblems(map, `line-${k}`), `line-${k}`).toEqual([]);
    }
  }, 120_000);

  it('play a whole run start to finish: approach, commit, board, rob, guards, whistle, extract', () => {
    for (let k = 0; k < 6; k++) {
      const { map } = generateLine(`line-${k}`, settings);
      expect(lineRunProblems(map, `line-${k}`), `line-${k}`).toEqual([]);
    }
  }, 180_000);
});

describe('open lines are deterministic', () => {
  it('the same seed and settings give the same line; another seed gives another', () => {
    const a = generateLine('repeat-me', settings), b = generateLine('repeat-me', settings);
    expect(sha(a.map)).toBe(sha(b.map));
    expect(sha(a.scenery)).toBe(sha(b.scenery));
    expect(generateLine('repeat-me-too', settings).map.source.hash).not.toBe(a.map.source.hash);
  });

  it('a pinned seed still gives the pinned line (bump LINE_GENERATOR_VERSION and update these if the generator changes on purpose)', () => {
    const { map, scenery } = generateLine('pinned-line-1', settings);
    expect(sha(map)).toBe(PINNED.map);
    expect(sha(scenery)).toBe(PINNED.scenery);
    // G4 built the tiles in chunks and added `generated` to the map, which moved the map pin once;
    // G6 (line generator 3) gave towns names, sizes, buildings and end towns, which moved it again.
    // The tiles, routes and markers are still exactly the G3 ones.
    expect(sha(map.zones)).toBe('9569c6973a0b3bb7');
    expect(sha(map.elevation)).toBe('c53da0b03adcd059');
    expect(sha(map.routes)).toBe('69a90b6ca7b0618e');
    expect(sha(map.markers)).toBe('5e32385ac16d1d56');
    // The scenery pin moves with the source hash; its items and bridges are the G4 ones.
    expect(sha(scenery.items)).toBe('32248979054b532f');
    expect(sha(scenery.bridges)).toBe('723400a0f7296908');
  });
});

const PINNED = { map: '872f902947473894', scenery: '93d6d2e6ec3dde0d' };

describe('the line clock', () => {
  const { map } = generateLine('line-clock', settings);
  const config = loadConfig({ preset: 'alpha-default', variants: { trainMix: 'map' } });

  it('counts down to the next town at least LINE_CLOCK_MIN_SEC ahead of the train, or the town at the end of the line', () => {
    const sim = createSim({ config, map, seed: 'line-clock', playerIds: [1] });
    expect(sim.map.towns.length).toBeGreaterThan(0);
    for (const train of sim.state.world.trains) {
      const c = lineClock(sim.map, config, train)!;
      const { route } = routeOf(sim.map, config, train);
      const d = c.to === 'end' ? route.length : sim.map.towns.find((t) => t.id === c.to)!.d;
      expect(c.sec).toBeCloseTo((d - train.d) / trainSpeed(config, train.type), 6);
      expect(c.to).not.toBe('end');
      if (c.to !== 'line-end') expect(c.sec).toBeGreaterThanOrEqual(LINE_CLOCK_MIN_SEC);
      // No town between the train and the one it counts to, other than ones too close to count.
      for (const t of sim.map.towns) if (t.d < d && t.d > train.d) expect((t.d - train.d) / trainSpeed(config, train.type)).toBeLessThan(LINE_CLOCK_MIN_SEC);
    }
  });

  it('is off with countdown.lineClock fixed, and on loops', () => {
    const fixed = loadConfig({ preset: 'alpha-default', variants: { trainMix: 'map' }, overrides: { countdown: { lineClock: 'fixed' } } });
    const sim = createSim({ config: fixed, map, seed: 'line-clock', playerIds: [1] });
    expect(lineClock(sim.map, fixed, sim.state.world.trains[0]!)).toBeNull();
    const on = createSim({ config, map, seed: 'line-clock', playerIds: [1] });
    expect(lineClock({ ...on.map, openLine: null }, config, on.state.world.trains[0]!)).toBeNull();
  });

  it('drains at one second a second whatever the heat', () => {
    const run = { phase: 'aboard', clockRunning: true, countdownSec: 100, heat: 100, pendingHeat: 0, clockTo: 'town1' } as unknown as RunState;
    const state = { run, tick: 0 } as never;
    const tickRate = config.values.sim.tickRateHz;
    for (let i = 0; i < tickRate; i++) countdownSystem({ state, config, emit: () => {} });
    expect(run.countdownSec).toBeCloseTo(99, 6);
    const hot = { ...run, countdownSec: 100, clockTo: undefined } as RunState;
    for (let i = 0; i < tickRate; i++) countdownSystem({ state: { run: hot, tick: 0 } as never, config, emit: () => {} });
    expect(hot.countdownSec).toBeLessThan(99);
  });
});
