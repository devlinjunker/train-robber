// Rules every playtest map in maps-src must keep, whatever its shape: it builds to the checked-in
// file, the blank train has its route, one side of the track is always open to ride beside, and the rider
// can reach the track from the spawn.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeZones, ZONES } from '@train-robber/config';
import { createSim } from '@train-robber/sim';
import { buildMapFile, stringifyMap } from '../src/maps/build';
import { MAPS_OUT, MAPS_SRC } from '../src/maps/cli';
import { loadConfig } from '../src/content';

/** No rock or water this close to the centre line: the cars are 6 tiles wide. */
const CAR_CLEAR_TILES = 3.5;
/**
 * Distances from the centre line where a rider lines up with a door (boarding range is 2 tiles).
 * Mud and rocks may fill this lane on one side, never on both at once.
 */
const LANE_TILES = [3.5, 4, 4.5, 5, 5.5];
/** Tightest baked curve allowed; rigid 16-tile cars cut visibly inside anything tighter. */
const MIN_RADIUS_TILES = 17;

const ids = readdirSync(MAPS_SRC).filter((f) => f.endsWith('.tmj')).map((f) => f.replace(/\.tmj$/, '')).sort();

describe.each(ids)('map %s', (id) => {
  const { map, minRadiusTiles } = buildMapFile(join(MAPS_SRC, `${id}.tmj`));
  const { cols, rows } = map.size;
  const grid = decodeZones(map);
  const zone = (x: number, y: number) => ZONES[grid[y * cols + x]!]!;
  const rideable = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && (zone(x, y) === 'open' || zone(x, y) === 'slow');
  const main = map.routes.find((r) => r.id === 'main');

  it('matches the checked-in build', () => {
    expect(stringifyMap(map)).toBe(readFileSync(join(MAPS_OUT, `${id}.json`), 'utf8'));
  });

  it('has a closed main route for the blank train, with no curve tighter than the cars allow', () => {
    expect(main?.closed).toBe(true);
    expect(minRadiusTiles).toBeGreaterThanOrEqual(MIN_RADIUS_TILES);
  });

  it('keeps rock and water off the cars and leaves one side of the track open to ride beside', () => {
    const { x: xs, y: ys, tx, ty } = main!.samples;
    const at = (i: number, side: number, d: number) => zone(Math.floor(xs[i]! - ty[i]! * d * side), Math.floor(ys[i]! + tx[i]! * d * side));
    for (let i = 0; i < xs.length; i++) {
      for (let d = 0; d <= CAR_CLEAR_TILES; d += 0.25) {
        for (const side of [-1, 1]) expect(['open', 'slow'], `${id}: ${at(i, side, d)} ${d} tiles beside sample ${i}`).toContain(at(i, side, d));
      }
      const open = (side: number) => LANE_TILES.every((d) => at(i, side, d) === 'open');
      expect(open(-1) || open(1), `${id}: no open lane beside sample ${i}`).toBe(true);
    }
  });

  it('lets the rider reach the track from the spawn', () => {
    const start = map.markers.playerSpawn;
    const seen = new Uint8Array(cols * rows);
    const queue = [Math.floor(start.y) * cols + Math.floor(start.x)];
    seen[queue[0]!] = 1;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!, x = i % cols, y = (i - x) / cols;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (rideable(nx, ny) && !seen[ny * cols + nx]) { seen[ny * cols + nx] = 1; queue.push(ny * cols + nx); }
      }
    }
    const { x: xs, y: ys } = main!.samples;
    for (let i = 0; i < xs.length; i += 50) expect(seen[Math.floor(ys[i]!) * cols + Math.floor(xs[i]!)], `${id}: sample ${i}`).toBe(1);
  });

  it('runs the sim for a full lap', () => {
    const config = loadConfig();
    const sim = createSim({ config, map, seed: id, playerIds: [1] });
    expect(sim.state.world.horses[0]).toMatchObject({ x: map.markers.playerSpawn.x, y: map.markers.playerSpawn.y, speed: 0 });
    const lapTicks = Math.ceil(main!.length / config.values.trains.blank!.speedTilesPerTick);
    for (let t = 0; t < lapTicks; t++) sim.step([{ player: 1, commands: [] }]);
    expect(sim.cars()).toHaveLength(4);
  });
});
