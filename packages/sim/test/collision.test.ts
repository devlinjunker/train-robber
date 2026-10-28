// Collision damage: running into a train or blocked ground costs health, once per crash. Off a run
// (health.scope day) only crashes from collision.offRunMinImpactTilesPerSec hurt.
import { describe, it, expect } from 'vitest';
import { collisionDamage, createSim, entryPointWorld, type Command, type GameState, type Sim, type SimConfig, type SimEvent } from '../src';
import { testConfig, testMap, type Paint } from './fixtures';

const W = { type: 'move', x: 0, y: -127 } as const;
// Rock at x 60 to 62 and deep water at x 60 to 62 further down, both well clear of the route.
const paint: Paint = (x, y) => (x >= 60 && x <= 62 && y >= 2 && y <= 12 ? 'blocked' : x >= 60 && x <= 62 && y >= 16 && y <= 24 ? 'deep' : 'open');
const map = testMap(paint, { x: 116, y: 22 });

function setup(cfg: SimConfig = testConfig(), commit = true): Sim {
  const sim = createSim({ config: cfg, map, seed: 'crash', playerIds: [1] });
  (sim.state as GameState).world.trains[0]!.d = 100;
  if (commit) step(sim, { type: 'interact', held: true });
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
const lost = (ev: SimEvent[]) => damage(ev).reduce((n, e) => n + e.amount, 0);
const health = (sim: Sim) => S(sim).players[0]!.health;
const runScope = (): SimConfig => { const b = testConfig(); return { ...b, values: { ...b.values, health: { max: 100, scope: 'run' } } }; };

/** Gallop right at full speed from (x, y) toward whatever lies at x = 60. */
function charge(sim: Sim, y: number, x = 50): SimEvent[] {
  Object.assign(horse(sim), { x, y, hx: 1, hy: 0, speed: 14, cruiseTarget: 14 });
  return steps(sim, 120, W);
}

describe('collision damage', () => {
  const c = testConfig().values.collision;
  it('scales from a 1-point scrape to the full damage with the impact speed', () => {
    expect(collisionDamage(c, 100, 'train', 0)).toBe(1);
    expect(collisionDamage(c, 100, 'train', 1.9)).toBe(1);
    expect(collisionDamage(c, 100, 'train', 2)).toBe(1);
    expect(collisionDamage(c, 100, 'train', 5)).toBe(6);
    expect(collisionDamage(c, 100, 'train', 8)).toBe(10);
    expect(collisionDamage(c, 100, 'train', 14)).toBe(10);
    // Blocked ground never scrapes; a hard hit hurts like a car.
    expect(collisionDamage(c, 100, 'obstacle', 1.9)).toBe(0);
    expect(collisionDamage(c, 100, 'obstacle', 14)).toBe(10);
  });

  it('train crashes and rock crashes scale to their own maximum (train hits 45%, rocks 10%)', () => {
    const split = { ...c, damageFraction: 0.45, obstacleDamageFraction: 0.1 };
    expect(collisionDamage(split, 100, 'train', 1)).toBe(1);
    expect(collisionDamage(split, 100, 'train', 5)).toBe(23);
    expect(collisionDamage(split, 100, 'train', 9)).toBe(45);
    expect(collisionDamage(split, 100, 'obstacle', 5)).toBe(6);
    expect(collisionDamage(split, 100, 'obstacle', 14)).toBe(10);
  });

  it('galloping into blocked ground costs the full damage, once', () => {
    const sim = setup();
    const ev = charge(sim, 7);
    expect(lost(ev)).toBe(10);
    expect(damage(ev)[0]).toMatchObject({ cause: 'collision', against: 'obstacle', kind: 'crash' });
    // Pressing on into the wall afterwards never builds up the impact speed again.
    expect(damage(steps(sim, 300))).toHaveLength(0);
    expect(health(sim)).toBe(90);
  });

  it('deep water and the map edge stop the horse without hurting', () => {
    const sim = setup();
    expect(damage(charge(sim, 20))).toHaveLength(0);
    expect(horse(sim).x).toBeCloseTo(59.5, 9);
    Object.assign(horse(sim), { x: 6, y: 7, hx: -1, hy: 0, speed: 14 });
    expect(damage(steps(sim, 120, W))).toHaveLength(0);
    expect(health(sim)).toBe(100);
  });

  it('with health.scope run, is free with no run, since there is no health to lose', () => {
    const sim = setup(runScope(), false);
    expect(damage(charge(sim, 7))).toHaveLength(0);
  });

  it('with health.scope day, a rock crash off a run hurts from 6 tiles/s, the same as on a run', () => {
    const sim = setup(testConfig(), false);
    const ev = charge(sim, 7);
    expect(S(sim).run).toBeNull();
    expect(damage(ev)).toHaveLength(1);
    expect(damage(ev)[0]).toMatchObject({ cause: 'collision', against: 'obstacle', kind: 'crash', amount: 10 });
    expect(health(sim)).toBe(90);
  });

  it('with health.scope day, a rock bump off a run below 6 tiles/s is free', () => {
    const sim = setup(testConfig(), false);
    Object.assign(horse(sim), { x: 56, y: 7, hx: 1, hy: 0, speed: 5, cruiseTarget: 5 });
    expect(damage(steps(sim, 120))).toHaveLength(0);
    expect(health(sim)).toBe(100);
  });

  it('with health.scope day, running out of health off a run ends the day: back at the spawn, full health, day 2', () => {
    const sim = setup(testConfig(), false);
    S(sim).players[0]!.health = 5;
    Object.assign(horse(sim), { x: 50, y: 7, hx: 1, hy: 0, speed: 14, cruiseTarget: 14 });
    const ev: SimEvent[] = [];
    for (let i = 0; i < 120 && !ev.some((e) => e.type === 'DayStarted'); i++) ev.push(...step(sim));
    expect(ev.find((e) => e.type === 'RunEnded')).toBeUndefined();
    expect(ev.find((e) => e.type === 'DayEnded')).toMatchObject({ day: 1, cause: 'died', onRun: false });
    expect(ev.find((e) => e.type === 'DayStarted')).toMatchObject({ day: 2, health: 100 });
    expect(S(sim).players[0]).toMatchObject({ health: 100, day: 2 });
    expect(horse(sim)).toMatchObject({ x: 116, y: 22, speed: 0 });
  });

  it('walking into a rock is free', () => {
    const sim = setup();
    Object.assign(horse(sim), { x: 58, y: 7, hx: 1, hy: 0, speed: 1.5, cruiseTarget: 1.5 });
    expect(damage(steps(sim, 120))).toHaveLength(0);
  });

  it('inside the cooldown a crash costs nothing more; after it, the full amount again', () => {
    const sim = setup();
    Object.assign(horse(sim), { x: 58.5, y: 7, hx: 1, hy: 0, speed: 14, cruiseTarget: 14 });
    expect(lost(steps(sim, 8, W))).toBe(10);
    Object.assign(horse(sim), { x: 58.5, y: 7, speed: 14 });
    const ev = steps(sim, 8);
    expect(lost(ev)).toBe(0);
    steps(sim, 60);
    Object.assign(horse(sim), { x: 58.5, y: 7, speed: 14 });
    expect(lost(steps(sim, 8))).toBe(10);
    expect(health(sim)).toBe(80);
  });

  it('scraping along a car costs about 1 a second; turning into its side costs the full damage', () => {
    const sim = setup();
    const car = sim.cars()[1]!;
    const ep = entryPointWorld(car, { side: 'left', along: 0 });
    // Alongside at the train's speed, angled 5 degrees into the car: a scrape.
    const a = (5 * Math.PI) / 180, lx = car.uy, ly = -car.ux;
    Object.assign(horse(sim), {
      x: ep.x + lx * 0.6, y: ep.y + ly * 0.6,
      hx: car.ux * Math.cos(a) - lx * Math.sin(a), hy: car.uy * Math.cos(a) - ly * Math.sin(a), speed: 9, cruiseTarget: 9,
    });
    const scrape = damage(steps(sim, 120));
    expect(scrape.length).toBeGreaterThan(0);
    expect(scrape.every((e) => e.type === 'DamageDealt' && e.cause === 'collision' && e.kind === 'scrape' && e.amount === 1)).toBe(true);
    expect(lost(scrape)).toBeLessThanOrEqual(3);
    // Facing the car side from two tiles out at speed: a crash, with the scrape's point already paid.
    steps(sim, 60);
    const c2 = sim.cars()[1]!, e2 = entryPointWorld(c2, { side: 'left', along: 0 });
    Object.assign(horse(sim), { x: e2.x + c2.uy * 2, y: e2.y - c2.ux * 2, hx: -c2.uy, hy: c2.ux, speed: 12, cruiseTarget: 12 });
    const before = health(sim);
    const ev = damage(steps(sim, 30));
    expect(ev.some((e) => e.type === 'DamageDealt' && e.cause === 'collision' && e.against === 'train' && e.kind === 'crash')).toBe(true);
    expect(before - health(sim)).toBe(10);
  });

  it('a train running into a standing horse hurts', () => {
    const sim = setup();
    const car = sim.cars()[0]!;
    // Standing on the track a tile ahead of the engine's nose.
    Object.assign(horse(sim), { x: car.x + car.ux * (car.halfLength + 0.6), y: car.y + car.uy * (car.halfLength + 0.6), hx: 0, hy: 1, speed: 0, cruiseTarget: 0 });
    const ev = damage(steps(sim, 20));
    expect(ev[0]).toMatchObject({ against: 'train', kind: 'crash' });
    expect(lost(ev)).toBeGreaterThanOrEqual(10);
  });

  it('damageFraction and scrapeDamageFraction 0 (collisionDamage:off) turn it off', () => {
    const base = testConfig();
    const off: SimConfig = { ...base, values: { ...base.values, collision: { ...base.values.collision, damageFraction: 0, obstacleDamageFraction: 0, scrapeDamageFraction: 0 } } };
    expect(damage(charge(setup(off), 7))).toHaveLength(0);
  });

  it('crashing to no health ends the run as a death', () => {
    const sim = setup();
    S(sim).players[0]!.health = 10;
    const ev = charge(sim, 7);
    expect(ev.find((e) => e.type === 'RunEnded')).toMatchObject({ outcome: 'died' });
    expect(S(sim).run).toBeNull();
  });
});
