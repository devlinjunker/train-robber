// The parts of a built map the sim reads, as structural types: `@train-robber/config`'s
// MapDef satisfies SimMap, so the sim does not depend on the config package.
import { hashState } from '../hash';
import type { SimRoute } from './track';
import { buildNetwork, type Network } from './junctions';

export interface SimMap {
  id: string;
  size: { cols: number; rows: number };
  /** Zone name per legend index; the sim knows 'slow', 'blocked', 'water' and 'deep'. */
  zoneLegend: readonly string[];
  /** Row-major run-length encoding: [count, legend index] pairs. */
  zones: readonly (readonly [number, number])[];
  routes: readonly SimRoute[];
  /** Trains the map starts with, each on one of its routes at distance `d` (trainMix `map`). */
  trains?: readonly MapTrain[];
  markers: { playerSpawn: { x: number; y: number } };
  /** Open line maps: trains enter at the start of the line once the last one is headwayTiles in, and leave past its end. */
  openLine?: { headwayTiles: number; headwaySpreadTiles?: number };
  /** Town spots along an open line: where on which route (MapDef.towns). */
  towns?: readonly MapTown[];
}

export interface MapTown { id: string; route: string; d: number }

export interface MapTrain { type: string; route: string; d: number }

/**
 * How a tile affects the horse. Slow ground (mud) and water slow it, water more; blocked ground
 * and deep water stop it, and only blocked ground hurts to run into.
 */
export const Terrain = { Open: 0, Slow: 1, Blocked: 2, Water: 3, Deep: 4 } as const;
export type Terrain = (typeof Terrain)[keyof typeof Terrain];

/** True for terrain nothing can move through. */
export const isSolid = (t: Terrain): boolean => t === Terrain.Blocked || t === Terrain.Deep;

/** A map prepared for lookups. Built once per sim; never part of state. */
export interface WorldMap {
  id: string;
  hash: string;
  cols: number;
  rows: number;
  /** One Terrain per tile, row-major. */
  terrain: Uint8Array;
  routes: ReadonlyMap<string, SimRoute>;
  trains: readonly MapTrain[] | undefined;
  /** Junctions between services; null on maps whose routes share no track. */
  network: Network | null;
  playerSpawn: { x: number; y: number };
  /** Set on open line maps (see SimMap.openLine). */
  openLine: { headwayTiles: number; headwaySpreadTiles?: number } | null;
  /** Town spots, sorted by distance along their route; empty on maps without towns. */
  towns: readonly MapTown[];
}

/** Hash of everything the sim reads from a map, so a snapshot only restores against the same map. */
export function mapHash(map: SimMap): string {
  const r = (route: SimRoute) => {
    const { x, y, s, tx, ty } = route.samples;
    return { id: route.id, closed: route.closed, length: route.length, spacing: route.spacing, samples: { x, y, s, tx, ty }, ...(route.legs ? { legs: route.legs } : {}) };
  };
  return hashState({ id: map.id, size: map.size, zoneLegend: map.zoneLegend, zones: map.zones, routes: map.routes.map(r), playerSpawn: map.markers.playerSpawn, ...(map.trains ? { trains: map.trains } : {}), ...(map.openLine ? { openLine: map.openLine } : {}), ...(map.towns?.length ? { towns: map.towns.map(({ id, route, d }) => ({ id, route, d })) } : {}) });
}

export function prepareMap(map: SimMap): WorldMap {
  const { cols, rows } = map.size;
  const kind = map.zoneLegend.map((z): Terrain => (z === 'slow' ? Terrain.Slow : z === 'blocked' ? Terrain.Blocked : z === 'water' ? Terrain.Water : z === 'deep' ? Terrain.Deep : Terrain.Open));
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
    network: buildNetwork(map.routes),
    trains: map.trains?.map((t) => ({ ...t })),
    playerSpawn: { ...map.markers.playerSpawn },
    openLine: map.openLine ? { ...map.openLine } : null,
    towns: (map.towns ?? []).map(({ id, route, d }) => ({ id, route, d })).sort((a, b) => a.d - b.d),
  };
}

/** Terrain of the tile containing (x, y); outside the map counts as blocked. */
export function terrainAt(map: WorldMap, x: number, y: number): Terrain {
  const c = Math.floor(x), r = Math.floor(y);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return Terrain.Blocked;
  return map.terrain[r * map.cols + c] as Terrain;
}
