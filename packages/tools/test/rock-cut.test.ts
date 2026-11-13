// The rock-cut test map and fall-test preset (issue #59): rocks along the inside ledge of the top
// straight knock a player standing there off the train, so the cost of a fall can be playtested on
// demand, next to a roof fall (every car has ladders in fall-test).
import { describe, it, expect } from 'vitest';
import { carFrame, createSim, doorsClosed, type Command, type GameState, type Sim, type SimEvent } from '@train-robber/sim';
import { loadConfig, loadMapDef } from '../src/content';

const config = loadConfig({ preset: 'fall-test' });
const map = loadMapDef('rock-cut');
const S = (sim: Sim) => sim.state as GameState;
const ROWS = 7;

/** Committed to the first train, engine at the start of the top straight, standing on car 1 at (x, y). */
function aboard(x: number, y: number, layer: 'interior' | 'roof' = 'interior'): Sim {
  const sim = createSim({ config, map, seed: 'rock-cut', playerIds: [1] });
  const s = S(sim);
  const train = s.world.trains[0]!;
  train.d = 60;
  // Ride up beside the train so it is in range to commit to.
  const car = sim.cars().find((c) => c.trainId === train.id && c.index === 1)!;
  Object.assign(s.world.horses[0]!, { x: car.x, y: car.y - 6 });
  sim.step([{ player: 1, commands: [{ type: 'startRun', trainId: train.id }] }]);
  s.run!.phase = 'aboard';
  s.world.horses[0]!.mode = 'away';
  s.players[0]!.placement = { frame: carFrame(train.id, 1), x, y, layer };
  s.run!.players[1]!.carried = ['letter', 'letter', 'parcel', 'parcel'];
  return sim;
}

/** Steps until the player falls off (or `sec` runs out), sending `each` every tick and `first` on the first. */
function untilFall(sim: Sim, sec: number, each: Command[] = [], first: Command[] = []): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < 60 * sec && !events.some((e) => e.type === 'FellOff'); i++) {
    events.push(...sim.step([{ player: 1, commands: i === 1 ? [...each, ...first] : each }]).events);
  }
  return events;
}

const cost = (sim: Sim, ev: SimEvent[]) => ({
  damage: ev.filter((e) => e.type === 'DamageDealt' && e.cause === 'fell').map((e) => (e as { amount: number }).amount),
  lootLost: ev.filter((e) => e.type === 'LootLost').length,
  doorsShut: doorsClosed(S(sim), S(sim).world.trains[0]!),
  thrown: ev.some((e) => e.type === 'ThrownOff' || e.type === 'RunEnded'),
});

describe('rock-cut map with the fall-test preset', () => {
  it('a rock knocks you off the inside ledge on the top straight within a few seconds; the outside ledge stays clear', () => {
    const inside = untilFall(aboard(10.5, ROWS + 0.05), 20);
    expect(inside.filter((e) => e.type === 'FellOff')).toEqual([expect.objectContaining({ car: 1, cause: 'rock' })]);
    expect(untilFall(aboard(10.5, -0.05), 20).filter((e) => e.type === 'FellOff')).toEqual([]);
  });

  it('a bad roof jump costs the same as a rock: failure damage, half the loot, doors left open', () => {
    const rockSim = aboard(10.5, ROWS + 0.05);
    const rock = untilFall(rockSim, 20);
    const run: Command = { type: 'move', x: 127, y: 0 };
    const roofSim = aboard(2.3, 0.5, 'roof');
    const roof = untilFall(roofSim, 2, [run], [{ type: 'jump' }]);
    expect(roof.filter((e) => e.type === 'FellOff')).toEqual([expect.objectContaining({ cause: 'jump' })]);
    const expected = { damage: [config.values.health.max * config.values.boarding.failure.damageFraction], lootLost: 2, doorsShut: false, thrown: false };
    expect(cost(rockSim, rock)).toEqual(expected);
    expect(cost(roofSim, roof)).toEqual(expected);
  });
});
