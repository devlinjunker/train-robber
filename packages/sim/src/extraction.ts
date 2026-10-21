// Extraction (U4, G3, G11, G12, G14, G15, G18, G24): the whistle, the riderless horse's steering AI
// and its states (away, approaching, alongside, leaving), and the mount jump that ends the run as
// `extracted`. Tick system 6, after walking aboard; the AI's intent is read by riding (system 3).
import { nextInt, nextU32 } from './rng';
import type { HorseState, PlayerId, PlayerState, TrainSide } from './types';
import { advanceMeterBy, meterResult, rollMeterZones, sideOf } from './world/boarding';
import { distanceToBox } from './world/collide';
import { carriedValue } from './world/loot';
import { terrainAt, type WorldMap } from './world/map';
import { laneTarget, mountCheck, playerSide } from './world/mount';
import { avoids, cellCentre, cellOf, findPath, lineClear, pathGrid } from './world/path';
import type { HorseIntent } from './world/riding';
import { carPosesOf, onMapRange, routeOf, trainLengthOf, trainSpeed } from './world/trains';
import { carSpacing } from './world/cars';
import { trackAt } from './world/track';
import { endRun, horseOf, reject, setPhase, type RunCtx } from './run';
import { WORLD_FRAME, parseCarFrame } from './world/frames';

/** How far behind the last car the horse goes round it when switching sides, tiles. */
const CROSS_BEHIND = 6;
/** The horse aims this far ahead of its lane point, so it steers along the car rather than at it. */
const LEAD_TILES = 4;
/** Along-track gap (tiles) per tile/s of extra speed while closing on the lane point. */
const CLOSE_GAIN = 0.8;
/** How often the path is planned again, ticks. */
const REPLAN_TICKS = 30;
/** Getting this much closer counts as progress, for the stuck check. */
const PROGRESS_TILES = 0.5;

const next01 = (ctx: RunCtx, stream: 'horse' | 'misc') => nextU32(ctx.state.rng, stream) / 4294967296;

/** The nearest tile centre the horse can stand on (not blocked or water), searching outward; the point itself when it is fine. */
export function nearestOpenTile(map: WorldMap, x: number, y: number, maxRadius = 30): { x: number; y: number } {
  if (!avoids(terrainAt(map, x, y))) return { x, y };
  const c0 = Math.floor(x), r0 = Math.floor(y);
  for (let rad = 1; rad <= maxRadius; rad++) {
    let best: { x: number; y: number } | null = null, bestD = Infinity;
    for (let r = r0 - rad; r <= r0 + rad; r++) {
      for (let c = c0 - rad; c <= c0 + rad; c++) {
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== rad) continue;
        if (avoids(terrainAt(map, c + 0.5, r + 0.5))) continue;
        const d = (c + 0.5 - x) ** 2 + (r + 0.5 - y) ** 2;
        if (d < bestD) { bestD = d; best = { x: c + 0.5, y: r + 0.5 }; }
      }
    }
    if (best) return best;
  }
  return { x, y };
}

/** The horse never starts closer than this behind the last car, tiles. */
const MIN_BEHIND_TILES = 4;

/**
 * Where a whistle puts the horse: `delaySec` x (horse.maxSpeed - train speed) back along the track
 * from the player's place in the train, so the ride up takes about the drawn delay, but always
 * behind the last car. Out in the lane on `side`, moved to the nearest open tile if needed.
 */
export function horseStart(ctx: RunCtx, p: PlayerState, trainId: string, side: TrainSide, delaySec: number): { x: number; y: number; hx: number; hy: number; distance: number } {
  const { state, map, config } = ctx;
  const train = state.world.trains.find((t) => t.id === trainId)!;
  const { route } = routeOf(map, config, train);
  const closing = Math.max(1, config.values.horse.maxSpeed - trainSpeed(config, train.type));
  const cars = carPosesOf(state, map, config, trainId);
  const f = parseCarFrame(p.placement.frame);
  let ahead = 0;
  for (const car of cars) { if (f && car.index < f.car) ahead += car.halfLength * 2 + carSpacing(config); }
  const playerD = train.d - ahead - (f ? p.placement.x : 0);
  const rearD = train.d - trainLengthOf(config, train);
  // On an open line the horse never starts off the map, even when the train has only just come on.
  const startD = Math.max(onMapRange(map, route).from, Math.min(playerD - delaySec * closing, rearD - MIN_BEHIND_TILES));
  const at = trackAt(route, startD);
  const last = cars[cars.length - 1]!;
  const off = (last.halfWidth + config.values.extraction.laneOffsetTiles) * (side === 'left' ? 1 : -1);
  const spot = nearestOpenTile(map, at.x + at.ty * off, at.y - at.tx * off);
  // How far behind the last car it starts.
  return { ...spot, hx: at.tx, hy: at.ty, distance: rearD - startD };
}

