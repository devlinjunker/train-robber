import { existsSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CellTypesFileSchema, ItemsFileSchema, LootTablesFileSchema, type CellType } from '@train-robber/config';
import { CONTENT_DIR, REPO_ROOT, readJson } from '../content';
import { stringifyMap } from '../maps/build';
import { buildCar, type CarBuildContext } from './build';
import { syncCarTileset } from './tileset';

export const CARS_SRC = join(CONTENT_DIR, 'cars-src');
export const CARS_OUT = join(CONTENT_DIR, 'base/car-templates.json');
export const GENERATED_BY = 'tools build-cars from packages/content/cars-src/*.tmj; do not edit by hand, run npm run cars';

function parsed<T>(schema: { parse(v: unknown): T }, path: string): T {
  try {
    return schema.parse(readJson(path));
  } catch (e) {
    throw new Error(`${relative(REPO_ROOT, path)}: ${(e as Error).message}`);
  }
}

export function cellCatalog(dir = CONTENT_DIR): CellType[] {
  return parsed(CellTypesFileSchema, join(dir, 'base/cell-types.json')).cellTypes;
}

/** What the car checks read from the rest of the content: the catalog, the loot tags in use and the car types that hold loot. */
export function carBuildContext(dir = CONTENT_DIR): CarBuildContext {
  const items = parsed(ItemsFileSchema, join(dir, 'base/items.json')).items;
  const tables = parsed(LootTablesFileSchema, join(dir, 'base/loot-tables.json')).lootTables;
  const usedTags = new Set<string>(['hidden']);
  for (const t of Object.values(tables)) for (const e of [...t.items, ...(t.prizes?.items ?? [])]) for (const tag of items[e.item]?.slotTags ?? []) usedTags.add(tag);
  const game = readJson(join(dir, 'base/game.json')) as { trains?: Record<string, { carType?: string; loot?: unknown }> };
  const lootCarTypes = new Set(Object.values(game.trains ?? {}).filter((t) => t.loot && t.carType).map((t) => t.carType!));
  return { cellTypes: cellCatalog(dir), usedTags, lootCarTypes };
}

/** The text of car-templates.json for every cars-src/*.tmj, with warnings; throws on the first broken car after listing all errors. */
export function buildCarsText(src = CARS_SRC, dir = CONTENT_DIR): { text: string; warnings: string[]; errors: string[]; ids: string[] } {
  const ctx = carBuildContext(dir);
  const files = readdirSync(src).filter((f) => f.endsWith('.tmj')).sort();
  const cars: Record<string, unknown> = {};
  const warnings: string[] = [], errors: string[] = [];
  for (const f of files) {
    try {
      const r = buildCar(f, readFileSync(join(src, f), 'utf8'), (name) => readFileSync(join(src, name), 'utf8'), ctx);
      for (const w of r.warnings) warnings.push(`${f}: ${w}`);
      cars[r.id] = r.template;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const text = stringifyMap({ schemaVersion: 1, generatedBy: GENERATED_BY, cars });
  return { text, warnings, errors, ids: Object.keys(cars) };
}

/** Build every car into base/car-templates.json. With `check`, only report a stale or missing output. */
export function buildCars(check: boolean): number {
  const { text, warnings, errors, ids } = buildCarsText();
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  if (errors.length) return 1;
  const rel = relative(REPO_ROOT, CARS_OUT);
  if (check) {
    const current = existsSync(CARS_OUT) ? readFileSync(CARS_OUT, 'utf8') : null;
    if (current !== text) { console.error(`error: ${rel} is ${current === null ? 'missing' : 'stale'}; run npm run cars`); return 1; }
    console.log(`ok ${rel} (${ids.join(', ')})`);
    return 0;
  }
  writeFileSync(CARS_OUT, text);
  console.log(`wrote ${rel} (${ids.length} cars: ${ids.join(', ')})`);
  return 0;
}

export function syncTileset(): number {
  const written = syncCarTileset(CARS_SRC, cellCatalog());
  console.log(`wrote ${written.map((f) => relative(REPO_ROOT, join(CARS_SRC, f))).join(', ')}`);
  return 0;
}

/** Rebuild the cars when a layout, the tileset or a catalog changes, and keep running. */
export function watchCars(settleMs = 150): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = () => {
    timer = undefined;
    console.log(`\n[${new Date().toLocaleTimeString()}] rebuilding cars`);
    buildCars(false);
  };
  buildCars(false);
  const onChange = (name: string | null, pattern: RegExp) => {
    if (name && !pattern.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, settleMs);
  };
  watch(CARS_SRC, (_e, name) => onChange(name, /\.(tmj|tsj)$/));
  watch(join(CONTENT_DIR, 'base'), (_e, name) => onChange(name, /^(cell-types|items|loot-tables|game)\.json$/));
  console.log(`watching ${relative(REPO_ROOT, CARS_SRC)} (Ctrl+C to stop)`);
}
