// G6: towns along the open line, their seeded timetables, and the next-town train clock.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveMapGen, type MapDef } from '@train-robber/config';
import { generateLine, townLayout } from '@train-robber/mapgen';
import {
  createSim, lineClock, lineDepartTick, lineGapBehind, lineStartOffset, lineTrainNumber, lineTrainType, routeOf, townTimetable, trackAt, trainClockOf,
  type GameState, type SimEvent,
} from '@train-robber/sim';
import { CONTENT_DIR, loadConfig, readJson } from '../src/content';

const defaults = readJson(join(CONTENT_DIR, 'base/map-gen.json'));
const settings = resolveMapGen(defaults);
const lazyLine = (seed: string, over?: Record<string, unknown>) => generateLine(seed, over ? resolveMapGen(defaults, over) : settings, { whole: false });

describe('towns', () => {
  it('have a name, a size and buildings, with a town off each end of the line', () => {
    for (const seed of ['towns-1', 'towns-2', 'towns-3', 'towns-4']) {
      const { map } = lazyLine(seed);
      const towns = map.towns!;
      const route = map.routes[0]!;
      expect(towns[0]).toMatchObject({ id: 'line-start', d: 0, end: 'start', layout: [] });
      expect(towns.at(-1)).toMatchObject({ id: 'line-end', d: route.length, end: 'end', layout: [] });
      const inner = towns.filter((t) => !t.end);
      expect(inner.length).toBeGreaterThanOrEqual(1);
      // Names are unique along a line.
      expect(new Set(towns.map((t) => t.name)).size).toBe(towns.length);
      for (const t of inner) {
        expect(map.markers[t.id]).toEqual({ x: t.x, y: t.y });
        const kinds = t.layout.map((b) => b.kind);
        expect(kinds).toContain('station');
        expect(kinds).toContain('platform');
        // Every building but the platform stands inside the clearing.
        for (const b of t.layout) {
          if (b.kind === 'platform') continue;
          const lx = -b.uy, ly = b.ux;
          for (const [a, c] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            const x = b.x + b.ux * b.halfLength * a + lx * b.halfWidth * c, y = b.y + b.uy * b.halfLength * a + ly * b.halfWidth * c;
            expect(Math.hypot(x - t.x, y - t.y)).toBeLessThanOrEqual(t.radiusTiles);
          }
        }
      }
    }
  });

  it('town sizes give more buildings to bigger towns', () => {
    const { map } = lazyLine('sizes-1');
    const spot = map.towns!.find((t) => !t.end)!;
    const r = { next: () => 0.5, range: (a: number, b: number) => (a + b) / 2, int: (a: number, b: number) => b };
    const count = (size: 'halt' | 'village' | 'town') => townLayout(r, size, spot, 1, 0, settings.line.towns.gapTiles).length;
    expect(count('halt')).toBeLessThan(count('village'));
    expect(count('village')).toBeLessThan(count('town'));
  });

  it('are the same for the same seed and settings, mirror with direction west, and can be switched off', () => {
    const a = lazyLine('same-towns'), b = generateLine('same-towns', settings);
    expect(a.map.towns).toEqual(b.map.towns);
    const west = lazyLine('same-towns', { line: { direction: 'west' } });
    const cols = west.map.size.cols;
    expect(west.map.towns!.map((t) => [t.id, t.name, t.size, t.d])).toEqual(a.map.towns!.map((t) => [t.id, t.name, t.size, t.d]));
    const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
    expect(west.map.towns![1]!.layout.map((q) => q.x)).toEqual(a.map.towns![1]!.layout.map((q) => r4(cols - q.x)));
    const none = lazyLine('same-towns', { line: { towns: { endTowns: false } } });
    expect(none.map.towns!.some((t) => t.end)).toBe(false);
    // Towns never move the tiles: the inner towns sit exactly where they did without end towns.
    expect(none.map.towns!.map((t) => [t.id, t.x, t.y])).toEqual(a.map.towns!.filter((t) => !t.end).map((t) => [t.id, t.x, t.y]));
  });
});

