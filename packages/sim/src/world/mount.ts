// Queries for the extraction horse (U4): which side of the train the player is on, the lane point
// beside their car the horse rides to, and whether a mount jump (or the grace window) applies.
// The client reads these too; the decisions stay in the sim.
import type { GameState, PlayerState, SimConfig, TrainSide } from '../types';
import { carBoardingTargets } from './boarding';
import { carCatalog, carTemplate, entryPointWorld, type CarPose } from './cars';
import { parseCarFrame } from './frames';
import type { WorldMap } from './map';
import { carPosesOf } from './trains';

/** The side of their car a player aboard is nearest: row 0 is the left side. Null in the world. */
export function playerSide(state: GameState, config: SimConfig, p: PlayerState): TrainSide | null {
  const f = parseCarFrame(p.placement.frame);
  const train = f && state.world.trains.find((t) => t.id === f.trainId);
  if (!f || !train) return null;
  return p.placement.y < carTemplate(carCatalog(config), train.cars[f.car]!).size.rows / 2 ? 'left' : 'right';
}

/** The car a player aboard stands in, placed for the current tick. */
export function playerCar(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState): CarPose | null {
  const f = parseCarFrame(p.placement.frame);
  return f ? carPosesOf(state, map, config, f.trainId)[f.car] ?? null : null;
}

/**
 * The point the horse rides to: `extraction.laneOffsetTiles` out from the side of the player's car,
 * level with the player along it (clamped to the car), with the car's axis for steering along it.
 */
export function laneTarget(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState, side: TrainSide): { x: number; y: number; ux: number; uy: number; car: CarPose } | null {
  const car = playerCar(state, map, config, p);
  if (!car) return null;
  const along = Math.max(-car.halfLength, Math.min(car.halfLength, car.halfLength - p.placement.x));
  const out = (car.halfWidth + config.values.extraction.laneOffsetTiles) * (side === 'left' ? 1 : -1);
  // Left of travel is (uy, -ux), as in entryPointWorld.
  return { x: car.x + car.ux * along + car.uy * out, y: car.y + car.uy * along - car.ux * out, ux: car.ux, uy: car.uy, car };
}

/** A side door (or the boarding platform) of the player's car on `side` within `extraction.doorReachTiles` of them, in car cells, with where it is in the world. */
export interface MountDoor { car: number; entry: string; reach: number; x: number; y: number }

export function mountDoor(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState, side: TrainSide): MountDoor | null {
  const f = parseCarFrame(p.placement.frame);
  const train = f && state.world.trains.find((t) => t.id === f.trainId);
  // Doors are below: none in reach from a roof.
  if (!f || !train || p.placement.layer === 'roof') return null;
  const t = carTemplate(carCatalog(config), train.cars[f.car]!);
  let best: MountDoor | null = null;
  for (const ep of t.sideEntries) {
    if (ep.side !== side) continue;
    // The door cell's centre, and the player's distance to it inside the car.
    const dx = ep.cell[0] + 0.5 - p.placement.x, dy = ep.cell[1] + 0.5 - p.placement.y;
    const reach = Math.sqrt(dx * dx + dy * dy);
    if (reach > config.values.extraction.doorReachTiles || (best && reach >= best.reach)) continue;
    const car = carPosesOf(state, map, config, f.trainId)[f.car];
    if (!car) continue;
    best = { car: f.car, entry: ep.id, reach, ...entryPointWorld(car, ep) };
  }
  // The platform you can land on from the horse (the caboose's, Devlin PR #65) is a way off too: stand
  // by its corner on the horse's side.
  const car = carPosesOf(state, map, config, f.trainId)[f.car];
  if (car) {
    for (const tg of carBoardingTargets(config, car, train.cars)) {
      if (tg.kind !== 'platform' || tg.side !== side) continue;
      const dx = tg.land.x - p.placement.x, dy = tg.land.y - p.placement.y, reach = Math.sqrt(dx * dx + dy * dy);
      if (reach > config.values.extraction.doorReachTiles || (best && reach >= best.reach)) continue;
      best = { car: f.car, entry: tg.id, reach, x: tg.x, y: tg.y };
    }
  }
  return best;
}

/** Whether Space would try a mount now: `eligible` sweeps the meter, anything else is the refusal. */
export type MountState = 'eligible' | 'no horse' | 'not at a door' | 'horse too far';

export interface MountCheck { state: MountState; door: MountDoor | null; horseDistance: number }

/** The mount rule: the horse alongside, the player at a door on its side, and the horse within `extraction.mountRangeTiles` of that door. */
export function mountCheck(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState): MountCheck {
  const run = state.run;
  const call = run?.horse;
  if (!run || run.phase !== 'extracting' || !call || call.state !== 'alongside') return { state: 'no horse', door: null, horseDistance: Infinity };
  const door = mountDoor(state, map, config, p, call.side);
  if (!door) return { state: 'not at a door', door: null, horseDistance: Infinity };
  const h = state.world.horses.find((q) => q.id === p.horseId);
  if (!h || h.mode !== 'physical') return { state: 'no horse', door, horseDistance: Infinity };
  const d = Math.sqrt((h.x - door.x) ** 2 + (h.y - door.y) ** 2);
  return { state: d <= config.values.extraction.mountRangeTiles ? 'eligible' : 'horse too far', door, horseDistance: d };
}

/** G18 grace: the horse is alongside and the player is within reach of a door on its side. */
export function escaping(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState): boolean {
  const call = state.run?.horse;
  return !!call && call.state === 'alongside' && mountDoor(state, map, config, p, call.side) !== null;
}
