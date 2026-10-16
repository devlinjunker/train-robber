// Resolve step 3's cross-reference checks: every id one part of the config names must exist in
// another. Layout fit (rows, end doors, side doors) is checked by `tools validate`, so a car being
// edited in Tiled never stops the game from loading.
import type { Game } from './schema';

export interface ReferenceError { path: string; message: string }

export function checkReferences(g: Game): ReferenceError | null {
  const cellIds = new Set(g.cellTypes.map((c) => c.id));
  for (const [id, t] of Object.entries(g.carTemplates)) {
    const i = t.legend.findIndex((c) => !cellIds.has(c));
    if (i >= 0) return { path: `carTemplates.${id}.legend.${i}`, message: `unknown cell type ${t.legend[i]}` };
  }
  for (const [id, table] of Object.entries(g.lootTables)) {
    for (const [key, list] of [['items', table.items], ['prizes.items', table.prizes?.items ?? []]] as const) {
      const i = list.findIndex((e) => !g.items[e.item]);
      if (i >= 0) return { path: `lootTables.${id}.${key}.${i}.item`, message: `unknown item ${list[i]!.item}` };
    }
  }
  for (const [id, t] of Object.entries(g.trains)) {
    const at = `trains.${id}`;
    if (!g.carTemplates[t.engine]) return { path: `${at}.engine`, message: `unknown car template ${t.engine}` };
    if (t.caboose !== undefined && !g.carTemplates[t.caboose]) return { path: `${at}.caboose`, message: `unknown car template ${t.caboose}` };
    if (t.carCount > 0 && !Object.values(g.carTemplates).some((c) => c.carType === t.carType)) return { path: `${at}.carType`, message: `no car layout has carType ${t.carType}` };
    for (const [i, l] of (t.layouts ?? []).entries()) {
      const c = g.carTemplates[l];
      if (!c) return { path: `${at}.layouts.${i}`, message: `unknown car template ${l}` };
      if (c.carType !== t.carType) return { path: `${at}.layouts.${i}`, message: `${l} is a ${c.carType}, not a ${t.carType}` };
    }
    if (t.loot && !g.lootTables[t.loot.table]) return { path: `${at}.loot.table`, message: `unknown loot table ${t.loot.table}` };
  }
  for (const key of ['mailTrain', 'blankTrain'] as const) {
    if (!g.trains[g.trainMix[key]]) return { path: `trainMix.${key}`, message: `unknown train ${g.trainMix[key]}` };
  }
  return null;
}