/**
 * F: whistle. Aboard with the horse away (or still running off), draw the delay from the `horse`
 * stream, place the horse and enter `extracting`. While it is coming or alongside, a whistle from
 * the other side of the car sends it there. After the pace window, wait out the cooldown.
 */
export function whistle(ctx: RunCtx, p: PlayerState): void {
  const { state, config } = ctx;
  const run = state.run;
  const side = playerSide(state, config, p);
  if (!run || !run.players[p.id] || (run.phase !== 'aboard' && run.phase !== 'extracting') || !side) return reject(ctx, p.id, 'whistle', 'not aboard');
  const call = run.horse;
  if (call.state === 'approaching' || call.state === 'alongside') {
    if (side === call.side) return reject(ctx, p.id, 'whistle', 'horse coming');
    ctx.emit({ type: 'HorseSideChanged', tick: state.tick, player: p.id, from: call.side, to: side });
    Object.assign(call, { side, state: 'approaching', ticks: 0, blocked: null, bestDistance: 1e9, stuckTicks: 0, path: [], replanTicks: 0 });
    call.whistles += 1;
    setPhase(ctx, p.id, 'extracting');
    return;
  }
  if (call.cooldownTicks > 0) return reject(ctx, p.id, 'whistle', 'cooling down');
  const [lo, hi] = config.values.extraction.arrivalDelaySec;
  const delaySec = lo + next01(ctx, 'horse') * (hi - lo);
  const start = horseStart(ctx, p, run.trainId, side, delaySec);
  const h = horseOf(state, p);
  const trainV = trainSpeed(config, state.world.trains.find((t) => t.id === run.trainId)!.type);
  Object.assign(h, { x: start.x, y: start.y, hx: start.hx, hy: start.hy, speed: trainV, cruiseTarget: trainV, stunTicks: 0, mode: 'physical' as const });
  call.whistles += 1;
  Object.assign(call, { state: 'approaching', side, ticks: 0, whistleTick: state.tick, delaySec, blocked: null, bestDistance: 1e9, stuckTicks: 0, path: [], replanTicks: 0 });
  ctx.emit({ type: 'HorseWhistled', tick: state.tick, player: p.id, side, delaySec: Math.round(delaySec * 1000) / 1000, distanceTiles: Math.round(start.distance * 10) / 10, whistle: call.whistles });
  setPhase(ctx, p.id, 'extracting');
}

/** The car of a train nearest the horse. */
function nearestCar(cars: ReturnType<typeof carPosesOf>, h: HorseState): ReturnType<typeof carPosesOf>[number] {
  let near = cars[0]!, best = Infinity;
  for (const car of cars) { const d = distanceToBox(h.x, h.y, car); if (d < best) { best = d; near = car; } }
  return near;
}

/** The side of the train the horse is on now, from the nearest car. */
function horseSide(cars: ReturnType<typeof carPosesOf>, h: HorseState): TrainSide {
  let side: TrainSide = 'left', best = Infinity;
  for (const car of cars) {
    const d = distanceToBox(h.x, h.y, car);
    if (d < best) { best = d; side = sideOf(car, h.x, h.y); }
  }
  return side;
}

