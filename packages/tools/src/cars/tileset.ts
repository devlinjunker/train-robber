// `tools sync-car-tileset`: writes cars-src/cars.tsj (and its placeholder image cars.png) from the
// cell catalog, so the tileset cannot drift from it. Tile ids are kept for cell types the tileset
// already has, since the car .tmj files store them; a new cell type gets the next free id, and a
// removed one leaves its id unused (grey in the image) so no other tile shifts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CellType } from '@train-robber/config';
import { encodePng } from './png';
import type { Prop } from '../maps/build';

export const TILE_PX = 32;
export const TILESET_FILE = 'cars.tsj';
export const TILESET_IMAGE = 'cars.png';

interface TilesetJson { tiles?: { id: number; properties?: Prop[] }[] }

/** cellType -> tile id from an existing tileset's text. */
export function tileIdsOf(text: string | null): Map<string, number> {
  const ids = new Map<string, number>();
  if (!text) return ids;
  for (const t of (JSON.parse(text) as TilesetJson).tiles ?? []) {
    const v = t.properties?.find((p) => p.name === 'cellType')?.value;
    if (typeof v === 'string') ids.set(v, t.id);
  }
  return ids;
}

/** Stable ids for the catalog: existing ones kept, new types appended in catalog order. */
export function assignTileIds(catalog: readonly Pick<CellType, 'id'>[], existing: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  let next = Math.max(-1, ...existing.values()) + 1;
  for (const c of catalog) out.set(c.id, existing.get(c.id) ?? next++);
  return out;
}

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** The tileset JSON and image for a catalog. */
export function tilesetFor(catalog: readonly CellType[], existingText: string | null): { tsj: string; png: Buffer; ids: Map<string, number> } {
  const ids = assignTileIds(catalog, tileIdsOf(existingText));
  const count = Math.max(0, ...ids.values()) + 1;
  const w = count * TILE_PX, h = TILE_PX;
  const rgba = new Uint8Array(w * h * 4);
  const byId = new Map([...ids].map(([type, id]) => [id, catalog.find((c) => c.id === type)!]));
  for (let id = 0; id < count; id++) {
    const c = byId.get(id);
    const [r, g, b] = c ? hex(c.colour) : [128, 128, 128];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        // A darker border, and walls and other blockers get a cross so they read at a glance.
        const edge = x < 2 || y < 2 || x >= TILE_PX - 2 || y >= TILE_PX - 2;
        const cross = c?.blocksMove && (Math.abs(x - y) < 2 || Math.abs(x + y - TILE_PX + 1) < 2);
        const k = edge ? 0.6 : cross ? 0.8 : 1;
        const o = (y * w + id * TILE_PX + x) * 4;
        rgba[o] = r * k; rgba[o + 1] = g * k; rgba[o + 2] = b * k; rgba[o + 3] = 255;
      }
    }
  }
  const tileset = {
    type: 'tileset', version: '1.10', tiledversion: '1.10.2', name: 'cars',
    tilewidth: TILE_PX, tileheight: TILE_PX, tilecount: count, columns: count,
    image: TILESET_IMAGE, imagewidth: w, imageheight: h, margin: 0, spacing: 0,
    tiles: [...ids].sort((a, b) => a[1] - b[1]).map(([type, id]) => ({ id, properties: [{ name: 'cellType', type: 'string', value: type }] })),
  };
  return { tsj: JSON.stringify(tileset, null, 1) + '\n', png: encodePng(w, h, rgba), ids };
}

/** Write cars.tsj and cars.png in `dir` from the catalog; returns what was written. */
export function syncCarTileset(dir: string, catalog: readonly CellType[]): string[] {
  const path = join(dir, TILESET_FILE);
  const { tsj, png } = tilesetFor(catalog, existsSync(path) ? readFileSync(path, 'utf8') : null);
  writeFileSync(path, tsj);
  writeFileSync(join(dir, TILESET_IMAGE), png);
  return [TILESET_FILE, TILESET_IMAGE];
}
