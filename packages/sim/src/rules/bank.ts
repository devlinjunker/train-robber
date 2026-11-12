// Banking at a place (stakes PR): loot got off a train rides in the saddlebag until you reach your
// camp (the map's player spawn) or a town, so the getaway has a length and something at stake.
// Dying loses the saddlebag, each riding crash spills a share of it, and at a bank place P pays the
// wanted level down from the bank.
import type { GameState, PlayerState, SimConfig, SimEvent } from '../types';
import type { WorldMap } from '../world/map';
import { isPractice } from './outcome';

interface BankCtx {
  state: GameState;
  map: WorldMap;
  config: SimConfig;
  emit(ev: SimEvent): void;
}

/** A place that banks the saddlebag: `camp` (the player spawn) or a town, banking within `radiusTiles` of (x, y). */
export interface BankPlace { id: string; kind: 'camp' | 'town'; x: number; y: number; radiusTiles: number }

/** Every bank place on the map: the camp at the player spawn, then each town that has a position. */
export function bankPlaces(map: WorldMap, config: SimConfig): BankPlace[] {
  const b = config.values.bank;
  const out: BankPlace[] = [{ id: 'camp', kind: 'camp', x: map.playerSpawn.x, y: map.playerSpawn.y, radiusTiles: b.campRadiusTiles }];
  for (const t of map.towns) {
    if (t.x === undefined || t.y === undefined) continue;
    out.push({ id: t.id, kind: 'town', x: t.x, y: t.y, radiusTiles: (t.radiusTiles ?? 0) + b.townReachTiles });
  }
  return out;
}

/** The bank place (x, y) is inside, or null. */
export function bankPlaceAt(map: WorldMap, config: SimConfig, x: number, y: number): BankPlace | null {
  for (const p of bankPlaces(map, config)) if ((x - p.x) ** 2 + (y - p.y) ** 2 <= p.radiusTiles ** 2) return p;
  return null;
}

/** The nearest bank place to (x, y) and how far it is (to its edge, 0 inside). */
export function nearestBankPlace(map: WorldMap, config: SimConfig, x: number, y: number): { place: BankPlace; distanceTiles: number } {
  let best: { place: BankPlace; distanceTiles: number } | null = null;
  for (const p of bankPlaces(map, config)) {
    const d = Math.max(0, Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2) - p.radiusTiles);
    if (!best || d < best.distanceTiles) best = { place: p, distanceTiles: d };
  }
  return best!;
}

export const emptySaddlebag = () => ({ value: 0, items: 0, runs: 0 });

/** Put a run's loot (value with the wanted bonus, and its item count) in the saddlebag. */
export function stash(p: PlayerState, value: number, items: number): void {
  if (value <= 0 && items <= 0) return;
  p.saddlebag = { value: p.saddlebag.value + value, items: p.saddlebag.items + items, runs: p.saddlebag.runs + 1 };
}

const mounted = (state: GameState, p: PlayerState) => p.placement.frame === 'world' && state.world.horses.some((h) => h.id === p.horseId && h.mode === 'physical');

/**
 * After riding: a rider with a full saddlebag inside a bank place banks it. The bank and lifetime
 * earned rise by its value and PersistentChanged (`banked`) follows, so the host saves. Practice runs
 * (`wanted.forceLevel`) bank nothing, as at a run's end. Returns the riders who banked at the camp
 * with no run on, who make camp there (`bank.campEndsDay`).
 */
export function bankSystem(ctx: BankCtx): PlayerState[] {
  const { state, map, config } = ctx;
  const camped: PlayerState[] = [];
  if (!config.values.bank.atPlace) return camped;
  for (const p of state.players) {
    const bag = p.saddlebag;
    if ((bag.value <= 0 && bag.items <= 0) || !mounted(state, p)) continue;
    const place = bankPlaceAt(map, config, p.placement.x, p.placement.y);
    if (!place) continue;
    const practice = isPractice(config);
    const before = state.persistent;
    const after = practice ? before : { ...before, bank: before.bank + bag.value, lifetimeEarned: before.lifetimeEarned + bag.value };
    p.saddlebag = emptySaddlebag();
    ctx.emit({ type: 'LootBanked', tick: state.tick, player: p.id, value: bag.value, items: bag.items, runs: bag.runs, place: place.id, ...(practice ? { practice: true as const } : {}) });
    state.persistent = after;
    ctx.emit({ type: 'PersistentChanged', tick: state.tick, outcome: 'banked', before, after: { ...after }, ...(practice ? { practice: true as const } : {}) });
    // Banking at the camp with no run on is making camp: the caller ends the day (`bank.campEndsDay`).
    if (place.kind === 'camp' && config.values.bank.campEndsDay && !state.run) camped.push(p);
  }
  return camped;
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

/** The cost of dropping one star from `level`: `wanted.payDown.costPerLevel` x level. */
export function payDownCost(config: SimConfig, level: number): number {
  return config.values.wanted.payDown.costPerLevel * level;
}

/**
 * P on the horse at a bank place: pay `payDownCost` from the bank to drop the wanted level by one.
 * Lifetime earned is untouched (it is the score). Refused in practice, when not wanted, or when the
 * bank cannot cover it.
 */
export function payWanted(ctx: BankCtx, p: PlayerState): void {
  const { state, map, config } = ctx;
  const no = (reason: 'disabled' | 'not mounted' | 'not at a bank' | 'not wanted' | 'cannot afford' | 'practice') =>
    ctx.emit({ type: 'CommandRejected', tick: state.tick, player: p.id, command: 'payWanted', reason });
  if (!config.values.wanted.payDown.enabled) return no('disabled');
  if (isPractice(config)) return no('practice');
  if (!mounted(state, p)) return no('not mounted');
  const place = bankPlaceAt(map, config, p.placement.x, p.placement.y);
  if (!place) return no('not at a bank');
  const level = state.persistent.wantedLevel;
  if (level <= 0) return no('not wanted');
  const cost = payDownCost(config, level);
  if (state.persistent.bank < cost) return no('cannot afford');
  const before = state.persistent;
  const after = { ...before, bank: before.bank - cost, wantedLevel: level - 1 };
  state.persistent = after;
  ctx.emit({ type: 'WantedPaidDown', tick: state.tick, player: p.id, cost, level: level - 1, place: place.id });
  ctx.emit({ type: 'PersistentChanged', tick: state.tick, outcome: 'paidWanted', before, after: { ...after } });
}
