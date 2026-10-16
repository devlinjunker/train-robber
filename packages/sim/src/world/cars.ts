// Car templates, car placement along a route, and entry points in world space. Layouts come
// from config (`carTemplates`, written by `tools build-cars` from Tiled), and what each cell
// does from the shared cell catalog (`cellTypes`).
import type { CarTemplateDef, SimConfig } from '../types';
import { trackAt, type TrackPoint, type TrackRoute } from './track';

export type Side = 'left' | 'right';

export interface EntryPoint {
  id: string;
  /** Side of the car relative to the direction of travel; end doors are `front` and `rear`. */
  side: Side | 'front' | 'rear';
  /** Distance from the car's centre toward its front, in tiles, to the middle of the entry cell. */
  along: number;
  /** The cell a boarding player lands on: [col, row], col 0 at the front, row 0 on the left. */
  cell: readonly [number, number];
}

/** A side entry point: one you can board from the horse. */
export type SideEntry = EntryPoint & { side: Side };

/** A template ready for the sim: its cells decoded against the catalog. */
export interface PreparedCar {
  id: string;
  carType: string;
  /** Cells along the car (cols) and across it (rows), one cell per tile. */
  size: { cols: number; rows: number };
  /** Catalog index of each cell, row-major. */
  cells: Uint8Array;
  /** 1 where the cell blocks movement, row-major. */
  blocks: Uint8Array;
  entryPoints: readonly EntryPoint[];
  /** The `left` and `right` entry points, which the boarding rule and the world-view markers use. */
  sideEntries: readonly SideEntry[];
  /** Whether the car has a side door on each side. */
  sideDoors: { left: boolean; right: boolean };
  lootSlots: CarTemplateDef['lootSlots'];
  guardSpawns: CarTemplateDef['guardSpawns'];
}

export type CarCatalog = ReadonlyMap<string, PreparedCar>;

const cache = new WeakMap<object, CarCatalog>();

/** Every car template in the config, decoded once per config. */
export function carCatalog(config: SimConfig): CarCatalog {
  const v = config.values;
  let out = cache.get(v);
  if (out) return out;
  const index = new Map(v.cellTypes.map((c, i) => [c.id, i]));
  const map = new Map<string, PreparedCar>();
  for (const id of Object.keys(v.carTemplates).sort()) {
    const t = v.carTemplates[id]!;
    const n = t.size.cols * t.size.rows;
    const cells = new Uint8Array(n), blocks = new Uint8Array(n);
    let i = 0;
    for (const [count, li] of t.cells) {
      const ci = index.get(t.legend[li]!);
      if (ci === undefined) throw new Error(`car ${id} uses cell type ${t.legend[li]}, which is not in the catalog`);
      cells.fill(ci, i, i + count);
      blocks.fill(v.cellTypes[ci]!.blocksMove ? 1 : 0, i, i + count);
      i += count;
    }
    const hl = t.size.cols / 2;
    const entryPoints = t.entryPoints.map((e) => ({ id: e.id, side: e.side, cell: e.cell, along: hl - (e.cell[0] + 0.5) }));
    const sideEntries = entryPoints.filter((e): e is SideEntry => e.side === 'left' || e.side === 'right');
    map.set(id, {
      id, carType: t.carType, size: t.size, cells, blocks, entryPoints, sideEntries,
      sideDoors: { left: sideEntries.some((e) => e.side === 'left'), right: sideEntries.some((e) => e.side === 'right') },
      lootSlots: t.lootSlots, guardSpawns: t.guardSpawns,
    });
  }
  out = map;
  cache.set(v, out);
  return out;
}

export function carTemplate(catalog: CarCatalog, id: string): PreparedCar {
  const t = catalog.get(id);
  if (!t) throw new Error(`unknown car template ${id}`);
  return t;
}

/** True when the cell (col, row) of a template exists and does not block movement. */
export function cellOpen(t: PreparedCar, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < t.size.cols && row < t.size.rows && t.blocks[row * t.size.cols + col] === 0;
}

/** A car's rigid rectangle in world space. */
export interface CarPose {
  trainId: string;
  /** Position in the train, 0 is the engine. */
  index: number;
  template: string;
  /** Centre of the rectangle. */
  x: number;
  y: number;
  /** Unit axis toward the car's front (the direction of travel). */
  ux: number;
  uy: number;
  halfLength: number;
  halfWidth: number;
}

const front: TrackPoint = { d: 0, x: 0, y: 0, tx: 1, ty: 0 };
const rear: TrackPoint = { d: 0, x: 0, y: 0, tx: 1, ty: 0 };

/**
 * Place a train's cars end to end behind the engine's front at distance `d`. Each car is
 * rigid: its front and rear sit on the track and its body is the chord between them, so
 * on a bend the middle of a car cuts inside the curve, as a real one does.
 */
export function placeCars(trainId: string, templates: readonly string[], route: TrackRoute, d: number, catalog: CarCatalog, out: CarPose[] = []): CarPose[] {
  out.length = 0;
  let offset = 0;
  for (let i = 0; i < templates.length; i++) {
    const t = carTemplate(catalog, templates[i]!);
    const len = t.size.cols;
    trackAt(route, d - offset, front);
    trackAt(route, d - offset - len, rear);
    offset += len;
    let ux = front.x - rear.x, uy = front.y - rear.y;
    const n = Math.sqrt(ux * ux + uy * uy);
    if (n > 1e-9) { ux /= n; uy /= n; } else { ux = front.tx; uy = front.ty; }
    out.push({
      trainId, index: i, template: t.id,
      x: (front.x + rear.x) / 2, y: (front.y + rear.y) / 2, ux, uy,
      halfLength: len / 2, halfWidth: t.size.rows / 2,
    });
  }
  return out;
}

/** Total length of a train in tiles. */
export function trainLength(templates: readonly string[], catalog: CarCatalog): number {
  return templates.reduce((n, id) => n + (catalog.get(id)?.size.cols ?? 0), 0);
}

/**
 * An entry point in world space: the car's centre, moved `along` the car and out to the
 * side wall across the track. Left is to the left of the direction of travel (screen y
 * grows down, so left of (ux, uy) is (uy, -ux)). The boarding rule and the markers share this.
 */
export function entryPointWorld(car: CarPose, ep: Pick<EntryPoint, 'side' | 'along'>, out = { x: 0, y: 0 }): { x: number; y: number } {
  const s = ep.side === 'left' ? 1 : -1;
  out.x = car.x + car.ux * ep.along + car.uy * car.halfWidth * s;
  out.y = car.y + car.uy * ep.along - car.ux * car.halfWidth * s;
  return out;
}

/** Every side entry point of a placed car, in world space. */
export function carEntryPoints(car: CarPose, catalog: CarCatalog): { id: string; side: Side; x: number; y: number }[] {
  return carTemplate(catalog, car.template).sideEntries.map((ep) => ({ id: ep.id, side: ep.side, ...entryPointWorld(car, ep) }));
}
