// `tools build-cars` and `tools sync-car-tileset`: the checked-in layouts build to the checked-in
// templates, the starter mail cars have the doors M2 asks for, and broken layouts are refused.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCar, CarError } from '../src/cars/build';
import { buildCarsText, carBuildContext, cellCatalog, CARS_OUT, CARS_SRC } from '../src/cars/cli';
import { assignTileIds, tileIdsOf, tilesetFor, TILESET_FILE } from '../src/cars/tileset';

const ctx = carBuildContext();
const read = (name: string) => readFileSync(join(CARS_SRC, name), 'utf8');
// The broken-layout fixtures edit the 16 x 6 small-mail-car-a, whose cells they index by hand.
const SRC = read('small-mail-car-a.tmj');
type Tmj = { layers: { name: string; data?: number[]; objects?: { name: string; x: number; y: number; properties?: { name: string; value: unknown }[] }[] }[]; properties: { name: string; type: string; value: unknown }[] };

/** Build small-mail-car-a after `edit` changes its parsed JSON. */
function buildEdited(edit: (m: Tmj) => void, file = 'small-mail-car-a.tmj') {
  const m = JSON.parse(SRC) as Tmj;
  edit(m);
  return buildCar(join(CARS_SRC, file), JSON.stringify(m), read, ctx);
}
const layer = (m: Tmj, name: string) => m.layers.find((l) => l.name === name)!;
const ids = tileIdsOf(read(TILESET_FILE));
const gid = (type: string) => ids.get(type)! + 1;

describe('build-cars', () => {
  it('the checked-in layouts build to the checked-in car-templates.json', () => {
    const r = buildCarsText();
    expect(r.errors).toEqual([]);
    expect(r.text).toBe(readFileSync(CARS_OUT, 'utf8'));
  });

  it('the three starter mail cars have both-side, one-side and end-only doors, hidden slots and guards, at 28 x 7', () => {
    const cars = (JSON.parse(readFileSync(CARS_OUT, 'utf8')) as { cars: Record<string, { carType: string; size: { cols: number; rows: number }; entryPoints: { side: string }[]; lootSlots: { tags: string[] }[]; guardSpawns: unknown[] }> }).cars;
    const sides = (id: string) => [...new Set(cars[id]!.entryPoints.map((e) => e.side))].sort();
    expect(sides('mail-car-a')).toEqual(['front', 'left', 'rear', 'right']);
    expect(sides('mail-car-b')).toEqual(['front', 'left', 'rear']);
    expect(sides('mail-car-c')).toEqual(['front', 'rear']);
    for (const id of ['mail-car-a', 'mail-car-b', 'mail-car-c']) {
      expect(cars[id]!.carType).toBe('mail-car');
      expect(cars[id]!.lootSlots.some((s) => s.tags.includes('hidden'))).toBe(true);
      expect(cars[id]!.lootSlots.some((s) => s.tags.includes('large'))).toBe(true);
      expect(cars[id]!.guardSpawns.length).toBeGreaterThanOrEqual(1);
      expect(cars[id]!.size).toEqual({ cols: 28, rows: 7 });
    }
    // The 16 x 6 set stays for the small-cars preset, under its own car type.
    for (const id of ['small-mail-car-a', 'small-mail-car-b', 'small-mail-car-c']) {
      expect(cars[id]!.carType).toBe('small-mail-car');
      expect(cars[id]!.size).toEqual({ cols: 16, rows: 6 });
    }
  });

  it('refuses a missing layer, an unpainted cell and an unknown map type', () => {
    expect(() => buildEdited((m) => { m.layers = m.layers.filter((l) => l.name !== 'entryPoints'); })).toThrow(/missing layer "entryPoints"/);
    expect(() => buildEdited((m) => { layer(m, 'cells').data![20] = 0; })).toThrow(/cell 4,1 is not painted/);
    expect(() => buildEdited((m) => { m.properties = []; })).toThrow(/carType/);
  });

  it('refuses entry points off their edge or on a wall, and loot slots on blocking cells', () => {
    expect(() => buildEdited((m) => { layer(m, 'entryPoints').objects![0]!.y = 80; })).toThrow(/not on the car's left edge/);
    expect(() => buildEdited((m) => { layer(m, 'entryPoints').objects![0]!.x = 16; })).toThrow(/on a wall cell/);
    expect(() => buildEdited((m) => { Object.assign(layer(m, 'lootSlots').objects![0]!, { x: 16, y: 16 }); })).toThrow(/blocks movement/);
    expect(() => buildEdited((m) => { layer(m, 'lootSlots').objects![0]!.properties = []; })).toThrow(/set a "tags" property/);
  });

  it('refuses a loot slot no entry point can reach', () => {
    // Wall in the loot slot at (1,1) with walls on its right and below.
    expect(() => buildEdited((m) => {
      const d = layer(m, 'cells').data!;
      d[1 * 16 + 2] = gid('wall'); d[2 * 16 + 1] = gid('wall'); d[2 * 16 + 2] = gid('wall');
      Object.assign(layer(m, 'lootSlots').objects![0]!, { x: 48, y: 48 });
    })).toThrow(/cannot be reached from any entry point/);
  });

  it('refuses a car that is one unbroken corridor unless its corridor property says so', () => {
    const corridor = (m: Tmj) => {
      const d = layer(m, 'cells').data!;
      // Rows 1 and 4 become wall, leaving rows 2-3 as the only floor, then thin it to one row.
      for (let c = 1; c < 15; c++) { d[16 + c] = gid('wall'); d[4 * 16 + c] = gid('wall'); d[3 * 16 + c] = gid('wall'); }
      for (const name of ['entryPoints', 'lootSlots', 'guardSpawns', 'patrol']) layer(m, name).objects = [];
      layer(m, 'entryPoints').objects = [{ name: 'front', x: 16, y: 80, properties: [{ name: 'side', value: 'front' }] }];
      // A car type the mail train loots, so an empty car warns.
      m.properties = [{ name: 'carType', type: 'string', value: 'mail-car' }];
    };
    expect(() => buildEdited(corridor)).toThrow(/unbroken corridor/);
    const r = buildEdited((m) => { corridor(m); m.properties.push({ name: 'corridor', type: 'bool', value: true }); });
    expect(r.template.size).toEqual({ cols: 16, rows: 6 });
    expect(r.warnings.join()).toMatch(/no loot slots/);
  });

  it('CarError names the file', () => {
    expect(() => buildEdited((m) => { m.properties = []; })).toThrow(CarError);
    expect(() => buildEdited((m) => { m.properties = []; })).toThrow(/small-mail-car-a\.tmj/);
  });
});

describe('sync-car-tileset', () => {
  it('keeps existing tile ids and appends new cell types', () => {
    const existing = new Map([['wall', 0], ['floor', 1]]);
    const next = assignTileIds([{ id: 'floor' }, { id: 'rug' }, { id: 'wall' }], existing);
    expect(Object.fromEntries(next)).toEqual({ wall: 0, floor: 1, rug: 2 });
  });

  it('the checked-in tileset matches the cell catalog', () => {
    const { tsj } = tilesetFor(cellCatalog(), read(TILESET_FILE));
    expect(tsj).toBe(read(TILESET_FILE));
  });
});
