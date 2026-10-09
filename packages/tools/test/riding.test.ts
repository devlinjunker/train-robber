// The M2 sim on the real config and the alpha-flats map, for every steering and throttle variant.
import { describe, it, expect } from 'vitest';
import { createSim, nextInt, pointInBox, seedRng, type Command } from '@train-robber/sim';
import { loadConfig, loadMapDef } from '../src/content';

const map = loadMapDef('alpha-flats');

describe('riding on alpha-flats', () => {
  for (const steering of ['screen-relative', 'heading-relative']) {
    for (const throttleModel of ['hold', 'coast', 'cruise']) {
      it(`${steering} + ${throttleModel}: random riders never end a tick inside a car`, () => {
        const config = loadConfig({ preset: 'alpha-default', variants: { steering, throttleModel } });
        const sim = createSim({ config, map, seed: `${steering}-${throttleModel}`, playerIds: [1] });
        const rng = seedRng(`bot-${steering}-${throttleModel}`);
        const axis = () => [-127, 0, 127][nextInt(rng, 'misc', 3)]!;
        const h = sim.state.world.horses[0]!;
        for (let t = 0; t < 60 * 90; t++) {
          const commands: Command[] = t % 30 === 0 ? [{ type: 'move', x: axis(), y: nextInt(rng, 'misc', 4) === 0 ? 127 : -127 }, { type: 'steer', x: axis(), y: axis() }] : [];
          // Head back toward the bottom straight when the bot wanders off.
          if (h.y < 120 || h.y > 160) commands.push({ type: 'steer', x: 0, y: h.y < 120 ? 127 : -127 });
          sim.step([{ player: 1, commands }]);
          for (const car of sim.cars()) expect(pointInBox(h.x, h.y, car)).toBe(false);
        }
      });
    }
  }

  it('the player starts mounted and stopped at playerSpawn, and the blank train loops in about 81 s', () => {
    const config = loadConfig();
    const sim = createSim({ config, map, seed: 's', playerIds: [1] });
    expect(sim.state.world.horses[0]).toMatchObject({ x: 200, y: 170, speed: 0 });
    expect(sim.cars().map((c) => c.template)).toEqual(['engine', 'blank-car', 'blank-car', 'blank-car']);
    const lapTicks = map.routes[0]!.length / config.values.trains.blank!.speedTilesPerTick;
    expect(lapTicks / 60).toBeCloseTo(81.2, 1);
  });
});