/** The steering AI for the riderless horse, for the riding system (U4). Null when it has nothing to do. */
export function horseIntent(ctx: RunCtx): (p: PlayerState, h: HorseState) => HorseIntent | null {
  return (p, h) => {
    const { state, map, config } = ctx;
    const run = state.run;
    if (!run || !run.players[p.id]) return null;
    const call = run.horse;
    const train = state.world.trains.find((t) => t.id === run.trainId);
    if (!train) return null;
    const cars = carPosesOf(state, map, config, train.id);
    const trainV = trainSpeed(config, train.type);
    const max = config.values.horse.maxSpeed;
    if (call.state === 'leaving' || call.state === 'away') {
      // Run off away from the track: out from the nearest car, and back from it. After the pace
      // window it drops back slowly; after boarding it gallops off.
      const near = nearestCar(cars, h);
      const s = sideOf(near, h.x, h.y) === 'left' ? 1 : -1;
      const nx = near.uy * s, ny = -near.ux * s;
      return { tx: h.x + nx * 10 - near.ux * 4, ty: h.y + ny * 10 - near.uy * 4, speed: call.cooldownTicks > 0 ? trainV * 0.6 : max };
    }
    const lane = laneTarget(state, map, config, p, call.side);
    if (!lane) return null;
    // Far from the player's car (off screen at the run zoom) it rides straight through rocks and
    // water, so it can only get stuck where the player can see it (Devlin, M4 playtest).
    const far = config.values.extraction.passThroughBeyondTiles;
    const through = far > 0 && Math.sqrt((lane.x - h.x) ** 2 + (lane.y - h.y) ** 2) > far;
    const steer = steerFor(ctx, h, call, cars, lane, trainV, max, through);
    return steer && through ? { ...steer, passThrough: true } : steer;
  };
}

/** Where the approaching horse steers: round the back of the train, along a path, or up the lane. */
function steerFor(
  ctx: RunCtx, h: HorseState, call: NonNullable<RunCtx['state']['run']>['horse'],
  cars: ReturnType<typeof carPosesOf>, lane: NonNullable<ReturnType<typeof laneTarget>>, trainV: number, max: number, through: boolean,
): HorseIntent | null {
  const { map, config } = ctx;
  // On the wrong side: drop back past the last car on this side, then cross behind it.
  if (horseSide(cars, h) !== call.side) {
    const last = cars[cars.length - 1]!;
    const lx = (h.x - last.x) * last.ux + (h.y - last.y) * last.uy;
    const bx = last.x - last.ux * (last.halfLength + CROSS_BEHIND), by = last.y - last.uy * (last.halfLength + CROSS_BEHIND);
    const out = last.halfWidth + config.values.extraction.laneOffsetTiles;
    const behind = lx < -(last.halfLength + 2);
    const s = (behind ? call.side === 'left' : call.side !== 'left') ? 1 : -1;
    return { tx: bx + last.uy * out * s, ty: by - last.ux * out * s, speed: behind ? trainV : Math.max(0, trainV - 4) };
  }
  // Round terrain: steer for the next cell of the planned path (not while passing through).
  const g = pathGrid(map, config.values.extraction.pathCellTiles);
  while (!through && call.path.length > 1) {
    const c = cellCentre(g, call.path[0]!);
    if (Math.sqrt((c.x - h.x) ** 2 + (c.y - h.y) ** 2) > g.cell) break;
    call.path.shift();
  }
  if (!through && call.path.length > 1) {
    const c = cellCentre(g, call.path[0]!);
    return { tx: c.x, ty: c.y, speed: max };
  }
  // Still behind the player's car: ride up the lane car by car, so it follows the train round
  // bends instead of cutting across them.
  const near = nearestCar(cars, h);
  if (near.index > lane.car.index) {
    const out = (config.values.extraction.laneOffsetTiles) * (call.side === 'left' ? 1 : -1);
    let car = near, a = (h.x - near.x) * near.ux + (h.y - near.y) * near.uy + LEAD_TILES;
    if (a > car.halfLength && car.index > 0) { const ahead = cars[car.index - 1]!; a = -ahead.halfLength + Math.max(0, a - car.halfLength - carSpacing(config)); car = ahead; }
    a = Math.max(-car.halfLength, Math.min(car.halfLength, a));
    const o = out + car.halfWidth * (call.side === 'left' ? 1 : -1);
    return { tx: car.x + car.ux * a + car.uy * o, ty: car.y + car.uy * a - car.ux * o, speed: max };
  }
  // Close the gap along the car, then hold the train's speed beside the player.
  // The gap is the straight distance, signed by whether the lane point is ahead, so a bend's
  // sideways gap closes as fast as one along the car.
  const along = (lane.x - h.x) * lane.ux + (lane.y - h.y) * lane.uy;
  const gap = Math.sqrt((lane.x - h.x) ** 2 + (lane.y - h.y) ** 2) * (along >= 0 ? 1 : -1);
  return { tx: lane.x + lane.ux * LEAD_TILES, ty: lane.y + lane.uy * LEAD_TILES, speed: Math.max(0, Math.min(max, trainV + gap / CLOSE_GAIN)) };
}

