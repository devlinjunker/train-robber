// Loot and carry (tick system 9 for the search verb and drops): searching a loot slot by holding
// E, the two carry flags (a hard limit and a weight slowdown, flag C3), and dropping to swap.
import type { GameState, LootState, PlayerId, PlayerRunState, PlayerState, SimConfig, SimEvent } from '../types';
import { parseCarFrame } from './frames';
import { raiseHeatFor } from '../rules/heat';

/** What the loot system needs from the tick; `RunCtx` satisfies it. */
export interface LootCtx {
  state: GameState;
  config: SimConfig;
  emit(ev: SimEvent): void;
}

export function carriedWeight(config: SimConfig, carried: readonly string[]): number {
  let w = 0;
  for (const id of carried) w += config.values.items[id]?.weight ?? 0;
  return w;
}

export function carriedValue(config: SimConfig, carried: readonly string[]): number {
  let v = 0;
  for (const id of carried) v += config.values.items[id]?.value ?? 0;
  return v;
}

/**
 * Walk speed scale for a carried weight: 1 up to `carry.slowdownFromWeight`, then falling linearly
 * to `carry.minSpeedScale` at `carry.maxWeight`, and held there above it. 1 with the slowdown off.
 */
export function carrySpeedScale(config: SimConfig, weight: number): number {
  const c = config.values.carry;
  if (!c.slowdownEnabled || weight <= c.slowdownFromWeight) return 1;
  const span = c.maxWeight - c.slowdownFromWeight;
  const t = span > 0 ? Math.min(1, (weight - c.slowdownFromWeight) / span) : 1;
  return 1 - (1 - c.minSpeedScale) * t;
}

/** Why picking up `item` would break a carry cap, or null when it fits (or the limit is off). */
export function carryRefusal(config: SimConfig, carried: readonly string[], item: string): 'too heavy' | 'too many items' | null {
  const c = config.values.carry;
  if (!c.limitEnabled) return null;
  if (carried.length + 1 > c.maxItems) return 'too many items';
  if (carriedWeight(config, carried) + (config.values.items[item]?.weight ?? 0) > c.maxWeight + 1e-9) return 'too heavy';
  return null;
}

/** The nearest loot still lying in the player's car within `maxDist` of them, or null. */
export function nearestLoot(state: GameState, p: PlayerState, maxDist: number): LootState | null {
  const f = parseCarFrame(p.placement.frame);
  const run = state.run;
  if (!f || !run) return null;
  let best: LootState | null = null, bestD = maxDist * maxDist;
  for (const l of run.loot) {
    if (l.taken || l.car !== f.car) continue;
    const dx = l.x - p.placement.x, dy = l.y - p.placement.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = l; }
  }
  return best;
}

/** Ticks of holding E to take `item`: its own search time, else the verb's, times `verbs.search.timeScale`; at least 1. */
export function searchTicksFor(config: SimConfig, item: string): number {
  const s = config.values.verbs.search;
  return Math.max(1, Math.round((config.values.items[item]?.searchTimeTicks ?? s.searchTimeTicks) * s.timeScale));
}

function cancelSearch(ctx: LootCtx, p: PlayerState, rp: PlayerRunState, reason: 'released' | 'moved away'): void {
  const s = rp.search;
  if (!s) return;
  rp.search = null;
  ctx.emit({ type: 'SearchCancelled', tick: ctx.state.tick, player: p.id, loot: s.loot, reason, progress: Math.min(1, s.ticks / searchTicksFor(ctx.config, ctx.state.run?.loot.find((l) => l.id === s.loot)?.item ?? '')) });
}

function drop(ctx: LootCtx, p: PlayerState, rp: PlayerRunState, slot: number): void {
  const { state, config } = ctx;
  const run = state.run!;
  const f = parseCarFrame(p.placement.frame);
  if (!f || run.phase !== 'aboard') { ctx.emit({ type: 'CommandRejected', tick: state.tick, player: p.id, command: 'drop', reason: 'not aboard' }); return; }
  if (!Number.isInteger(slot) || slot < 0 || slot >= rp.carried.length) { ctx.emit({ type: 'CommandRejected', tick: state.tick, player: p.id, command: 'drop', reason: 'nothing to drop' }); return; }
  cancelSearch(ctx, p, rp, 'released');
  const [item] = rp.carried.splice(slot, 1) as [string];
  // On the floor of the cell the player stands in, where it can be searched again.
  const loot: LootState = { id: run.nextLootId++, car: f.car, x: Math.floor(p.placement.x) + 0.5, y: Math.floor(p.placement.y) + 0.5, item, hidden: false, taken: false };
  run.loot.push(loot);
  const def = config.values.items[item]!;
  ctx.emit({ type: 'LootDropped', tick: state.tick, player: p.id, item, value: def.value, weight: def.weight, car: f.car, loot: loot.id });
}

/**
 * Tick system 9, loot: drops first, then searching. Holding E within `reachTiles` of loot in your
 * car searches the nearest; after its search time (`searchTicksFor`) held the item is taken (`LootPickedUp`) unless
 * a carry cap refuses it (`LootRefused`). Releasing E, or moving more than `cancelRangeTiles` from
 * the loot (or into another car), cancels and loses the progress. After a search ends with E still
 * held, E must be released before the next one starts.
 */
export function lootSystem(ctx: LootCtx, drops: ReadonlyMap<PlayerId, readonly number[]>): void {
  const { state, config } = ctx;
  const run = state.run;
  for (const p of state.players) {
    const rp = run?.players[p.id];
    if (!run || !rp) {
      if (drops.has(p.id)) ctx.emit({ type: 'CommandRejected', tick: state.tick, player: p.id, command: 'drop', reason: 'not aboard' });
      continue;
    }
    for (const slot of drops.get(p.id) ?? []) drop(ctx, p, rp, slot);
    const f = parseCarFrame(p.placement.frame);
    if (!f || run.phase !== 'aboard') { rp.search = null; continue; }
    if (!p.interactHeld) { cancelSearch(ctx, p, rp, 'released'); rp.searchLatched = false; continue; }
    if (rp.searchLatched) continue;
    const s = config.values.verbs.search;
    if (!rp.search) {
      const l = nearestLoot(state, p, s.reachTiles);
      if (!l) continue;
      rp.search = { loot: l.id, ticks: 0 };
    }
    const l = run.loot.find((q) => q.id === rp.search!.loot);
    if (!l || l.taken) { rp.search = null; continue; }
    const dx = l.x - p.placement.x, dy = l.y - p.placement.y;
    if (l.car !== f.car || dx * dx + dy * dy > s.cancelRangeTiles * s.cancelRangeTiles) {
      cancelSearch(ctx, p, rp, 'moved away');
      rp.searchLatched = true;
      continue;
    }
    rp.search.ticks += 1;
    if (rp.search.ticks < searchTicksFor(config, l.item)) continue;
    rp.search = null;
    rp.searchLatched = true;
    const why = carryRefusal(config, rp.carried, l.item);
    if (why) { ctx.emit({ type: 'LootRefused', tick: state.tick, player: p.id, item: l.item, reason: why, loot: l.id }); continue; }
    l.taken = true;
    rp.carried.push(l.item);
    const def = config.values.items[l.item]!;
    ctx.emit({ type: 'LootPickedUp', tick: state.tick, player: p.id, item: l.item, value: def.value, weight: def.weight, car: l.car, loot: l.id });
    raiseHeatFor(ctx, 'lootTaken');
  }
}
