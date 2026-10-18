// Checks that run the sim on a map: its trains start, a full lap runs, and no two trains touch.
// Shared by the hand-made maps test and the generated maps test.
import type { MapDef } from '@train-robber/config';
import { createSim } from '@train-robber/sim';
import { loadConfig } from '../content';

/** The map's own trains (trainMix `map`), not the default mixed trains. */
const mapTrainsConfig = () => loadConfig({ preset: 'map-trains' });
type Config = ReturnType<typeof mapTrainsConfig>;
/** The slowest train speed in tiles per tick, so a lap at it covers every train's route. */
const slowest = (config: Config) => Math.min(...Object.values(config.values.trains).map((t) => t.speedTilesPerTick));
const lapTicks = (map: MapDef, config: Config) => Math.ceil(Math.max(...map.routes.map((r) => r.length)) / slowest(config));

/** Spawn mounted at playerSpawn, start the map's trains, and run a full lap of the longest route. */
export function lapProblems(map: MapDef, seed: string, config = mapTrainsConfig()): string[] {
  const out: string[] = [];
  const sim = createSim({ config, map, seed, playerIds: [1] });
  const h = sim.state.world.horses[0];
  if (!h || h.x !== map.markers.playerSpawn.x || h.y !== map.markers.playerSpawn.y || h.speed !== 0) out.push('rider does not start still at playerSpawn');
  const trains = map.trains?.length ?? 1;
  if (sim.state.world.trains.length !== trains) out.push(`${sim.state.world.trains.length} trains, expected ${trains}`);
  for (let t = 0, n = lapTicks(map, config); t < n; t++) sim.step([{ player: 1, commands: [] }]);
  // Engine, its cars and the caboose, if any, for each train.
  const carsOf = (type: string) => { const d = config.values.trains[type]!; return 1 + d.carCount + (d.caboose ? 1 : 0); };
  const want = sim.state.world.trains.reduce((n, t) => n + carsOf(t.type), 0);
  if (sim.cars().length !== want) out.push(`${sim.cars().length} cars after a lap, expected ${want}`);
  return out;
}

/** Over a lap, every car of each train stays more than 12 tiles from every car of the others. */
export function trainGapProblems(map: MapDef, seed: string, config = mapTrainsConfig()): string[] {
  const out: string[] = [];
  const sim = createSim({ config, map, seed, playerIds: [1] });
  for (let t = 0, n = lapTicks(map, config); t < n && out.length < 10; t += 30) {
    const cars = sim.cars();
    for (const a of cars) for (const b of cars) {
      if (a.trainId < b.trainId && !(Math.hypot(a.x - b.x, a.y - b.y) > 12)) out.push(`${a.trainId} and ${b.trainId} touch at tick ${t}`);
    }
    for (let k = 0; k < 30; k++) sim.step([{ player: 1, commands: [] }]);
  }
  return out;
}
