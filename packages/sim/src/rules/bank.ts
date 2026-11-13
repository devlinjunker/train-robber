// Making camp (stakes PR): loot got off a train rides in the saddlebag all day, and banks only when
// you make camp. You make camp where you are, holding C on a stopped horse with no run on, once you
// are far enough off the line (farther the more you are wanted, closer in cover), on firm ground (no
// water or mud close by) and the train you robbed cannot see you. Making camp banks the saddlebag and ends the day. Until then dying loses
// the saddlebag and each hard riding crash spills a share of it.
import type { GameState, PlayerState, SimConfig, SimEvent } from '../types';
import { Terrain, terrainAt, type WorldMap } from '../world/map';
import { carPosesOf } from '../world/trains';
import { isPractice, runWantedLevel } from './outcome';

interface BankCtx {
  state: GameState;
  map: WorldMap;
  config: SimConfig;
  emit(ev: SimEvent): void;
}

/** Why a rider cannot make camp here and now. */
export type CampRefusal = 'run active' | 'not mounted' | 'moving' | 'already camped' | 'bad ground' | 'too close to the line' | 'train sees you';

export const emptySaddlebag = () => ({ value: 0, items: 0, runs: 0 });

/** Put a run's loot (value with the wanted bonus, and its item count) in the saddlebag. */
export function stash(p: PlayerState, value: number, items: number): void {
  if (value <= 0 && items <= 0) return;
  p.saddlebag = { value: p.saddlebag.value + value, items: p.saddlebag.items + items, runs: p.saddlebag.runs + 1 };
}

const horseOf = (state: GameState, p: PlayerState) => state.world.horses.find((h) => h.id === p.horseId);
const mounted = (state: GameState, p: PlayerState) => p.placement.frame === 'world' && horseOf(state, p)?.mode === 'physical';

/**
 * Where the rider is: the horse while mounted. The player's placement is not moved while riding (it
 * stays where they mounted), so camping reads the horse.
 */
export function riderPos(state: GameState, p: PlayerState): { x: number; y: number } {
  const h = horseOf(state, p);
  return h && p.placement.frame === 'world' && h.mode === 'physical' ? { x: h.x, y: h.y } : { x: p.placement.x, y: p.placement.y };
}

/** Firm ground to camp on: no water, deep water or mud within `bank.campGroundRadiusTiles`. */
export function campGround(map: WorldMap, config: SimConfig, x: number, y: number): boolean {
  const r = config.values.bank.campGroundRadiusTiles;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const t = terrainAt(map, x + dx, y + dy);
      if (t === Terrain.Water || t === Terrain.Deep || t === Terrain.Slow) return false;
    }
  }
  return true;
}

