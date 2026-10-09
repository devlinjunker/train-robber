// The separate train map world model (flag U8, built first): boarding moves the player
// into a car frame, and the horse turns abstract until extraction brings it back.
// `world/continuous.ts` will implement the same interface with a physical horse.
import type { GameState, Placement, PlayerId, PlayerState, SimConfig } from '../types';
import { CAR_TEMPLATES, carEntryPoints, expandCars, type CarPose, type Side } from './cars';
import { Terrain, terrainAt, type WorldMap } from './map';
import { carPosesOf, trainSpeed } from './trains';

export interface Vec2 { x: number; y: number }

/** An entry point of one car of a train. */
export interface EntryRef { trainId: string; car: number; entry: string }

export interface WorldModel {
  readonly horseWhileAboard: 'physical' | 'abstract';
  /** The train's engine, its velocity, and every entry point in world space. */
  trainAnchor(state: GameState, trainId: string): { pos: Vec2; vel: Vec2; entryPoints: { car: number; id: string; side: Side; x: number; y: number }[] };
  /** A placement in world space; a car placement follows its car along the route. */
  toWorld(state: GameState, p: Placement): Vec2;
  /** Collision in the placement's own frame. */
  walkable(state: GameState, p: Placement): boolean;
  enterTrain(state: GameState, player: PlayerId, entry: EntryRef): void;
  leaveTrain(state: GameState, player: PlayerId): void;
}

export const WORLD_FRAME = 'world';
export const carFrame = (trainId: string, car: number) => `car:${trainId}:${car}`;

/** The train and car index of a car frame, or null for the world frame. */
export function parseCarFrame(frame: string): { trainId: string; car: number } | null {
  if (!frame.startsWith('car:')) return null;
  const i = frame.lastIndexOf(':');
  return { trainId: frame.slice(4, i), car: Number(frame.slice(i + 1)) };
}

/**
 * A car-frame point in world space. Car frames count cells from the front (x) and from the
 * left side (y); car poses put the front at +halfLength along (ux, uy) and the left side at
 * +halfWidth along (uy, -ux), as `entryPointWorld` does.
 */
export function carToWorld(car: CarPose, x: number, y: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  const along = car.halfLength - x, left = car.halfWidth - y;
  out.x = car.x + car.ux * along + car.uy * left;
  out.y = car.y + car.uy * along - car.ux * left;
  return out;
}

/** True when (x, y) in a car frame lies on a cell that does not block movement. */
export function carCellWalkable(template: string, x: number, y: number): boolean {
  const t = CAR_TEMPLATES[template];
  if (!t) return false;
  const c = Math.floor(x), r = Math.floor(y);
  if (c < 0 || r < 0 || c >= t.size.cols || r >= t.size.rows) return false;
  return t.cells[r * t.size.cols + c] !== 'wall';
}

