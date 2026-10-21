// Walking on the roofs (sneaking PR 3). A ladder on each car's end platform leads up (E at it);
// on top you walk slower and louder for the guard below, jump the gaps between cars (Space) as a
// skill check, and lean into curves so you do not slip off. Rocks cannot reach you up there.
//
// The player's placement keeps its car frame, with `layer: 'roof'`: x along the car's roof, y across
// it. Climbing, jumps and slips live in the run's player state, so a snapshot resumes mid-jump.
import type { CarEnd, FallCause, GameState, PlayerRunState, PlayerState, SimConfig, SimEvent } from '../types';
import { carCatalog, carSpacing, carTemplate } from './cars';
import { carFrame, parseCarFrame } from './frames';
import { fromTrain, gridCell, gridWalkable, onRoof, roofCarAt, Space, toTrain, trainGrid, trainLadders, type Ladder, type TrainGrid } from './guards';
import { carrySpeedScale, carriedWeight } from './loot';
import type { WorldMap } from './map';
import { trackAt } from './track';
import { routeOf, trainSpeed } from './trains';
import { WALKER_RADIUS, walkerFits } from './separate';

/** What the roof systems need from the tick; `RunCtx` satisfies it. */
export interface RoofCtx {
  state: GameState;
  map: WorldMap;
  config: SimConfig;
  emit(ev: SimEvent): void;
}

const axis = (v: number) => (v < -127 ? -127 : v > 127 ? 127 : v | 0) / 127;
/** A move axis across the car past this share of full counts as leaning against a slip. */
const LEAN_AXIS = 0.3;

/** The fresh roof state of a player's run: on the deck, nothing going on. */
export function freshRoofState(): Pick<PlayerRunState, 'climb' | 'air' | 'slip' | 'slipCooldownTicks' | 'thudTicks'> {
  return { climb: null, air: null, slip: null, slipCooldownTicks: 0, thudTicks: 0 };
}

/** The ladder a player could climb now: the nearest within `outside.roof.ladderReachTiles`, at its foot on a platform or its top on the roof; null when none. */
export function ladderInReach(state: GameState, config: SimConfig, p: PlayerState): Ladder | null {
  const f = parseCarFrame(p.placement.frame);
  const train = f && state.world.trains.find((t) => t.id === f.trainId);
  if (!f || !train || !config.values.outside.roof.enabled) return null;
  const g = trainGrid(config, train.cars);
  const lx = toTrain(g, f.car, p.placement.x), y = p.placement.y;
  const roof = p.placement.layer === 'roof';
  // From below, only standing on a platform: a ladder never reaches through the end wall.
  if (!roof) { const i = gridCell(g, lx, y); if (i < 0 || g.space[i] !== Space.Platform) return null; }
  const reach = config.values.outside.roof.ladderReachTiles;
  let best: Ladder | null = null, bestD = reach * reach;
  for (const l of trainLadders(config, train.cars)) {
    if (roof && l.car !== f.car) continue;
    const x = roof ? g.offsets[l.car]! + l.roofX : l.deckLx;
    const d = (x - lx) ** 2 + (l.y - y) ** 2;
    if (d <= bestD) { bestD = d; best = l; }
  }
  return best;
}

/** E at a ladder: start climbing it. Refused off a run, mid-jump or mid-slip, already climbing, or with no ladder in reach. */
export function climb(ctx: RoofCtx & { emit(ev: SimEvent): void }, p: PlayerState, reject: (reason: 'not aboard' | 'busy' | 'no ladder' | 'disabled') => void): void {
  const run = ctx.state.run;
  const rp = run?.players[p.id];
  if (!rp || (run!.phase !== 'aboard' && run!.phase !== 'extracting') || !parseCarFrame(p.placement.frame)) return reject('not aboard');
  if (!ctx.config.values.outside.roof.enabled) return reject('disabled');
  if (rp.climb || rp.air || rp.slip) return reject('busy');
  const l = ladderInReach(ctx.state, ctx.config, p);
  if (!l) return reject('no ladder');
  rp.climb = { ticks: Math.max(1, ctx.config.values.outside.roof.climbTicks), car: l.car, end: l.end, to: p.placement.layer === 'roof' ? 'deck' : 'roof' };
  rp.search = null;
}

/** The roof walking speed this tick, in tiles per tick, before the move axes: run speed scaled by what is carried. */
function roofSpeed(config: SimConfig, rp: PlayerRunState): number {
  return config.values.outside.roof.speedTilesPerTick * carrySpeedScale(config, carriedWeight(config, rp.carried));
}

/** The move axes in the car frame (+x toward the rear, +y toward the right side), at most length 1, and their length before that. */
function moveAxes(p: PlayerState): { mx: number; my: number; n: number } {
  let mx = -axis(p.move.x), my = axis(p.move.y);
  const n = Math.sqrt(mx * mx + my * my);
  if (n > 1) { mx /= n; my /= n; }
  return { mx, my, n };
}