/** Distance from (x, y) to the nearest track of any route, in tiles (from the route samples). */
export function distanceToLine(map: WorldMap, x: number, y: number): number {
  let best = Infinity;
  for (const r of map.routes.values()) {
    const { x: xs, y: ys } = r.samples;
    for (let i = 0; i < xs.length; i++) {
      const d = (xs[i]! - x) ** 2 + (ys[i]! - y) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** In cover: at least `bank.coverMinTiles` blocked tiles (timber, rocks, canyon walls, mesas) within `bank.coverRadiusTiles`. */
export function inCover(map: WorldMap, config: SimConfig, x: number, y: number): boolean {
  const { coverRadiusTiles: r, coverMinTiles: need } = config.values.bank;
  let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      if (terrainAt(map, x + dx, y + dy) === Terrain.Blocked && ++n >= need) return true;
    }
  }
  return false;
}

/**
 * How far off the line a rider must be to make camp: `bank.campDistanceTiles` plus
 * `campDistancePerWantedTiles` per wanted level, times `coverDistanceScale` in cover. One function, so
 * a dollar bounty can replace the wanted level here later.
 */
export function campDistance(config: SimConfig, wantedLevel: number, cover: boolean): number {
  const b = config.values.bank;
  return (b.campDistanceTiles + b.campDistancePerWantedTiles * Math.max(0, wantedLevel)) * (cover ? b.coverDistanceScale : 1);
}

/** What the HUD shows about camping here: the distance off the line, the distance needed, cover, and whether the robbed train sees you. */
export function campView(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState): { distance: number; need: number; cover: boolean; seen: boolean; ground: boolean } {
  const { x, y } = riderPos(state, p);
  const cover = inCover(map, config, x, y);
  return { distance: distanceToLine(map, x, y), need: campDistance(config, runWantedLevel(state, config), cover), cover, seen: trainSees(state, map, config, x, y, p, cover), ground: campGround(map, config, x, y) };
}

/** The train you last robbed sees you: one of its cars within `bank.trainSightTiles`, unless you are in cover. */
function trainSees(state: GameState, map: WorldMap, config: SimConfig, x: number, y: number, p: PlayerState, cover: boolean): boolean {
  if (cover || !p.robbedTrain || !state.world.trains.some((t) => t.id === p.robbedTrain)) return false;
  const r2 = config.values.bank.trainSightTiles ** 2;
  return carPosesOf(state, map, config, p.robbedTrain).some((c) => (c.x - x) ** 2 + (c.y - y) ** 2 <= r2);
}

/** Whether `p` can make camp here and now: null, or why not. */
export function campCheck(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState): CampRefusal | null {
  if (state.run) return 'run active';
  if (!mounted(state, p)) return 'not mounted';
  if (p.campedAt) return 'already camped';
  // The place first, then the stop: a moving rider is told whether this spot would do.
  const v = campView(state, map, config, p);
  if (v.distance < v.need) return 'too close to the line';
  if (!v.ground) return 'bad ground';
  if (v.seen) return 'train sees you';
  if ((horseOf(state, p)?.speed ?? 0) > config.values.bank.campStopSpeedTilesPerSec) return 'moving';
  return null;
}

/**
 * After the run end: riders holding C build up `bank.campHoldTicks`, which makes camp (the caller
 * runs `makeCamp`). A hold that stops being allowed (moving off, a train in sight) starts again.
 * Leaving camp by `bank.campLeaveTiles`, or committing to a train, clears `campedAt`. Returns the
 * riders who made camp this tick.
 */
export function campSystem(ctx: BankCtx): PlayerState[] {
  const { state, map, config } = ctx;
  const b = config.values.bank;
  const done: PlayerState[] = [];
  for (const p of state.players) {
    const at = riderPos(state, p);
    if (p.campedAt && (state.run || (at.x - p.campedAt.x) ** 2 + (at.y - p.campedAt.y) ** 2 > b.campLeaveTiles ** 2)) p.campedAt = null;
    if (!p.campHeld || !b.atCamp) { p.campHoldTicks = 0; continue; }
    if (campCheck(state, map, config, p)) { p.campHoldTicks = 0; continue; }
    p.campHoldTicks += 1;
    if (p.campHoldTicks >= Math.max(1, b.campHoldTicks)) { p.campHoldTicks = 0; p.campHeld = false; done.push(p); }
  }
  return done;
}

/** C pressed or released on the horse. A press that cannot camp here says why. */
export function campCommand(ctx: BankCtx, p: PlayerState, held: boolean): void {
  p.campHeld = held;
  if (!held) return;
  if (!ctx.config.values.bank.atCamp) { ctx.emit({ type: 'CommandRejected', tick: ctx.state.tick, player: p.id, command: 'camp', reason: 'disabled' }); p.campHeld = false; return; }
  const why = campCheck(ctx.state, ctx.map, ctx.config, p);
  if (why) ctx.emit({ type: 'CommandRejected', tick: ctx.state.tick, player: p.id, command: 'camp', reason: why });
}

/**
 * Bank the saddlebag (making camp): the bank and lifetime earned rise by its value and
 * PersistentChanged (`banked`) follows, so the host saves. Practice runs (`wanted.forceLevel`) save
 * nothing. An empty saddlebag banks nothing and emits nothing.
 */
export function bankSaddlebag(ctx: BankCtx, p: PlayerState): void {
  const { state, config } = ctx;
  const bag = p.saddlebag;
  if (bag.value <= 0 && bag.items <= 0) return;
  const practice = isPractice(config);
  const before = state.persistent;
  const after = practice ? before : { ...before, bank: before.bank + bag.value, lifetimeEarned: before.lifetimeEarned + bag.value };
  p.saddlebag = emptySaddlebag();
  ctx.emit({ type: 'LootBanked', tick: state.tick, player: p.id, value: bag.value, items: bag.items, runs: bag.runs, place: 'camp', ...(practice ? { practice: true as const } : {}) });
  state.persistent = after;
  ctx.emit({ type: 'PersistentChanged', tick: state.tick, outcome: 'banked', before, after: { ...after }, ...(practice ? { practice: true as const } : {}) });
}

/** A riding crash spills `bank.crashSpillShare` of the saddlebag: that share of its value (rounded down) and of its items (rounded up). */
export function spillSaddlebag(ctx: BankCtx, p: PlayerState): void {
  const share = ctx.config.values.bank.crashSpillShare;
  const bag = p.saddlebag;
  if (share <= 0 || bag.value <= 0) return;
  const value = Math.max(1, Math.floor(bag.value * share));
  const items = Math.min(bag.items, Math.ceil(bag.items * share - 1e-9));
  p.saddlebag = { value: bag.value - value, items: bag.items - items, runs: bag.runs };
  ctx.emit({ type: 'SaddlebagLost', tick: ctx.state.tick, player: p.id, value, items, cause: 'crash' });
}

/** Dying loses the whole saddlebag. */
export function loseSaddlebag(ctx: BankCtx, p: PlayerState): void {
  const bag = p.saddlebag;
  p.saddlebag = emptySaddlebag();
  if (bag.value > 0 || bag.items > 0) ctx.emit({ type: 'SaddlebagLost', tick: ctx.state.tick, player: p.id, value: bag.value, items: bag.items, cause: 'died' });
}
