// Run generation: which layout each car of a train gets, and the loot placed in its slots.
// Both depend only on the seed and the run number (flag: "Run seeds"), never on how earlier
// runs went, so the same seed and run number give the same cars and loot on any machine.
import { nextInt, nextU32, runSeed, seedRng, type RngState, type StreamName } from '../rng';
import type { GameState, LootState, SimConfig, TrainState } from '../types';
import { carCatalog, carTemplate, type CarCatalog, type Side } from './cars';

const next01 = (rng: RngState, s: StreamName) => nextU32(rng, s) / 4294967296;

/** A weighted pick; `entries` must not be empty. */
export function pickWeighted<T extends { weight: number }>(rng: RngState, stream: StreamName, entries: readonly T[]): T {
  let total = 0;
  for (const e of entries) total += e.weight;
  let r = next01(rng, stream) * total;
  for (const e of entries) { r -= e.weight; if (r < 0) return e; }
  return entries[entries.length - 1]!;
}

/** The layouts a train type picks from: its `layouts` list, else every layout of its car type by id. */
export function layoutPool(config: SimConfig, type: string, catalog: CarCatalog = carCatalog(config)): string[] {
  const def = config.values.trains[type];
  if (!def) throw new Error(`unknown train type ${type}`);
  return def.layouts ? [...def.layouts] : [...catalog.values()].filter((t) => t.carType === def.carType).map((t) => t.id);
}

/**
 * The car templates of one train, engine first: a layout from the pool for each of its `carCount`
 * cars, drawn from the `gen` stream of `seed`. With `requireSideDoors`, picks are then swapped
 * until the train can be boarded from both sides (`both`) or either side (`one`), as far as the
 * pool allows; the engine and caboose count too.
 */
export function pickTrainCars(config: SimConfig, type: string, seed: string): string[] {
  const def = config.values.trains[type]!;
  const catalog = carCatalog(config);
  const pool = layoutPool(config, type, catalog);
  const rng = seedRng(seed);
  const picks: string[] = [];
  for (let i = 0; i < def.carCount && pool.length; i++) picks.push(pool[nextInt(rng, 'gen', pool.length)]!);
  const ends = [def.engine, ...(def.caboose ? [def.caboose] : [])].map((id) => carTemplate(catalog, id));
  const doors = (id: string, side: Side) => carTemplate(catalog, id).sideDoors[side];
  const has = (side: Side, list = picks) => ends.some((t) => t.sideDoors[side]) || list.some((id) => doors(id, side));
  const missing = (list = picks): Side[] => {
    if (def.requireSideDoors === 'off') return [];
    const m = (['left', 'right'] as const).filter((s) => !has(s, list));
    return def.requireSideDoors === 'one' && m.length < 2 ? [] : m;
  };
  for (let guard = 0; guard < picks.length * 2; guard++) {
    const need = missing();
    if (!need.length) break;
    // Prefer a layout covering every missing side; otherwise one that covers some.
    let cands = pool.filter((id) => need.every((s) => doors(id, s)));
    if (!cands.length) cands = pool.filter((id) => need.some((s) => doors(id, s)));
    if (!cands.length) break;
    // Replace a car whose loss keeps every side that is already covered.
    const covered = (['left', 'right'] as const).filter((s) => has(s));
    const free = picks.map((_, i) => i).filter((i) => covered.every((s) => has(s, picks.filter((__, j) => j !== i))));
    if (!free.length) break;
    picks[free[nextInt(rng, 'gen', free.length)]!] = cands[nextInt(rng, 'gen', cands.length)]!;
  }
  return [def.engine, ...picks, ...(def.caboose ? [def.caboose] : [])];
}

/** The seed a free train's layouts come from: the next run's seed plus the train's id. */
export function trainCarsSeed(state: Pick<GameState, 'seed' | 'runCount'>, trainId: string): string {
  return `${runSeed(state.seed, state.runCount + 1)}/${trainId}`;
}

/** Re-pick the layouts of every train no run has committed to, for the next run. */
export function repickFreeTrains(state: GameState, config: SimConfig): void {
  for (const t of state.world.trains) if (t.pinnedBy === null) t.cars = pickTrainCars(config, t.type, trainCarsSeed(state, t.id));
}

interface Slot { car: number; x: number; y: number; tags: readonly string[]; hidden: boolean }

/**
 * Fill the committed train's loot slots from the `gen` stream (re-derived from the run seed at
 * commit). Slots tagged hidden take part only with `verbs.search.hiddenLoot`. First the loot
 * table's prizes (`prizes.count` of them per train) go on slots that fit them, then
 * round(density × loot.densityScale × the remaining fitting slots) small items, capped at all of
 * them. An item fits a slot when one of its `slotTags` is among the slot's tags.
 */
export function generateLoot(state: GameState, config: SimConfig, train: TrainState): LootState[] {
  const v = config.values;
  const def = v.trains[train.type]!;
  if (!def.loot) return [];
  const table = v.lootTables[def.loot.table]!;
  const catalog = carCatalog(config);
  const rng = state.rng;
  const slots: Slot[] = [];
  train.cars.forEach((id, car) => {
    for (const s of carTemplate(catalog, id).lootSlots) {
      const hidden = s.tags.includes('hidden');
      if (hidden && !v.verbs.search.hiddenLoot) continue;
      slots.push({ car, x: s.cell[0] + 0.5, y: s.cell[1] + 0.5, tags: s.tags, hidden });
    }
  });
  const fits = (item: string, s: Slot) => v.items[item]!.slotTags.some((t) => s.tags.includes(t));
  const placed = new Map<Slot, string>();

  if (table.prizes) {
    const [lo, hi] = table.prizes.count;
    const n = lo + nextInt(rng, 'gen', hi - lo + 1);
    for (let k = 0; k < n; k++) {
      const cands = slots.filter((s) => !placed.has(s) && table.prizes!.items.some((e) => fits(e.item, s)));
      if (!cands.length) break;
      const s = cands[nextInt(rng, 'gen', cands.length)]!;
      placed.set(s, pickWeighted(rng, 'gen', table.prizes.items.filter((e) => fits(e.item, s))).item);
    }
  }
  const open = slots.filter((s) => !placed.has(s) && table.items.some((e) => fits(e.item, s)));
  const share = Math.min(1, def.loot.density * v.loot.densityScale);
  const count = Math.round(open.length * share);
  for (let i = open.length - 1; i > 0; i--) {
    const j = nextInt(rng, 'gen', i + 1);
    [open[i], open[j]] = [open[j]!, open[i]!];
  }
  for (const s of open.slice(0, count)) placed.set(s, pickWeighted(rng, 'gen', table.items.filter((e) => fits(e.item, s))).item);

  // Ids in train order, car by car and slot by slot.
  return slots.filter((s) => placed.has(s)).map((s, id) => ({ id, car: s.car, x: s.x, y: s.y, item: placed.get(s)!, hidden: s.hidden, taken: false }));
}