/** A good mount's spill (G15). Returns the items lost and the value lost with them; `carried` is changed in place. */
export function spillLoot(ctx: RunCtx, carried: string[]): { items: string[]; value: number } {
  const ex = ctx.config.values.extraction;
  const items = ctx.config.values.items;
  if (carried.length === 0) return { items: [], value: 0 };
  if (ex.mountSpill === 'share') return { items: [], value: Math.round(carriedValue(ctx.config, carried) * ex.spillShare) };
  let i: number;
  if (ex.mountSpill === 'heaviest') {
    i = 0;
    for (let k = 1; k < carried.length; k++) if ((items[carried[k]!]?.weight ?? 0) > (items[carried[i]!]?.weight ?? 0)) i = k;
  } else i = nextInt(ctx.state.rng, 'misc', carried.length);
  const [lost] = carried.splice(i, 1) as [string];
  return { items: [lost], value: items[lost]?.value ?? 0 };
}

/** Space beside the alongside horse: sample the mount meter. */
function resolveMount(ctx: RunCtx, p: PlayerState, h: HorseState): void {
  const { state, config } = ctx;
  const run = state.run!;
  const rp = run.players[p.id]!;
  const ex = config.values.extraction;
  run.horse.mountAttempts += 1;
  const { result, position } = meterResult(rp.meter, ex.meter.zoneWidths);
  ctx.emit({ type: 'MountAttempt', tick: state.tick, player: p.id, result, attempt: run.horse.mountAttempts, meter: position });
  rollMeterZones(state, rp.meter, ex.meter.zoneWidths);
  rp.meter.phase = 0;
  if (result === 'fail') {
    // You stay aboard, stumble and take the usual failure damage; try again while it paces (G14).
    rp.stumbleTicks = config.values.boarding.landing.stumbleTicks;
    const amount = config.values.health.max * config.values.boarding.failure.damageFraction;
    if (amount > 0) {
      rp.health = Math.max(0, rp.health - amount);
      ctx.emit({ type: 'DamageDealt', tick: state.tick, target: p.id, amount, health: rp.health, cause: 'mount' });
    }
    return;
  }
  let lostValue = 0;
  if (result === 'good') {
    const spill = spillLoot(ctx, rp.carried);
    lostValue = spill.value;
    if (spill.value > 0 || spill.items.length) ctx.emit({ type: 'LootSpilled', tick: state.tick, player: p.id, items: spill.items, value: spill.value, rule: ex.mountSpill });
  }
  // Cash out the moment the mount lands (Decided values): the carried value after the spill.
  const cashOut = Math.max(0, carriedValue(config, rp.carried) - (ex.mountSpill === 'share' ? lostValue : 0));
  const trainId = run.trainId;
  // Mounted where the horse is, riding on at its speed.
  h.cruiseTarget = h.speed;
  // A good mount lands badly: the horse is stunned a moment, as after a failed boarding jump (Devlin, M4 playtest).
  h.stunTicks = result === 'good' ? ex.goodMountStunTicks : 0;
  p.placement = { frame: WORLD_FRAME, x: h.x, y: h.y, layer: 'ground' };
  endRun(ctx, p, 'extracted', false, cashOut);
  // Only E commits to the train just robbed until the rider leaves its commit range.
  p.commitHold = trainId;
}

/**
 * Tick system 6, extraction: whistles, the horse's states and timers, path planning and the
 * blocked notice, then the mount meter and mount jumps for `jumps` sent aboard.
 */