export function createSeparateWorld(map: WorldMap, config: SimConfig): WorldModel {
  const templateOf = (state: GameState, trainId: string, car: number): string => {
    const t = state.world.trains.find((q) => q.id === trainId);
    const id = t ? expandCars(config.values.trains[t.type]!.cars)[car] : undefined;
    if (!id) throw new Error(`train ${trainId} has no car ${car}`);
    return id;
  };
  const playerOf = (state: GameState, id: PlayerId): PlayerState => {
    const p = state.players.find((q) => q.id === id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  };
  const model: WorldModel = {
    horseWhileAboard: 'abstract',
    trainAnchor(state, trainId) {
      const cars = carPosesOf(state, map, config, trainId);
      const train = state.world.trains.find((t) => t.id === trainId)!;
      const speed = trainSpeed(config, train.type);
      const engine = cars[0]!;
      return {
        pos: { x: engine.x, y: engine.y },
        vel: { x: engine.ux * speed, y: engine.uy * speed },
        entryPoints: cars.flatMap((c) => carEntryPoints(c).map((e) => ({ car: c.index, ...e }))),
      };
    },
    toWorld(state, p) {
      const f = parseCarFrame(p.frame);
      if (!f) return { x: p.x, y: p.y };
      const car = carPosesOf(state, map, config, f.trainId)[f.car];
      if (!car) throw new Error(`train ${f.trainId} has no car ${f.car}`);
      return carToWorld(car, p.x, p.y);
    },
    walkable(state, p) {
      const f = parseCarFrame(p.frame);
      if (!f) return terrainAt(map, p.x, p.y) !== Terrain.Blocked;
      return carCellWalkable(templateOf(state, f.trainId, f.car), p.x, p.y);
    },
    enterTrain(state, player, entry) {
      const ep = CAR_TEMPLATES[templateOf(state, entry.trainId, entry.car)]!.entryPoints.find((e) => e.id === entry.entry);
      if (!ep) throw new Error(`no entry point ${entry.entry} on car ${entry.car} of ${entry.trainId}`);
      const p = playerOf(state, player);
      // Land in the middle of the entry cell.
      p.placement = { frame: carFrame(entry.trainId, entry.car), x: ep.cell[0] + 0.5, y: ep.cell[1] + 0.5, layer: 'interior' };
      const h = state.world.horses.find((q) => q.id === p.horseId);
      if (h) { h.mode = 'away'; h.speed = 0; h.cruiseTarget = 0; h.stunTicks = 0; }
    },
    leaveTrain(state, player) {
      const p = playerOf(state, player);
      const at = model.toWorld(state, p.placement);
      p.placement = { frame: WORLD_FRAME, x: at.x, y: at.y, layer: 'ground' };
      const h = state.world.horses.find((q) => q.id === p.horseId);
      if (h) { h.mode = 'physical'; h.x = at.x; h.y = at.y; }
    },
  };
  return model;
}

/** Selects the world model for `config.world.mode`; only the separate map exists so far. */
export function createWorldModel(map: WorldMap, config: SimConfig): WorldModel {
  if (config.values.world.mode !== 'separate') throw new Error(`world mode ${config.values.world.mode} is not built yet`);
  return createSeparateWorld(map, config);
}

/** Radius of a walking player, for wall collision in car frames. */
export const WALKER_RADIUS = 0.3;

const axis = (v: number) => (v < -127 ? -127 : v > 127 ? 127 : v | 0) / 127;

/**
 * Tick system 5: players aboard walk their car at up to `player.speedTilesPerSec`, scaled by
 * the length of the `move` axes (the client walks at half and runs at full). Aboard, `move` is
 * in the car's frame, not the screen's: +x walks toward the front (lower cell x), +y toward the
 * right side (higher cell y). The client turns its screen keys into that frame, so the sim never
 * sees the screen. Each axis moves on its own so a wall stops one and the player slides along it.
 */
export function walkAboard(state: GameState, model: WorldModel, config: SimConfig): void {
  for (const p of state.players) {
    if (p.placement.frame === WORLD_FRAME) continue;
    const run = state.run?.players[p.id];
    let speed = config.values.player.speedTilesPerTick;
    if (run && run.stumbleTicks > 0) {
      speed *= config.values.boarding.landing.stumbleSpeedScale;
      run.stumbleTicks -= 1;
    }
    let mx = -axis(p.move.x), my = axis(p.move.y);
    const n = Math.sqrt(mx * mx + my * my);
    if (n === 0) continue;
    if (n > 1) { mx /= n; my /= n; }
    const pl = p.placement;
    const clear = (x: number, y: number) =>
      model.walkable(state, { ...pl, x: x - WALKER_RADIUS, y: y - WALKER_RADIUS }) && model.walkable(state, { ...pl, x: x + WALKER_RADIUS, y: y - WALKER_RADIUS })
      && model.walkable(state, { ...pl, x: x - WALKER_RADIUS, y: y + WALKER_RADIUS }) && model.walkable(state, { ...pl, x: x + WALKER_RADIUS, y: y + WALKER_RADIUS });
    const nx = pl.x + mx * speed;
    if (clear(nx, pl.y)) pl.x = nx;
    const ny = pl.y + my * speed;
    if (clear(pl.x, ny)) pl.y = ny;
  }
}