/**
 * Space on a roof: jump the way you are moving. The jump carries you `outside.roof.jump.pushTiles`
 * plus your speed for `jump.airSec`, so only a running jump clears a gap, and only from near the
 * edge. Refused standing still, mid-climb, mid-slip or already in the air.
 */
export function roofJump(ctx: RoofCtx, p: PlayerState, reject: (reason: 'busy' | 'standing still') => void): void {
  const rp = ctx.state.run?.players[p.id];
  const f = parseCarFrame(p.placement.frame);
  if (!rp || !f) return;
  if (rp.climb || rp.air || rp.slip) return reject('busy');
  const { mx, my, n } = moveAxes(p);
  if (n === 0) return reject('standing still');
  const j = ctx.config.values.outside.roof.jump;
  const m = Math.sqrt(mx * mx + my * my);
  let speed = roofSpeed(ctx.config, rp) * Math.min(1, n);
  if (rp.crouched) speed = roofSpeed(ctx.config, rp) * ctx.config.values.player.crouch.speedScale;
  const air = Math.max(1, j.airTicks);
  const step = speed + j.pushTiles / air;
  rp.air = { ticks: air, vx: (mx / m) * step, vy: (my / m) * step };
  ctx.emit({ type: 'RoofJumped', tick: ctx.state.tick, player: p.id, car: f.car, distanceTiles: step * air });
}

/**
 * The pull of the curve on car `car` of a train, in tiles/s² across the car frame: + pushes toward
 * the right side (+y), - toward the left. It is the train's speed squared times the curvature of the
 * track under the car, from the turn between the tangents at the car's front and rear (so no trig).
 */
export function curvePull(state: GameState, map: WorldMap, config: SimConfig, trainId: string, car: number): number {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) return 0;
  const { route } = routeOf(map, config, t);
  const catalog = carCatalog(config), spacing = carSpacing(config);
  let off = 0;
  for (let i = 0; i < car; i++) off += carTemplate(catalog, t.cars[i]!).size.cols + spacing;
  const len = carTemplate(catalog, t.cars[car]!).size.cols;
  const a = trackAt(route, t.d - off), b = trackAt(route, t.d - off - len);
  // Turning right (the front tangent clockwise of the rear one on screen) throws you to the left.
  const cross = b.tx * a.ty - b.ty * a.tx;
  const v = trainSpeed(config, t.type);
  return len > 0 ? -(v * v * cross) / len : 0;
}

/**
 * Nudge a point on a platform or the coupling until a walker fits there (out of the end wall), at
 * most half a tile along the train; the point itself when it already fits or nothing near does.
 */
function settle(g: TrainGrid, lx: number, y: number): number {
  if (walkerFits(g, lx, y)) return lx;
  for (let d = 0.05; d <= 0.5 + 1e-9; d += 0.05) {
    if (walkerFits(g, lx - d, y)) return lx - d;
    if (walkerFits(g, lx + d, y)) return lx + d;
  }
  return lx;
}

/**
 * Come down at train point (lx, y): on a roof if one is under you, else on whatever is below (a
 * platform, the coupling plate or a ledge), staggering for `outside.roof.dropStumbleSec`, else off
 * the train. Returns the fall's cause, or null.
 */
function comeDown(ctx: RoofCtx, p: PlayerState, rp: PlayerRunState, g: TrainGrid, trainId: string, lx: number, y: number, jumped: boolean): FallCause | null {
  const rc = ctx.config.values.outside.roof;
  const k = roofCarAt(g, lx);
  if (k >= 0 && y >= 0 && y < g.carRows[k]!) {
    const rows = g.carRows[k]!;
    p.placement = { frame: carFrame(trainId, k), x: lx - g.offsets[k]!, y: Math.max(WALKER_RADIUS, Math.min(rows - WALKER_RADIUS, y)), layer: 'roof' };
    rp.thudTicks = rc.noise.landTicks;
    ctx.emit({ type: 'RoofLanded', tick: ctx.state.tick, player: p.id, car: k, on: 'roof', jumped });
    return null;
  }
  if (!gridWalkable(g, lx, y)) return jumped ? 'jump' : 'slip';
  const space = g.space[gridCell(g, lx, y)]!;
  const sx = settle(g, lx, y);
  const at = fromTrain(g, sx);
  p.placement = { frame: carFrame(trainId, at.car), x: at.x, y, layer: 'interior' };
  rp.stumbleTicks = Math.max(rp.stumbleTicks, rc.dropStumbleTicks);
  rp.search = null;
  const on = space === Space.Coupling ? 'coupling' : space === Space.Ledge ? 'ledge' : 'platform';
  ctx.emit({ type: 'RoofLanded', tick: ctx.state.tick, player: p.id, car: at.car, on, jumped });
  return null;
}