/** Ticks at which each line train's engine passed distance `d`, by train number, from stepping the sim. */
function passes(map: MapDef, seed: string, config: ReturnType<typeof loadConfig>, ticks: number, ds: Record<string, number>): Map<string, { k: number; type: string; tick: number }[]> {
  const sim = createSim({ config, map, seed, playerIds: [1] });
  const out = new Map<string, { k: number; type: string; tick: number }[]>(Object.keys(ds).map((id) => [id, []]));
  let before = new Map((sim.state as GameState).world.trains.map((t) => [t.id, t.d]));
  for (let i = 0; i < ticks; i++) {
    sim.step([]);
    const s = sim.state as GameState;
    for (const t of s.world.trains) {
      const prev = before.get(t.id);
      if (prev === undefined) continue;
      for (const [id, d] of Object.entries(ds)) {
        if (prev < d && t.d >= d) {
          const k = lineTrainNumber(sim.map, config, seed, t.type, t.d, s.tick);
          out.get(id)!.push({ k, type: t.type, tick: s.tick - 1 + (d - prev) / (t.d - prev) });
        }
      }
    }
    before = new Map(s.world.trains.map((t) => [t.id, t.d]));
  }
  return out;
}

describe('seeded timetables', () => {
  const config = loadConfig({ preset: 'alpha-default' });
  const seed = 'timetable-1';
  const { map } = lazyLine(seed);

  it('keep the open line headway and spread between trains', () => {
    const line = map.openLine!;
    const spread = line.headwaySpreadTiles!;
    for (let k = -60; k < 20; k++) {
      const gap = lineStartOffset(map, seed, k + 1) - lineStartOffset(map, seed, k);
      expect(gap).toBeCloseTo(lineGapBehind(map, seed, k + 1), 9);
      expect(gap).toBeGreaterThanOrEqual(line.headwayTiles - spread);
      expect(gap).toBeLessThanOrEqual(line.headwayTiles + spread);
      expect(lineDepartTick(map, config, seed, k + 1)).toBeLessThan(lineDepartTick(map, config, seed, k));
    }
    // Spread: the gaps are not all the same, and they average out near the headway.
    const gaps = Array.from({ length: 200 }, (_, k) => lineGapBehind(map, seed, -k));
    expect(new Set(gaps.map((g) => Math.round(g))).size).toBeGreaterThan(50);
    expect(gaps.reduce((a, b) => a + b, 0) / gaps.length).toBeGreaterThan(line.headwayTiles - spread / 4);
    expect(gaps.reduce((a, b) => a + b, 0) / gaps.length).toBeLessThan(line.headwayTiles + spread / 4);
  });

  it('mix train types by hash at about the blank share', () => {
    const types = Array.from({ length: 400 }, (_, k) => lineTrainType(config, seed, k - 200));
    const blank = types.filter((t) => t === config.values.trainMix.blankTrain).length / types.length;
    expect(blank).toBeGreaterThan(config.values.trainMix.blankShare - 0.1);
    expect(blank).toBeLessThan(config.values.trainMix.blankShare + 0.1);
    const allMail = loadConfig({ preset: 'alpha-default', variants: { trainMix: 'all-mail' } });
    expect(new Set(Array.from({ length: 50 }, (_, k) => lineTrainType(allMail, seed, k)))).toEqual(new Set([allMail.values.trainMix.mailTrain]));
  });

  it('say exactly when the sim\'s trains reach each town, with their types', () => {
    const ticks = 60 * 400;
    // Trains enter at the start town (distance 0) rather than pass it; that is checked below.
    const ds = Object.fromEntries(map.towns!.filter((t) => t.d > 0).map((t) => [t.id, t.d]));
    const seen = passes(map, seed, config, ticks, ds);
    let checked = 0;
    for (const town of map.towns!.filter((t) => t.d > 0)) {
      const want = townTimetable(createSim({ config, map, seed, playerIds: [1] }).map, config, seed, town.id, 1, ticks);
      const got = seen.get(town.id)!;
      expect(got.map((g) => g.k), town.id).toEqual(want.map((w) => w.k));
      for (const [i, w] of want.entries()) {
        expect(got[i]!.type).toBe(w.type);
        expect(got[i]!.tick).toBeCloseTo(w.arriveTick, 4);
        expect(w.departTick).toBe(w.arriveTick);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    // Each train the scheduler adds sets out on the tick the start town's timetable gives.
    const sim = createSim({ config, map, seed, playerIds: [1] });
    const start = map.towns!.find((t) => t.d === 0)!;
    const known = new Set((sim.state as GameState).world.trains.map((t) => t.id));
    const entered: number[] = [];
    for (let i = 0; i < 60 * 200; i++) {
      sim.step([]);
      const s = sim.state as GameState;
      for (const t of s.world.trains) {
        if (known.has(t.id)) continue;
        known.add(t.id);
        const k = lineTrainNumber(sim.map, config, seed, t.type, t.d, s.tick);
        expect(t.type).toBe(lineTrainType(config, seed, k));
        const depart = townTimetable(sim.map, config, seed, start.id, s.tick - 1, s.tick).find((e) => e.k === k);
        expect(depart, `train ${k}`).toBeTruthy();
        entered.push(k);
      }
    }
    expect(entered.length).toBeGreaterThan(2);
    // In order, one after another.
    for (let i = 1; i < entered.length; i++) expect(entered[i]).toBe(entered[i - 1]! - 1);
  }, 120_000);

  it('are the same whatever the player does, and look far ahead without stepping the sim', () => {
    const sim = createSim({ config, map, seed, playerIds: [1] });
    const town = map.towns!.find((t) => !t.end)!;
    const day = townTimetable(sim.map, config, seed, town.id, 0, 60 * 60 * 12);
    // About one train per headway at the mail speed: 12 minutes of trains.
    const perHeadway = sim.map.openLine!.headwayTiles / (config.values.trains['mail-express']!.speedTilesPerSec);
    expect(day.length).toBeGreaterThan((12 * 60) / perHeadway - 3);
    expect(day.length).toBeLessThan((12 * 60) / perHeadway + 3);
    for (let i = 1; i < day.length; i++) expect(day[i]!.arriveTick).toBeGreaterThan(day[i - 1]!.arriveTick);
    // A slice of it is the same slice.
    const slice = townTimetable(sim.map, config, seed, town.id, day[3]!.arriveTick, day[6]!.arriveTick);
    expect(slice).toEqual(day.slice(3, 7));
    // Another seed, another timetable.
    expect(townTimetable(sim.map, config, 'timetable-2', town.id, 0, 60 * 60 * 12).map((e) => e.arriveTick)).not.toEqual(day.map((e) => e.arriveTick));
  });
});

/**
 * Commit to the train `pick` chooses, then step until the run ends, keeping the horse beside that
 * train (so no other train comes close enough for the commit prompt to offer a switch).
 */
function runToEnd(map: MapDef, seed: string, config: ReturnType<typeof loadConfig>, pick: (trains: GameState['world']['trains']) => string, maxTicks = 60 * 600) {
  const sim = createSim({ config, map, seed, playerIds: [1] });
  const s = sim.state as GameState;
  const id = pick(s.world.trains);
  const train = s.world.trains.find((t) => t.id === id)!;
  const { route } = routeOf(sim.map, config, train);
  const beside = () => {
    const at = trackAt(route, train.d - 20);
    Object.assign(s.world.horses[0]!, { x: at.x - at.ty * 6, y: at.y + at.tx * 6 });
  };
  const startD = train.d;
  beside();
  let r = sim.step([{ player: 1, commands: [{ type: 'startRun', trainId: id }] }]);
  const started = r.events.find((e) => e.type === 'RunStarted');
  const clockTo = s.run?.clockTo;
  for (let i = 0; i < maxTicks; i++) {
    const ended = r.events.find((e): e is Extract<SimEvent, { type: 'RunEnded' }> => e.type === 'RunEnded');
    if (ended) return { started, ended, clockTo, trainD: startD, sim };
    beside();
    r = sim.step([]);
  }
  return { started, ended: null, clockTo, trainD: startD, sim };
}

describe('the trainClock variant', () => {
  const seed = 'next-town-1';
  const { map } = lazyLine(seed);
  const nextTown = loadConfig({ preset: 'alpha-default', variants: { trainMix: 'all-mail' } });
  const fixed = loadConfig({ preset: 'fixed-clock', variants: { trainMix: 'all-mail' } });

  it('picks next-town in alpha-default and fixed-countdown in the fixed-clock preset; lineClock from older logs wins', () => {
    expect(trainClockOf(nextTown)).toBe('next-town');
    expect(trainClockOf(fixed)).toBe('fixed-countdown');
    expect(trainClockOf(loadConfig({ preset: 'alpha-default', overrides: { countdown: { lineClock: 'fixed' } } }))).toBe('fixed-countdown');
    expect(trainClockOf(loadConfig({ preset: 'fixed-clock', overrides: { countdown: { lineClock: 'town' } } }))).toBe('next-town');
  });

  it('next-town: the clock is the time to the next town, and the run ends as expired in that town', () => {
    const towns = map.towns!.filter((t) => !t.end);
    // The train furthest back that still has an inner town ahead of it.
    const res = runToEnd(map, seed, nextTown, (trains) => [...trains].filter((t) => t.d < towns.at(-1)!.d - 400).sort((a, b) => a.d - b.d)[0]!.id);
    expect(res.ended).not.toBeNull();
    const town = res.sim.map.towns.find((t) => t.id === res.clockTo)!;
    expect(town.end).toBeUndefined();
    expect(res.ended!.outcome).toBe('expired');
    expect(res.ended!.town).toBe(town.id);
    expect(res.ended!.endOfLine).toBeUndefined();
    // It ended the tick the train reached the town (no grace: the player was never aboard).
    const speed = nextTown.values.trains['mail-express']!.speedTilesPerTick;
    const train = (res.sim.state as GameState).world.trains.find((t) => t.d >= town.d - speed && t.d < town.d + speed);
    expect(train).toBeTruthy();
    expect(res.started && 'countdownSec' in res.started ? res.started.countdownSec : 0).toBeCloseTo((town.d - res.trainD) / nextTown.values.trains['mail-express']!.speedTilesPerSec, 1);
  }, 60_000);

  it('next-town: past the last inner town the clock runs to the town at the end of the line, not the end of the line', () => {
    const route = map.routes[0]!;
    const last = map.towns!.filter((t) => !t.end).at(-1)!;
    const res = runToEnd(map, seed, nextTown, (trains) => trains.find((t) => t.d > last.d && t.d < route.length - 200)!.id);
    expect(res.clockTo).toBe('line-end');
    expect(res.ended!.outcome).toBe('expired');
    expect(res.ended!.town).toBe('line-end');
    expect(res.ended!.endOfLine).toBeUndefined();
  }, 60_000);

  it('fixed-countdown: the clock is the train\'s countdown, and the end of the line still ends the run', () => {
    const big = loadConfig({ preset: 'fixed-clock', variants: { trainMix: 'all-mail' }, overrides: { countdown: { scale: 100 } } });
    const route = map.routes[0]!;
    const res = runToEnd(map, seed, big, (trains) => [...trains].sort((a, b) => b.d - a.d).find((t) => t.d < route.length - 200)!.id);
    expect(res.clockTo).toBeUndefined();
    expect(res.ended!.outcome).toBe('expired');
    expect(res.ended!.endOfLine).toBe(true);
    expect(res.ended!.town).toBeUndefined();
    const sim = createSim({ config: fixed, map, seed, playerIds: [1] });
    expect(lineClock(sim.map, fixed, (sim.state as GameState).world.trains[0]!)).toBeNull();
  }, 60_000);
});
