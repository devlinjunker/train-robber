// Collision damage: running into a train or blocked ground on a run costs health, once per crash.
import { describe, it, expect } from 'vitest';
import { createSim, entryPointWorld, type Command, type GameState, type Sim, type SimConfig, type SimEvent } from '../src';
import { testConfig, testMap, type Paint } from './fixtures';

const W = { type: 'move', x: 0, y: -127 } as const;
// Rock at x 60 to 62 and water at x 60 to 62 further down, both well clear of the route.
const paint: Paint = (x, y) => (x >= 60 && x <= 62 && y >= 2 && y <= 12 ? 'blocked' : x >= 60 && x <= 62 && y >= 16 && y <= 24 ? 'water' : 'open');
const map = testMap(paint, { x: 116, y: 22 });

function setup(cfg: SimConfig = testConfig(), commit = true): Sim {
  const sim = createSim({ config: cfg, map, seed: 'crash', playerIds: [1] });
  (sim.state as GameState).world.trains[0]!.d = 100;
  if (commit) step(sim, { type: 'interact', held: false });
  return sim;
}

const S = (sim: Sim) => sim.state as GameState;
const horse = (sim: Sim) => S(sim).world.horses[0]!;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number, ...first: Command[]) => {
  const ev: SimEvent[] = [...step(sim, ...first)];
  for (let i = 1; i < n; i++) ev.push(...step(sim));
  return ev;
};
const damage = (ev: SimEvent[]) => ev.filter((e) => e.type === 'DamageDealt');

/** Gallop right at full speed from (x, y) toward whatever lies at x = 60. */
function charge(sim: Sim, y: number, x = 50): SimEvent[] {
  Object.assign(horse(sim), { x, y, hx: 1, hy: 0, speed: 14, cruiseTarget: 14 });
  return steps(sim, 120, W);
}

describe('collision damage', () => {
  it('running into blocked ground costs damageFraction of max health, once', () => {
    const sim = setup();
    const ev = damage(charge(sim, 7));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ cause: 'collision', against: 'obstacle', amount: 10, health: 90 });
    expect((ev[0] as { impact: number }).impact).toBeGreaterThan(4);
    expect(S(sim).run!.players[1]!.health).toBe(90);
    // Pressing on into the wall afterwards never builds up the impact speed again.
    expect(damage(steps(sim, 300))).toHaveLength(0);
  });

  it('water and the map edge stop the horse without hurting', () => {
    const sim = setup();
    expect(damage(charge(sim, 20))).toHaveLength(0);
    expect(horse(sim).x).toBeCloseTo(59.5, 9);
    Object.assign(horse(sim), { x: 6, y: 7, hx: -1, hy: 0, speed: 14 });
    expect(damage(steps(sim, 120, W))).toHaveLength(0);
    expect(S(sim).run!.players[1]!.health).toBe(100);
  });

  it('is free with no run, since there is no health to lose', () => {
    const sim = setup(testConfig(), false);
    expect(damage(charge(sim, 7))).toHaveLength(0);
  });

  it('a slow bump under minImpactTilesPerSec is free', () => {
    const sim = setup();
    Object.assign(horse(sim), { x: 58, y: 7, hx: 1, hy: 0, speed: 3, cruiseTarget: 3 });
    expect(damage(steps(sim, 120))).toHaveLength(0);
  });

  it('a second crash inside the cooldown is free, and one after it hurts', () => {
    const sim = setup();
    Object.assign(horse(sim), { x: 59, y: 7, hx: 1, hy: 0, speed: 14, cruiseTarget: 14 });
    expect(damage(steps(sim, 5, W))).toHaveLength(1);
    expect(S(sim).run!.players[1]!.hitCooldownTicks).toBeGreaterThan(50);
    // Back off and hit again straight away: inside the 60-tick cooldown.
    Object.assign(horse(sim), { x: 59, y: 7, speed: 14 });
    expect(damage(steps(sim, 5))).toHaveLength(0);
    steps(sim, 60);
    Object.assign(horse(sim), { x: 59, y: 7, speed: 14 });
    expect(damage(steps(sim, 5))).toHaveLength(1);
    expect(S(sim).run!.players[1]!.health).toBe(80);
  });

  it('turning into a train car hurts; riding alongside it at its speed does not', () => {
    const sim = setup();
    const car = sim.cars()[1]!;
    const ep = entryPointWorld(car, { side: 'left', along: 0 });
    // Alongside, touching the side, matching the train: contact but no lost speed.
    Object.assign(horse(sim), { x: ep.x + car.uy * 0.45, y: ep.y - car.ux * 0.45, hx: car.ux, hy: car.uy, speed: 9, cruiseTarget: 9 });
    expect(damage(steps(sim, 60))).toHaveLength(0);
    // Facing the car side from two tiles out at speed: a crash.
    const c2 = sim.cars()[1]!, e2 = entryPointWorld(c2, { side: 'left', along: 0 });
    Object.assign(horse(sim), { x: e2.x + c2.uy * 2, y: e2.y - c2.ux * 2, hx: -c2.uy, hy: c2.ux, speed: 12, cruiseTarget: 12 });
    const ev = damage(steps(sim, 30));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ cause: 'collision', against: 'train' });
  });

  it('damageFraction 0 (collisionDamage:off) turns it off', () => {
    const base = testConfig();
    const off: SimConfig = { ...base, values: { ...base.values, collision: { ...base.values.collision, damageFraction: 0 } } };
    expect(damage(charge(setup(off), 7))).toHaveLength(0);
  });

  it('crashing to no health ends the run as a death', () => {
    const sim = setup();
    S(sim).run!.players[1]!.health = 10;
    const ev = charge(sim, 7);
    expect(ev.find((e) => e.type === 'RunEnded')).toMatchObject({ outcome: 'died' });
    expect(S(sim).run).toBeNull();
  });
});