/**
 * Tick system 5a, after walking aboard (sneaking PR 3): ladders, roof walking, jumps and slips for
 * every player aboard the run's train. Climbing counts down `outside.roof.climbSec` and then puts you
 * at the other end of the ladder (`Climbed`). In the air you move at the jump's step and come down
 * when it runs out (`comeDown`). Otherwise, on a roof, you walk at `outside.roof.speedTilesPerSec`
 * (walking half, crouched that times `player.crouch.speedScale`); the roof's long edges stop you, and
 * walking off an end drops you onto the platform below. On a curve, `curvePull` times your share of
 * the top roof speed at `outside.roof.slip.thresholdTilesPerSec2` or more starts a slip: you slide
 * toward the outside of the curve at `slip.slideTilesPerSec` until you push the other way for
 * `slip.leanSec`, and over the edge is a fall. Returns the first player to fall off and why, or null.
 */
export function roofSystem(ctx: RoofCtx): { p: PlayerState; cause: FallCause } | null {
  const { state, config } = ctx;
  const run = state.run;
  if (!run || (run.phase !== 'aboard' && run.phase !== 'extracting')) return null;
  const rc = config.values.outside.roof;
  for (const p of state.players) {
    const rp = run.players[p.id];
    const f = parseCarFrame(p.placement.frame);
    if (!rp || !f || f.trainId !== run.trainId) continue;
    const train = state.world.trains.find((t) => t.id === f.trainId)!;
    const g = trainGrid(config, train.cars);
    if (rp.thudTicks > 0) rp.thudTicks -= 1;
    if (rp.slipCooldownTicks > 0) rp.slipCooldownTicks -= 1;
    if (rp.climb) {
      if (--rp.climb.ticks > 0) continue;
      const { car, end, to } = rp.climb;
      rp.climb = null;
      const l = trainLadders(config, train.cars).find((q) => q.car === car && q.end === end);
      if (!l) continue;
      if (to === 'roof') p.placement = { frame: carFrame(train.id, car), x: l.roofX, y: l.y, layer: 'roof' };
      else { const at = fromTrain(g, l.deckLx); p.placement = { frame: carFrame(train.id, at.car), x: at.x, y: l.y, layer: 'interior' }; }
      ctx.emit({ type: 'Climbed', tick: state.tick, player: p.id, car, end, to });
      continue;
    }
    if (rp.air) {
      p.placement.x += rp.air.vx; p.placement.y += rp.air.vy;
      if (--rp.air.ticks > 0) continue;
      rp.air = null;
      const cause = comeDown(ctx, p, rp, g, train.id, toTrain(g, f.car, p.placement.x), p.placement.y, true);
      if (cause) return { p, cause };
      continue;
    }
    if (p.placement.layer !== 'roof') continue;
    const pl = p.placement, rows = g.carRows[f.car]!, cols = g.carCols[f.car]!;
    const { mx, my, n } = moveAxes(p);
    if (rp.slip) {
      // Push across the car, against the slide, to lean into the curve.
      if (my * -rp.slip.dir > LEAN_AXIS) {
        if (++rp.slip.leanTicks >= rc.slip.leanTicks) {
          rp.slip = null;
          rp.slipCooldownTicks = rc.slip.cooldownTicks;
          ctx.emit({ type: 'RoofRecovered', tick: state.tick, player: p.id, car: f.car });
        }
        continue;
      }
      rp.slip.leanTicks = 0;
      pl.y += rp.slip.dir * rc.slip.slideTilesPerTick;
      if (pl.y < 0 || pl.y >= rows) return { p, cause: 'slip' };
      continue;
    }
    if (n === 0) continue;
    let speed = roofSpeed(config, rp);
    const m = Math.sqrt(mx * mx + my * my);
    let ux = mx, uy = my;
    if (rp.crouched) { ux /= m; uy /= m; speed *= config.values.player.crouch.speedScale; }
    const sx = ux * speed, sy = uy * speed;
    // The long edges stop you; the ends drop you onto the platform below.
    pl.y = Math.max(WALKER_RADIUS, Math.min(rows - WALKER_RADIUS, pl.y + sy));
    pl.x += sx;
    if (pl.x < 0 || pl.x >= cols) {
      const cause = comeDown(ctx, p, rp, g, train.id, toTrain(g, f.car, pl.x), pl.y, false);
      if (cause) return { p, cause };
      continue;
    }
    // Slipping on a curve: the sharper and the faster you go, the likelier (a skill check, never random).
    if (rc.slip.enabled && rp.slipCooldownTicks === 0 && rc.speedTilesPerTick > 0) {
      const pull = curvePull(state, ctx.map, config, train.id, f.car);
      const share = Math.sqrt(sx * sx + sy * sy) / rc.speedTilesPerTick;
      if (Math.abs(pull) * share >= rc.slip.thresholdTilesPerSec2) {
        const dir: 1 | -1 = pull > 0 ? 1 : -1;
        rp.slip = { dir, leanTicks: 0 };
        ctx.emit({ type: 'RoofSlipped', tick: state.tick, player: p.id, car: f.car, dir, push: Math.abs(pull) * share });
      }
    }
  }
  return null;
}

/** Whether car-frame (x, y) of a train's car is a place one can be on its roof. */
export function roofWalkable(config: SimConfig, cars: readonly string[], car: number, x: number, y: number): boolean {
  return onRoof(trainGrid(config, cars), car, x, y);
}

export type { CarEnd };
