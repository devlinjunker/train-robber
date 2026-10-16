// `tools build-cars`: one Tiled car layout (.tmj) -> a car template. See "Car Tiled workflow in
// detail" in docs/technical-design.md for the layers, properties and checks.
import { basename } from 'node:path';
import { hashState } from '@train-robber/sim';
import { CarTemplateSchema, ENTRY_SIDES, FACINGS, type CarTemplateDef, type CellType } from '@train-robber/config';
import { FLIP_MASK, flatten, prop, tileData, type TiledLayer, type TiledMap, type TiledObject, type TiledTileset } from '../maps/build';

export class CarError extends Error {
  constructor(file: string, detail: string) { super(`${file}: ${detail}`); this.name = 'CarError'; }
}

export interface CarBuildContext {
  cellTypes: readonly CellType[];
  /** Slot tags some loot table can fill (from the items in every table), plus `hidden`. */
  usedTags: ReadonlySet<string>;
  /** Car types a train with a loot table uses for its cars, which should have loot slots. */
  lootCarTypes: ReadonlySet<string>;
}

export interface CarBuildResult { id: string; template: CarTemplateDef; warnings: string[] }

type Cell = [number, number];
const key = ([c, r]: Cell) => `${c},${r}`;
const N4: Cell[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Compile one car layout. `readSibling` loads the external tileset relative to the file. */
export function buildCar(file: string, text: string, readSibling: (name: string) => string, ctx: CarBuildContext): CarBuildResult {
  const errors: string[] = [];
  const fail = (m: string): never => { throw new CarError(file, m); };
  const id = basename(file).replace(/\.tmj$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('file name must be a lowercase id with dashes, e.g. mail-car-d.tmj');
  const tm = JSON.parse(text) as TiledMap;
  if (tm.orientation !== 'orthogonal') fail(`orientation must be orthogonal, got ${tm.orientation}`);
  if (tm.infinite) fail('map must be fixed size, not infinite');
  const cols = tm.width, rows = tm.height, tw = tm.tilewidth, th = tm.tileheight;
  const warnings: string[] = [];
  let sourceText = text;

  const carType = prop(tm.properties, 'carType');
  if (typeof carType !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(carType)) fail('set a map property "carType" (string), e.g. mail-car');
  const corridor = prop(tm.properties, 'corridor') === true;
  const roofText = prop(tm.properties, 'roofAccess');
  const roofAccess = typeof roofText === 'string' ? roofText.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const layers = flatten(tm.layers);
  const layer = (name: string, type: TiledLayer['type']) => {
    const l = layers.find((x) => x.name === name);
    if (!l) return fail(`missing layer "${name}"`);
    if (l.type !== type) fail(`layer "${name}" must be a ${type}, got ${l.type}`);
    return l;
  };

  // Cells: gid -> cell type through the tileset's `cellType` property.
  const catalog = new Map(ctx.cellTypes.map((c) => [c.id, c]));
  const typeOfGid = new Map<number, string>();
  for (const ts of tm.tilesets) {
    let tiles: TiledTileset['tiles'] = ts.tiles;
    if (ts.source) {
      const tsText = readSibling(ts.source);
      sourceText += tsText;
      tiles = (JSON.parse(tsText) as TiledTileset).tiles;
    }
    for (const t of tiles ?? []) {
      const v = prop(t.properties, 'cellType');
      if (typeof v === 'string') typeOfGid.set(ts.firstgid + t.id, v);
    }
  }
  const gids = tileData(layer('cells', 'tilelayer'), fail);
  if (gids.length !== cols * rows) fail(`cells has ${gids.length} tiles, car is ${cols} x ${rows}`);
  const types: string[] = [];
  gids.forEach((raw, i) => {
    const at = `${i % cols},${Math.floor(i / cols)}`;
    const gid = raw & FLIP_MASK;
    const type = gid === 0 ? undefined : typeOfGid.get(gid);
    if (gid === 0) errors.push(`cell ${at} is not painted (a hole in a car is never intended)`);
    else if (type === undefined) errors.push(`cell ${at} (gid ${gid}) has no cellType property`);
    else if (!catalog.has(type)) errors.push(`cell ${at} has cell type "${type}", which is not in cell-types.json`);
    types.push(type ?? 'wall');
  });
  if (errors.length) fail(errors.join('; '));
  const typeAt = ([c, r]: Cell) => types[r * cols + c]!;
  const inCar = ([c, r]: Cell) => c >= 0 && r >= 0 && c < cols && r < rows;
  const walkable = (cell: Cell) => inCar(cell) && !catalog.get(typeAt(cell))!.blocksMove;
  const toCell = (o: TiledObject, x = o.x, y = o.y): Cell => [Math.floor(x / tw), Math.floor(y / th)];
  const objects = (name: string) => layer(name, 'objectgroup').objects ?? [];

  // Entry points: on a floor or door cell on the edge their side names.
  const entryPoints: CarTemplateDef['entryPoints'] = [];
  for (const o of objects('entryPoints')) {
    const cell = toCell(o);
    const side = prop(o.properties, 'side');
    const label = `entry point ${o.name || o.id}`;
    if (!o.name) { errors.push(`${label}: give it a name, its id (e.g. side-left)`); continue; }
    if (!ENTRY_SIDES.includes(side as never)) { errors.push(`${label}: property "side" must be one of ${ENTRY_SIDES.join(', ')}`); continue; }
    if (!inCar(cell)) { errors.push(`${label} is outside the car`); continue; }
    const onEdge = side === 'left' ? cell[1] === 0 : side === 'right' ? cell[1] === rows - 1 : side === 'front' ? cell[0] === 0 : cell[0] === cols - 1;
    if (!onEdge) errors.push(`${label} (side ${String(side)}) is at ${key(cell)}, not on the car's ${String(side)} edge`);
    if (!['floor', 'door'].includes(typeAt(cell))) errors.push(`${label} is on a ${typeAt(cell)} cell, not floor or door`);
    if (entryPoints.some((e) => e.id === o.name)) errors.push(`${label}: duplicate id`);
    entryPoints.push({ id: o.name, side: side as (typeof ENTRY_SIDES)[number], cell });
  }
  for (const r of roofAccess) if (!entryPoints.some((e) => e.id === r)) errors.push(`roofAccess names entry point ${r}, which the car does not have`);

  // Loot slots and guard spawns: on cells you can stand on, one per cell.
  const taken = new Map<string, string>();
  const place = (label: string, cell: Cell) => {
    if (!inCar(cell)) { errors.push(`${label} is outside the car`); return false; }
    if (!walkable(cell)) errors.push(`${label} is on a ${typeAt(cell)} cell, which blocks movement`);
    const prev = taken.get(key(cell));
    if (prev) errors.push(`${label} shares cell ${key(cell)} with ${prev}`);
    taken.set(key(cell), label);
    return true;
  };
  const lootSlots: CarTemplateDef['lootSlots'] = [];
  for (const o of objects('lootSlots')) {
    const cell = toCell(o);
    const label = `loot slot ${o.name || o.id} at ${key(cell)}`;
    const tagText = prop(o.properties, 'tags');
    const tags = typeof tagText === 'string' ? tagText.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (tags.filter((t) => t !== 'hidden').length === 0) errors.push(`${label}: set a "tags" property, e.g. small or small,hidden`);
    for (const t of tags) if (!ctx.usedTags.has(t)) warnings.push(`${label}: no loot table uses the tag "${t}"`);
    if (place(label, cell)) lootSlots.push({ cell, tags });
  }

  // Patrol routes: polylines turned into the cells they pass through.
  const patrols: Record<string, Cell[]> = {};
  for (const o of objects('patrol')) {
    const label = `patrol ${o.name || o.id}`;
    if (!o.name) { errors.push(`${label}: give it a name for guard spawns to refer to`); continue; }
    if (!o.polyline || o.polyline.length < 2) { errors.push(`${label} must be a polyline with at least two points`); continue; }
    const cells: Cell[] = [];
    const pts = o.polyline.map((p) => ({ x: (o.x + p.x) / tw, y: (o.y + p.y) / th }));
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4));
      for (let s = 0; s <= steps; s++) {
        const cell: Cell = [Math.floor(a.x + ((b.x - a.x) * s) / steps), Math.floor(a.y + ((b.y - a.y) * s) / steps)];
        const last = cells[cells.length - 1];
        if (!last || last[0] !== cell[0] || last[1] !== cell[1]) cells.push(cell);
      }
    }
    const bad = cells.find((c) => !walkable(c));
    if (bad) errors.push(`${label} crosses ${inCar(bad) ? `a ${typeAt(bad)} cell` : 'outside the car'} at ${key(bad)}`);
    patrols[o.name] = cells;
  }

  const guardSpawns: CarTemplateDef['guardSpawns'] = [];
  for (const o of objects('guardSpawns')) {
    const cell = toCell(o);
    const label = `guard spawn ${o.name || o.id} at ${key(cell)}`;
    const facing = prop(o.properties, 'facing');
    const patrol = prop(o.properties, 'patrol');
    if (!FACINGS.includes(facing as never)) errors.push(`${label}: property "facing" must be one of ${FACINGS.join(', ')}`);
    if (patrol !== undefined && patrol !== '' && (typeof patrol !== 'string' || !patrols[patrol])) errors.push(`${label}: patrol "${String(patrol)}" is not a polyline on the patrol layer`);
    if (place(label, cell)) guardSpawns.push({ cell, facing: (facing ?? 'left') as (typeof FACINGS)[number], ...(typeof patrol === 'string' && patrol ? { patrol } : {}) });
  }

  // Reachability: a flood fill from every entry point over cells that don't block movement.
  const reached = new Set<string>();
  const queue: Cell[] = entryPoints.map((e) => e.cell).filter(walkable);
  for (const c of queue) reached.add(key(c));
  while (queue.length) {
    const [c, r] = queue.pop()!;
    for (const [dc, dr] of N4) {
      const n: Cell = [c + dc, r + dr];
      if (walkable(n) && !reached.has(key(n))) { reached.add(key(n)); queue.push(n); }
    }
  }
  const unreachable = (label: string, cell: Cell) => { if (inCar(cell) && walkable(cell) && !reached.has(key(cell))) errors.push(`${label} at ${key(cell)} cannot be reached from any entry point`); };
  lootSlots.forEach((s, i) => unreachable(`loot slot ${i + 1}`, s.cell));
  guardSpawns.forEach((g, i) => unreachable(`guard spawn ${i + 1}`, g.cell));

  // A car that is one unbroken corridor (every walkable cell has at most two walkable neighbours) is refused unless marked.
  const walk: Cell[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (walkable([c, r])) walk.push([c, r]);
  const isCorridor = walk.length > 0 && walk.every(([c, r]) => N4.filter(([dc, dr]) => walkable([c + dc, r + dr])).length <= 2);
  if (isCorridor && !corridor) errors.push('the car is one unbroken corridor; widen it, or set the map property "corridor" (bool) to true if that is intended');

  if (lootSlots.length === 0 && ctx.lootCarTypes.has(carType as string)) warnings.push(`no loot slots, but a train with a loot table uses ${String(carType)} cars`);
  if (errors.length) fail(errors.join('; '));

  // Encode cells against a legend of the cell types this car uses, in catalog order.
  const legend = ctx.cellTypes.map((c) => c.id).filter((t) => types.includes(t));
  const cells: [number, number][] = [];
  for (const t of types) {
    const v = legend.indexOf(t);
    const last = cells[cells.length - 1];
    if (last && last[1] === v) last[0]++;
    else cells.push([1, v]);
  }
  const template = CarTemplateSchema.parse({
    carType, size: { cols, rows }, legend, cells, entryPoints, lootSlots, guardSpawns, patrols, roofAccess, corridor,
    source: { file: basename(file), hash: hashState(sourceText) },
  });
  return { id, template, warnings };
}
