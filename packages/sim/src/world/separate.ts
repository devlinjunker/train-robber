// The separate train map world model (flag U8, built first): boarding moves the player
// into a car frame, and the horse stays physical, riderless, until it leaves (phase 2, U4).
// `world/continuous.ts` will implement the same interface with a physical horse.
import type { GameState, Placement, PlayerId, PlayerState, SimConfig } from '../types';
import { carCatalog, carEntryPoints, carTemplate, type CarPose, type Side } from './cars';
import { gridCell, gridWalkable, fromTrain, Space, toTrain, trainGrid, type TrainGrid } from './guards';
import { carrySpeedScale, carriedWeight } from './loot';
import { WORLD_FRAME, carFrame, parseCarFrame } from './frames';
import { isSolid, terrainAt, type WorldMap } from './map';
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

export { WORLD_FRAME, carFrame, parseCarFrame } from './frames';

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

/**
 * True when (x, y) in car `car`'s frame of a train lies on a cell that does not block movement,
 * past the car's walls included: its platforms, ledges and coupling, and on into the next car.
 */
export function trainCellWalkable(config: SimConfig, cars: readonly string[], car: number, x: number, y: number): boolean {
  const g = trainGrid(config, cars);
  return gridWalkable(g, toTrain(g, car, x), y);
}

/**
 * True when a walker (WALKER_RADIUS round) fits at train point (lx, y): its edges on open cells
 * and its middle where one can stand. On a ledge the walker presses flat against the wall: across
 * the car it takes at most half the ledge's width, so a ledge of any width can be walked.
 */
export function walkerFits(g: TrainGrid, lx: number, y: number): boolean {
  const i = gridCell(g, lx, y);
  if (i < 0 || g.blocksMove[i] !== 0 || y < g.yMin[i]! || y >= g.yMax[i]!) return false;
  // The centre must stand on something; the body only bumps into the car itself (walls, props),
  // never open air, so a platform or ledge of any depth or width can be walked.
  const r = WALKER_RADIUS;
  const ry = g.space[i] === Space.Ledge ? Math.min(r, g.ledgeWidth / 2) : r;
  return !solid(g, lx - r, y - ry) && !solid(g, lx + r, y - ry) && !solid(g, lx - r, y + ry) && !solid(g, lx + r, y + ry);
}

/** True when the train point is in a car cell that blocks walking. */
function solid(g: TrainGrid, lx: number, y: number): boolean {
  const i = gridCell(g, lx, y);
  return i >= 0 && g.space[i] === Space.Inside && g.blocksMove[i] !== 0;
}

/** `walkerFits` in car `car`'s frame of a train made of `cars`. */
export function trainWalkerFits(config: SimConfig, cars: readonly string[], car: number, x: number, y: number): boolean {
  const g = trainGrid(config, cars);
  return walkerFits(g, toTrain(g, car, x), y);
}

/** The car templates of a train in state; throws when it is gone. */
export function trainCars(state: GameState, trainId: string): string[] {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) throw new Error(`no train ${trainId}`);
  return t.cars;
}

