// The parts of a built map the sim reads, as structural types: `@train-robber/config`'s
// MapDef satisfies SimMap, so the sim does not depend on the config package.
import { hashState } from '../hash';
import type { TrackRoute } from './track';

export interface SimRoute extends TrackRoute { id: string }

export interface SimMap {
  id: string;
  size: { cols: number; rows: number };
  /** Zone name per legend index; the sim knows 'slow', 'blocked' and 'water'. */
  zoneLegend: readonly string[];
  /** Row-major run-length encoding: [count, legend index] pairs. */
  zones: readonly (readonly [number, number])[];
  routes: readonly SimRoute[];
  markers: { playerSpawn: { x: number; y: number } };
}

/** How a tile affects the horse. Blocked and water both stop it; only blocked ground hurts to run into. */
export const Terrain = { Open: 0, Slow: 1, Blocked: 2, Water: 3 } as const;
export type Terrain = (typeof Terrain)[keyof typeof Terrain];

/** True for terrain nothing can move through. */
export const isSolid = (t: Terrain): boolean => t === Terrain.Blocked || t === Terrain.Water;

/** A map prepared for lookups. Built once per sim; never part of state. */
export interface WorldMap {
  id: string;
  hash: string;
  cols: number;
  rows: number;
  /** One Terrain per tile, row-major. */
  terrain: Uint8Array;
  routes: ReadonlyMap<string, SimRoute>;
  playerSpawn: { x: number; y: number };
}

/** Hash of everything the sim reads from a map, so a snapshot only restores against the same map. */
export function mapHash(map: SimMap): string {
  const r = (route: SimRoute) => {
    const { x, y, s, tx, ty } = route.samples;
    return { id: route.id, closed: route.closed, length: route.length, spacing: route.spacing, samples: { x, y, s, tx, ty } };
  };
  return hashState({ id: map.id, size: map.size, zoneLegend: map.zoneLegend, zones: map.zones, routes: map.routes.map(r), playerSpawn: map.markers.playerSpawn });
}

export function prepareMap(map: SimMap): WorldMap {
  const { cols, rows } = map.size;
  const kind = map.zoneLegend.map((z): Terrain => (z === 'slow' ? Terrain.Slow : z === 'blocked' ? Terrain.Blocked : z === 'water' ? Terrain.Water : Terrain.Open));
  const terrain = new Uint8Array(cols * rows);
  let i = 0;
  for (const [count, zone] of map.zones) {
    terrain.fill(kind[zone] ?? Terrain.Open, i, i + count);
    i += count;
  }
  if (i !== cols * rows) throw new Error(`map ${map.id}: zones cover ${i} tiles, map has ${cols * rows}`);
  return {
    id: map.id,
    hash: mapHash(map),
    cols,
    rows,
    terrain,
    routes: new Map(map.routes.map((r) => [r.id, r])),
    playerSpawn: { ...map.markers.playerSpawn },
  };
}

/** Terrain of the tile containing (x, y); outside the map counts as blocked. */
export function terrainAt(map: WorldMap, x: number, y: number): Terrain {
  const c = Math.floor(x), r = Math.floor(y);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return Terrain.Blocked;
  return map.terrain[r * map.cols + c] as Terrain;
}
