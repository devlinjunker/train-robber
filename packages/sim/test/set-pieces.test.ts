// G10b set pieces in the sim: trains slow where the track says (grades, horseshoe bends), and a
// rider on a canyon rim drops onto the roof below with Space.
import { describe, it, expect } from 'vitest';
import {
  advanceTrains, createSim, prepareMap, rimDropCheck, speedScaleAt, travelAt, trainSpeedNow,
  type Command, type GameState, type Sim, type SimConfig, type SimEvent, type SimMap, type SimRoute,
} from '../src';
import { OUTSIDE, ROOF, stadium, testConfig, testMap } from './fixtures';

/** The stadium with trains at half speed from d 60 to 100. */
function slowRoute(): SimRoute {
  const r = stadium();
  const speedScale = r.samples.s.map((d) => (d >= 60 && d < 100 ? 0.5 : 1));
  return { ...r, samples: { ...r.samples, speedScale } };
}
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

describe('track speed', () => {
  const route = slowRoute();

  it('reads the scale under a distance, and weighs travel by it', () => {
    expect(speedScaleAt(route, 30)).toBe(1);
    expect(speedScaleAt(route, 80)).toBe(0.5);
    expect(travelAt(route, 50)).toBeCloseTo(50, 6);
    // 40 slow tiles count double.
    expect(travelAt(route, 120)).toBeCloseTo(160, 1);
    expect(travelAt(stadium(), 120)).toBe(120);
  });

  for (const follow of [true, false]) {
    it(`moves a train at ${follow ? 'half' : 'full'} speed on the slow track with trainsFollowTrackSpeed ${follow ? 'on' : 'off'}`, () => {
      const base = testConfig();
      const cfg = testConfig({}, 'speed001', { world: { ...base.values.world, trainsFollowTrackSpeed: follow } });
      const map = prepareMap({ ...testMap(), routes: [route] });
      const sim = createSim({ config: cfg, map: { ...testMap(), routes: [route] }, seed: 'speed', playerIds: [1] });
      const t = S(sim).world.trains[0]!;
      t.d = 80;
      const full = cfg.values.trains[t.type]!.speedTilesPerTick;
      advanceTrains(S(sim), map, cfg);
      expect(t.d - 80).toBeCloseTo(follow ? full / 2 : full, 9);
      expect(trainSpeedNow(map, cfg, t)).toBeCloseTo(full * cfg.values.sim.tickRateHz * (follow ? 0.5 : 1), 9);
    });
  }
});

describe('canyon rim drop', () => {
  const base = testConfig();
  const cfg: SimConfig = testConfig({}, 'rim00001', { outside: { ...OUTSIDE, platformDepthTiles: 0.5, couplingGapTiles: 1, roof: { ...ROOF } } });
  // The top straight runs east along y = 30.6; the rim is on side 1 (south of it), 4.5 to 11 out.
  const route = stadium(40, 160, 50.6);
  const withRim: SimMap = { ...testMap(), routes: [route], rims: [{ route: 'main', d0: 20, d1: 110, side: 1, inner: 4.5, outer: 11 }] };

  /** Committed to the train (engine front at d 100), the horse at (x, y). */
  function riding(map: SimMap, x: number, y: number): Sim {
    const sim = createSim({ config: cfg, map, seed: 'rim', playerIds: [1] });
    const s = S(sim);
    s.world.trains[0]!.d = 100;
    const h = s.world.horses[0]!;
    Object.assign(h, { x, y, hx: 1, hy: 0, speed: 0, cruiseTarget: 0 });
    step(sim, { type: 'startRun', trainId: s.world.trains[0]!.id });
    expect(s.run?.phase).toBe('approach');
    Object.assign(h, { x, y });
    return sim;
  }

  it('Space on the rim beside a car lands on its roof, straight across, and the run is aboard', () => {
    const sim = riding(withRim, 116, 38.1);
    const s = S(sim);
    expect(rimDropCheck(s, prepareMap(withRim), cfg, s.run!.trainId, s.world.horses[0]!)).not.toBeNull();
    const ev = step(sim, { type: 'jump' });
    expect(ofType(ev, 'RimDropped')).toHaveLength(1);
    expect(ofType(ev, 'RoofLanded')).toEqual([expect.objectContaining({ on: 'roof', jumped: true })]);
    expect(s.run!.phase).toBe('aboard');
    expect(s.players[0]!.placement.layer).toBe('roof');
    expect(s.run!.players[1]!.stumbleTicks).toBeGreaterThan(0);
  });

  it('is refused off the rim, on the other side, out of reach, or with rimDrop off', () => {
    for (const [map, x, y, c] of [
      [{ ...withRim, rims: [] }, 116, 38.1, cfg],
      [withRim, 116, 23.1, cfg],
      [withRim, 116, 41.5, cfg],
      [withRim, 116, 38.1, testConfig({}, 'rim00002', { outside: cfg.values.outside, boarding: { ...base.values.boarding, rimDrop: { ...base.values.boarding.rimDrop, enabled: false } } })],
    ] as const) {
      const sim = createSim({ config: c, map, seed: 'rim', playerIds: [1] });
      const s = S(sim);
      s.world.trains[0]!.d = 100;
      Object.assign(s.world.horses[0]!, { x, y });
      step(sim, { type: 'startRun', trainId: s.world.trains[0]!.id });
      Object.assign(s.world.horses[0]!, { x, y });
      const ev = step(sim, { type: 'jump' });
      expect(ofType(ev, 'RimDropped')).toHaveLength(0);
      expect(s.run?.phase).not.toBe('aboard');
    }
  });
});
