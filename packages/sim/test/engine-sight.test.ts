// G10 boarding plan: the engine crew sees a rider in a cone ahead of the engine and to its sides,
// not behind it; spotted once per run, guards on that side watch the ledge and the train speeds up.
import { describe, it, expect } from 'vitest';
import {
  createSim, prepareMap, trainSpeedNow,
  type Command, type GameState, type Sim, type SimConfig, type SimEvent, type SimMap,
} from '../src';
import { asciiCar, TEST_CARS, TEST_MAIL_TRAIN, testConfig, testMap, type Paint } from './fixtures';

type Values = SimConfig['values'];
const GUARD_CAR = asciiCar('guarded', ['#######DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [8, 0] }, { id: 'side-right', side: 'right', cell: [8, 5] }],
  guardSpawns: [{ cell: [12, 2], facing: 'left' }],
});

function sightConfig(sight: Partial<Values['boarding']['engineSight']> = {}): SimConfig {
  const base = testConfig();
  return testConfig({}, 'sight001', {
    boarding: { ...base.values.boarding, engineSight: { ...base.values.boarding.engineSight, enabled: true, ...sight } },
    carTemplates: { ...TEST_CARS, 'guard-car': GUARD_CAR },
    trains: { ...base.values.trains, mail: { ...TEST_MAIL_TRAIN, carType: 'guarded', layouts: ['guard-car'], carCount: 2, loot: undefined, guards: { base: 1 } } },
    trainMix: { ...base.values.trainMix, mailTrain: 'mail' },
  });
}

const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim)); return ev; };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** Where the engine is at d 100 on the stadium, and its axis. */
function enginePose(cfg: SimConfig) {
  const sim = createSim({ config: cfg, map: testMap(), seed: 'sight', playerIds: [1] });
  S(sim).world.trains[0]!.d = 100;
  return sim.cars()[0]!;
}

/** Committed to the train at d 100, the horse stopped at `ahead` tiles along the engine and `left` to its left. */
function riding(cfg: SimConfig, ahead: number, left: number, paint?: Paint): Sim {
  const e = enginePose(cfg);
  const map: SimMap = testMap(paint);
  const sim = createSim({ config: cfg, map, seed: 'sight', playerIds: [1] });
  const s = S(sim);
  s.world.trains[0]!.d = 100;
  const h = s.world.horses[0]!;
  // The train moves on as the ticks pass: keep the horse where the engine is now, in front of it.
  const at = { x: e.x + e.ux * ahead + e.uy * left, y: e.y + e.uy * ahead - e.ux * left };
  // Commit from beside the engine, then put the horse in place.
  Object.assign(h, { x: e.x + e.uy * 8, y: e.y - e.ux * 8, hx: e.ux, hy: e.uy, speed: 0, cruiseTarget: 0 });
  sim.step([{ player: 1, commands: [{ type: 'startRun', trainId: s.world.trains[0]!.id }] }]);
  expect(s.run?.phase).toBe('approach');
  delete s.run!.engineSeen;
  Object.assign(h, at);
  return sim;
}

describe('engine sight', () => {
  const cfg = sightConfig();
  const es = cfg.values.boarding.engineSight;

  it('spots a rider ahead and to the side: guards watch that ledge, the train speeds up', () => {
    const sim = riding(cfg, 6, 10);
    const s = S(sim);
    const ev = steps(sim, es.seenAfterTicks + 2);
    expect(ofType(ev, 'EngineSaw')).toEqual([expect.objectContaining({ side: 'left', trainId: s.run!.trainId })]);
    expect(s.run!.engineSeen?.saw).toBe(true);
    const t = s.world.trains.find((q) => q.id === s.run!.trainId)!;
    expect(t.speedUpTicks).toBeGreaterThan(0);
    const map = prepareMap(testMap());
    const normal = trainSpeedNow(map, cfg, { ...t, speedUpTicks: undefined });
    expect(trainSpeedNow(map, cfg, t)).toBeCloseTo(normal * es.speedUpScale, 9);
    for (const g of s.run!.guards) {
      expect(g.state).toBe('suspicious');
      expect(g.lastKnown!.y).toBeLessThan(0);
    }
    // Once per run.
    expect(ofType(steps(sim, es.seenAfterTicks * 2), 'EngineSaw')).toHaveLength(0);
  });

  it('does not see behind, past its range, through blocked ground, or when off', () => {
    const cases: [string, Sim][] = [
      ['behind', riding(cfg, -30, 8)],
      ['too far for a slow rider', riding(cfg, 0, es.slowRangeTiles + 4)],
      ['off', riding(sightConfig({ enabled: false }), 6, 10)],
    ];
    const e = enginePose(cfg);
    // A wall of blocked ground 5 tiles out on the left, the length of the engine and well past it.
    const wall: Paint = (x, y) => {
      const dx = x - e.x, dy = y - e.y, along = dx * e.ux + dy * e.uy, left = dx * e.uy - dy * e.ux;
      return left > 5 && left < 7 && along > -20 && along < 40 ? 'blocked' : 'open';
    };
    cases.push(['through a wall', riding(cfg, 6, 10, wall)]);
    for (const [why, sim] of cases) {
      expect(ofType(steps(sim, es.seenAfterTicks + 5), 'EngineSaw'), why).toHaveLength(0);
    }
  });

  it('needs a rider seen for seenAfter ticks in a row', () => {
    const sim = riding(cfg, 6, 10);
    expect(ofType(steps(sim, es.seenAfterTicks - 2), 'EngineSaw')).toHaveLength(0);
    expect(S(sim).run!.engineSeen!.ticks).toBe(es.seenAfterTicks - 2);
  });
});
