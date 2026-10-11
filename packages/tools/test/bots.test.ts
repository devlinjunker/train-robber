// A small slice of the `npm run bots` sweep, and the invariant check catching planted faults.
import { describe, it, expect } from 'vitest';
import { createSim, type GameState } from '@train-robber/sim';
import { BOT_KINDS, checkInvariants, runBotSweep, VARIANT_COMBOS } from '../src/bots';
import { loadConfig, loadMapDef } from '../src/content';

describe('bot sweep', () => {
  it('every bot kind over every variant combo breaks no invariant, and the chaser boards', () => {
    const r = runBotSweep({ seeds: VARIANT_COMBOS.length * 2, seconds: 60 });
    expect(r.violations).toEqual([]);
    expect(r.runs).toBe(VARIANT_COMBOS.length * 2 * BOT_KINDS.length);
    expect(r.reports.idle.runs).toBe(0);
    expect(r.reports.random.runs).toBeGreaterThan(0);
    expect(r.reports.chaser.boarded).toBeGreaterThan(0);
  }, 60_000);

  it('the invariant check catches a horse inside a car, a bad speed and a stray placement', () => {
    const config = loadConfig();
    const sim = createSim({ config, map: loadMapDef(), seed: 'inv', playerIds: [1] });
    sim.step([{ player: 1, commands: [] }]);
    expect(checkInvariants(sim, config)).toBeNull();
    const s = sim.state as GameState;
    const h = s.world.horses[0]!;
    const car = sim.cars()[1]!;
    Object.assign(h, { x: car.x, y: car.y });
    expect(checkInvariants(sim, config)).toMatch(/inside car/);
    Object.assign(h, { x: 200, y: 170, speed: 99 });
    expect(checkInvariants(sim, config)).toMatch(/speed 99/);
    h.speed = 0;
    s.players[0]!.placement = { frame: 'car:blank-1:1', x: 4, y: 3, layer: 'interior' };
    expect(checkInvariants(sim, config)).toMatch(/in car:blank-1:1 in phase idle/);
  });
});
