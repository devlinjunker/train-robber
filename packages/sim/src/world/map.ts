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
  /** Row-major run-length encoding: [count, legend index] pairs. A generated map may leave it out and give `terrain` instead. */
  zones?: readonly (readonly [number, number])[];
  /**
   * A generated map's tiles, chunk by chunk (`@train-robber/config` MapChunks): legend indices,
   * `tiles` x `tiles` row-major. When given, the sim reads tiles from it as it needs them and never
   * builds the whole map; it is used in place of `zones`.
   */
  terrain?: { readonly tiles: number; chunk(cx: number, cy: number): { zones: Uint8Array } };
  /** Set on generated maps: what they are built from (MapDef.generated). `mapHash` hashes it instead of every tile. */
  generated?: { generator: string; version: string; seed: string; settings: unknown; chunkTiles: number };
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
  /** One Terrain per tile, row-major; null on a map read chunk by chunk (see `chunks`). */
  terrain: Uint8Array | null;
  /** Terrain chunks of a generated map, built as the sim first reads a tile in them; null when `terrain` holds every tile. */
  chunks: TerrainChunks | null;
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

/**
 * Terrain of a generated map, one chunk at a time: each chunk's legend indices from the map's
 * `terrain` turned into Terrain once, then kept. Chunks are the same whenever they are built, so
 * the order the sim first reads them in cannot change a run.
 */
export class TerrainChunks {
  readonly tiles: number;
  private readonly got = new Map<number, Uint8Array>();
  private lastKey = NaN;
  private last: Uint8Array | null = null;
  constructor(private readonly source: NonNullable<SimMap['terrain']>, private readonly kind: readonly Terrain[]) { this.tiles = source.tiles; }
  /** Chunks read so far. */
  get count(): number { return this.got.size; }
  /** Terrain of tile (c, r), which must be on the map. */
  at(c: number, r: number): Terrain {
    const T = this.tiles, cx = Math.floor(c / T), cy = Math.floor(r / T), key = cy * 100_003 + cx;
    let chunk = key === this.lastKey ? this.last : this.got.get(key);
    if (!chunk) {
      const zones = this.source.chunk(cx, cy).zones;
      chunk = new Uint8Array(T * T);
      for (let i = 0; i < T * T; i++) chunk[i] = this.kind[zones[i]!] ?? Terrain.Open;
      this.got.set(key, chunk);
    }
    this.lastKey = key; this.last = chunk;
    return chunk[(r - cy * T) * T + (c - cx * T)] as Terrain;
  }
}

/**
 * Hash of everything the sim reads from a map, so a snapshot only restores against the same map.
 * A generated map is hashed by what it is built from (generator, version, seed, settings), which
 * fixes every tile, route, town and marker on it, instead of by every tile.
 */
export function mapHash(map: SimMap): string {
  if (map.generated) return hashState({ id: map.id, generated: map.generated });
  const r = (route: SimRoute) => {
    const { x, y, s, tx, ty } = route.samples;
    return { id: route.id, closed: route.closed, length: route.length, spacing: route.spacing, samples: { x, y, s, tx, ty }, ...(route.legs ? { legs: route.legs } : {}) };
  };
  return hashState({ id: map.id, size: map.size, zoneLegend: map.zoneLegend, zones: map.zones, routes: map.routes.map(r), playerSpawn: map.markers.playerSpawn, ...(map.trains ? { trains: map.trains } : {}), ...(map.openLine ? { openLine: map.openLine } : {}), ...(map.towns?.length ? { towns: map.towns.map(({ id, route, d }) => ({ id, route, d })) } : {}) });
}

export function prepareMap(map: SimMap): WorldMap {
  const { cols, rows } = map.size;
  const kind = map.zoneLegend.map((z): Terrain => (z === 'slow' ? Terrain.Slow : z === 'blocked' ? Terrain.Blocked : z === 'water' ? Terrain.Water : z === 'deep' ? Terrain.Deep : Terrain.Open));
  let terrain: Uint8Array | null = null, chunks: TerrainChunks | null = null;
  if (map.terrain) chunks = new TerrainChunks(map.terrain, kind);
  else {
    if (!map.zones) throw new Error(`map ${map.id}: no zones and no terrain chunks`);
    terrain = new Uint8Array(cols * rows);
    let i = 0;
    for (const [count, zone] of map.zones) {
      terrain.fill(kind[zone] ?? Terrain.Open, i, i + count);
      i += count;
    }
    if (i !== cols * rows) throw new Error(`map ${map.id}: zones cover ${i} tiles, map has ${cols * rows}`);
  }
  return {
    id: map.id,
    hash: mapHash(map),
    cols,
    rows,
    terrain,
    chunks,
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
  return map.terrain ? map.terrain[r * map.cols + c] as Terrain : map.chunks!.at(c, r);
}