export function extractionSystem(ctx: RunCtx, whistles: ReadonlySet<PlayerId>, jumps: ReadonlySet<PlayerId>): void {
  const { state, map, config } = ctx;
  const ex = config.values.extraction;
  for (const p of state.players) {
    const run = state.run;
    const rp = run?.players[p.id];
    if (!run || !rp) { if (whistles.has(p.id)) reject(ctx, p.id, 'whistle', 'not aboard'); continue; }
    const call = run.horse;
    if (call.cooldownTicks > 0) call.cooldownTicks -= 1;
    if (whistles.has(p.id)) whistle(ctx, p);
    const h = horseOf(state, p);
    if (call.state === 'leaving') {
      call.ticks -= 1;
      if (call.ticks <= 0) { call.state = 'away'; h.mode = 'away'; h.speed = 0; h.cruiseTarget = 0; }
    } else if (call.state === 'approaching') {
      const lane = laneTarget(state, map, config, p, call.side);
      if (lane) {
        const d = Math.sqrt((lane.x - h.x) ** 2 + (lane.y - h.y) ** 2);
        // Off screen it passes through terrain (horseIntent), so it is never stuck or blocked there.
        const through = ex.passThroughBeyondTiles > 0 && d > ex.passThroughBeyondTiles;
        if (through) {
          call.stuckTicks = 0; call.path = []; call.replanTicks = 0;
          call.bestDistance = d;
          call.blocked = null;
        // Stuck: no progress toward the lane for `extraction.stuckSec`. It keeps trying either way.
        } else if (d < call.bestDistance - PROGRESS_TILES) {
          call.bestDistance = d; call.stuckTicks = 0;
          if (call.blocked === 'stuck') call.blocked = null;
        } else if (++call.stuckTicks >= ex.stuckTicks && call.blocked === null) {
          call.blocked = 'stuck';
          ctx.emit({ type: 'HorseBlocked', tick: state.tick, player: p.id, reason: 'stuck' });
        }
        if (!through && --call.replanTicks <= 0) {
          call.replanTicks = REPLAN_TICKS;
          if (lineClear(map, h.x, h.y, lane.x, lane.y)) {
            call.path = [];
            if (call.blocked === 'no path') call.blocked = null;
          } else {
            const g = pathGrid(map, ex.pathCellTiles);
            const path = findPath(g, cellOf(g, h.x, h.y), cellOf(g, lane.x, lane.y));
            call.path = path ?? [];
            if (!path && call.blocked === null) {
              call.blocked = 'no path';
              ctx.emit({ type: 'HorseBlocked', tick: state.tick, player: p.id, reason: 'no path' });
            } else if (path && call.blocked === 'no path') call.blocked = null;
          }
        }
        const cars = carPosesOf(state, map, config, run.trainId);
        if (d <= ex.alongsideRangeTiles && horseSide(cars, h) === call.side) {
          Object.assign(call, { state: 'alongside', ticks: ex.paceWindowTicks, blocked: null, path: [] });
          ctx.emit({ type: 'HorseArrived', tick: state.tick, player: p.id, side: call.side, paceWindowSec: ex.paceWindowTicks / config.values.sim.tickRateHz });
        }
      }
    } else if (call.state === 'alongside') {
      call.ticks -= 1;
      if (call.ticks <= 0) {
        // The pace window is over: it drops back and leaves; whistle again after the cooldown.
        Object.assign(call, { state: 'leaving', ticks: ex.dropBackTicks, cooldownTicks: ex.rewhistleCooldownTicks });
        ctx.emit({ type: 'HorseDeparted', tick: state.tick, player: p.id, cooldownSec: ex.rewhistleCooldownTicks / config.values.sim.tickRateHz });
        setPhase(ctx, p.id, 'aboard');
      }
    }
    // The mount meter sweeps while a mount is possible; Space samples it.
    if (run.phase !== 'aboard' && run.phase !== 'extracting') continue;
    const check = mountCheck(state, map, config, p);
    if (jumps.has(p.id)) {
      if (check.state === 'eligible') { resolveMount(ctx, p, h); continue; }
      reject(ctx, p.id, 'jump', check.state);
    }
    advanceMeterBy(rp.meter, check.state === 'eligible', ex.meter.sweepPeriodTicks);
  }
}