export function createSeparateWorld(map: WorldMap, config: SimConfig): WorldModel {
  const catalog = carCatalog(config);
  const templateOf = (state: GameState, trainId: string, car: number): string => {
    const id = trainCars(state, trainId)[car];
    if (!id) throw new Error(`train ${trainId} has no car ${car}`);
    return id;
  };
  const playerOf = (state: GameState, id: PlayerId): PlayerState => {
    const p = state.players.find((q) => q.id === id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  };
  const model: WorldModel = {
    horseWhileAboard: 'physical',
    trainAnchor(state, trainId) {
      const cars = carPosesOf(state, map, config, trainId);
      const train = state.world.trains.find((t) => t.id === trainId)!;
      const speed = trainSpeed(config, train.type);
      const engine = cars[0]!;
      return {
        pos: { x: engine.x, y: engine.y },
        vel: { x: engine.ux * speed, y: engine.uy * speed },
        entryPoints: cars.flatMap((c) => carEntryPoints(c, catalog).map((e) => ({ car: c.index, ...e }))),
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
      if (!f) return !isSolid(terrainAt(map, p.x, p.y));
      return trainCellWalkable(config, trainCars(state, f.trainId), f.car, p.x, p.y);
    },
    enterTrain(state, player, entry) {
      const ep = carTemplate(catalog, templateOf(state, entry.trainId, entry.car)).entryPoints.find((e) => e.id === entry.entry);
      if (!ep) throw new Error(`no entry point ${entry.entry} on car ${entry.car} of ${entry.trainId}`);
      const p = playerOf(state, player);
      // Land in the middle of the entry cell.
      p.placement = { frame: carFrame(entry.trainId, entry.car), x: ep.cell[0] + 0.5, y: ep.cell[1] + 0.5, layer: 'interior' };
      // The horse stays in the world, riderless: it runs off and leaves (U4, see extraction.ts).
      const h = state.world.horses.find((q) => q.id === p.horseId);
      if (h) { h.cruiseTarget = 0; h.stunTicks = 0; h.boostTicks = 0; h.boostCooldownTicks = 0; }
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
/** Closest a player walks up to a guard: two walker radii. */
const GUARD_BLOCK = WALKER_RADIUS * 2;

const axis = (v: number) => (v < -127 ? -127 : v > 127 ? 127 : v | 0) / 127;

/**
 * Tick system 5: players aboard walk the train at up to `player.speedTilesPerSec`, scaled by the
 * length of the `move` axes (the client walks at half and runs at full), by the weight they carry
 * (`carry.slowdownEnabled`), by `verbs.search.walkSpeedScale` while searching, and crouching walks at
 * `player.crouch.speedScale` of full speed whatever the axes say. Outside the walls no one goes
 * faster than the space allows (`outside.platformSpeedTilesPerSec` on a platform or the coupling,
 * `ledgeSpeedTilesPerSec` on a ledge). Aboard, `move` is in the car's frame, not the screen's: +x
 * walks toward the front (lower cell x), +y toward the right side (higher cell y). The client turns
 * its screen keys into that frame, so the sim never sees the screen. Each axis moves on its own so
 * a wall stops one and the player slides along it. Crossing to another car's stretch (through the
 * end doors and over the coupling) carries the player into that car's frame, so the whole train,
 * outside included, is one space.
 */
export function walkAboard(state: GameState, config: SimConfig): void {
  for (const p of state.players) {
    const f = parseCarFrame(p.placement.frame);
    if (!f) continue;
    const run = state.run?.players[p.id];
    let speed = config.values.player.speedTilesPerTick;
    if (run && run.stumbleTicks > 0) {
      speed *= config.values.boarding.landing.stumbleSpeedScale;
      run.stumbleTicks -= 1;
    }
    if (run) {
      speed *= carrySpeedScale(config, carriedWeight(config, run.carried));
      if (run.search) speed *= config.values.verbs.search.walkSpeedScale;
    }
    let mx = -axis(p.move.x), my = axis(p.move.y);
    const n = Math.sqrt(mx * mx + my * my);
    if (n === 0) continue;
    if (n > 1) { mx /= n; my /= n; }
    // Crouched, any move is the same slow creep, so Shift does not make it faster.
    if (run?.crouched) { const m = Math.sqrt(mx * mx + my * my); mx /= m; my /= m; speed *= config.values.player.crouch.speedScale; }
    const pl = p.placement;
    const grid = trainGrid(config, trainCars(state, f.trainId));
    // Car-frame x is kept as it is and only offset for the grid, so a walk inside one car moves exactly as before.
    const off = toTrain(grid, f.car, 0);
    const here = gridCell(grid, off + pl.x, pl.y);
    if (here >= 0) {
      // Past the axes' share of full speed, the cap trims the step, so walking and running are the same on a ledge.
      const cap = grid.speedCap[here]!, m = Math.sqrt(mx * mx + my * my);
      if (speed * m > cap) speed = cap / m;
    }
    const clear = (x: number, y: number) => walkerFits(grid, off + x, y);
    // Guards stand in the way: a step may not end closer to one than GUARD_BLOCK, unless it moves away.
    const guards = (state.run?.trainId === f.trainId ? state.run.guards : [])
      .map((g) => ({ x: g.car === f.car ? g.x : toTrain(grid, g.car, g.x) - off, y: g.y }))
      .filter((g) => Math.abs(g.x - pl.x) < 2 && Math.abs(g.y - pl.y) < 2);
    const free = (x: number, y: number) => guards.every((g) => {
      const d2 = (g.x - x) ** 2 + (g.y - y) ** 2;
      return d2 >= GUARD_BLOCK * GUARD_BLOCK || d2 >= (g.x - pl.x) ** 2 + (g.y - pl.y) ** 2;
    });
    const nx = pl.x + mx * speed;
    if (clear(nx, pl.y) && free(nx, pl.y)) pl.x = nx;
    const ny = pl.y + my * speed;
    if (clear(pl.x, ny) && free(pl.x, ny)) pl.y = ny;
    // Into another car's stretch: carry on in that car's frame.
    const at = fromTrain(grid, off + pl.x);
    if (at.car !== f.car) {
      pl.frame = carFrame(f.trainId, at.car);
      pl.x = pl.x + off - toTrain(grid, at.car, 0);
    }
  }
}

/** The outside space a player aboard stands in, or `Space.Inside`; null when not aboard. */
export function playerSpace(state: GameState, config: SimConfig, p: PlayerState): Space | null {
  const f = parseCarFrame(p.placement.frame);
  if (!f) return null;
  const t = state.world.trains.find((q) => q.id === f.trainId);
  if (!t) return null;
  const grid = trainGrid(config, t.cars);
  const i = gridCell(grid, toTrain(grid, f.car, p.placement.x), p.placement.y);
  return (i < 0 ? Space.None : grid.space[i]!) as Space;
}
