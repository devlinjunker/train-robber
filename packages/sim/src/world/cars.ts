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
 * Track distance between one car body's rear and the next one's front: a platform at each end
 * and the coupling gap between them (sneaking PR 2). 0 puts the cars end to end, as before.
 */
/**
 * Boxes that close the coupling gap between neighbouring cars of a train, for horses to collide
 * with. On a bend the gap opens into a wedge on the outside of the curve that a horse can ride into
 * and be squeezed in as the train straightens (issue #60). Each box spans from one car's rear to the
 * next car's front along their mean axis, as wide as the wider car, and reaches past both ends far
 * enough to cover the wedge's outer corners. `cars` are boxes as placed (platforms included or not).
 */
export function couplingBoxes(cars: readonly CarPose[]): CarPose[] {
  const out: CarPose[] = [];
  for (let i = 0; i + 1 < cars.length; i++) {
    const a = cars[i]!, b = cars[i + 1]!;
    if (a.trainId !== b.trainId || b.index !== a.index + 1) continue;
    const rx = a.x - a.ux * a.halfLength, ry = a.y - a.uy * a.halfLength;
    const fx = b.x + b.ux * b.halfLength, fy = b.y + b.uy * b.halfLength;
    let ux = a.ux + b.ux, uy = a.uy + b.uy;
    const n = Math.sqrt(ux * ux + uy * uy);
    if (n === 0) continue;
    ux /= n; uy /= n;
    const halfWidth = Math.max(a.halfWidth, b.halfWidth);
    // sin of half the bend between the two cars: how far the wedge's corners reach along the axis.
    const sinHalf = Math.sqrt(Math.max(0, (1 - (a.ux * b.ux + a.uy * b.uy)) / 2));
    const gap = Math.sqrt((fx - rx) ** 2 + (fy - ry) ** 2);
    out.push({ trainId: a.trainId, index: a.index, template: a.template, x: (rx + fx) / 2, y: (ry + fy) / 2, ux, uy, halfLength: gap / 2 + halfWidth * sinHalf + 0.1, halfWidth });
  }
  return out;
}

export function carSpacing(config: SimConfig): number {
  const o = config.values.outside;
  return 2 * o.platformDepthTiles + o.couplingGapTiles;
}

/**
 * Place a train's cars behind the engine's front at distance `d`, `spacing` tiles of track apart
 * (the platforms and coupling, see carSpacing). Each car body is rigid: its front and rear sit on
 * the track and its body is the chord between them, so on a bend the middle of a car cuts inside
 * the curve, as a real one does. Its platforms stick out along the same axis.
 */
export function placeCars(trainId: string, templates: readonly string[], route: TrackRoute, d: number, catalog: CarCatalog, out: CarPose[] = [], spacing = 0): CarPose[] {
  out.length = 0;
  let offset = 0;
  for (let i = 0; i < templates.length; i++) {
    const t = carTemplate(catalog, templates[i]!);
    const len = t.size.cols;
    trackAt(route, d - offset, front);
    trackAt(route, d - offset - len, rear);
    offset += len + spacing;
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

/**
 * Total length of a train in tiles, from the engine's front to the back of the last car's rear
 * platform: the car bodies, `spacing` between each pair, and `rearPlatform` at the end.
 */
export function trainLength(templates: readonly string[], catalog: CarCatalog, spacing = 0, rearPlatform = 0): number {
  const bodies = templates.reduce((n, id) => n + (catalog.get(id)?.size.cols ?? 0), 0);
  return templates.length === 0 ? 0 : bodies + spacing * (templates.length - 1) + rearPlatform;
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
