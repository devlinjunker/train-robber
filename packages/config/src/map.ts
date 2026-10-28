import { z } from 'zod';

// MapDef: what `tools build-maps` writes from a Tiled file and what the game reads.
// Units are tiles; x grows right and y grows down, as in Tiled.

export const ZONES = ['open', 'slow', 'blocked', 'water', 'deep'] as const;
export type Zone = (typeof ZONES)[number];
/** Highest elevation level a tile can have. */
export const ELEVATION_MAX = 8;

const point = z.object({ x: z.number(), y: z.number() }).strict();
const nums = z.array(z.number());

/** How big a town is: a halt is a station and a water tower, a village a few houses, a town a street. */
export const TOWN_SIZES = ['halt', 'village', 'town'] as const;
export type TownSize = (typeof TOWN_SIZES)[number];
/** What a town building is; the view draws each its own way. */
export const TOWN_BUILDINGS = ['station', 'platform', 'water-tower', 'house', 'store', 'saloon', 'church', 'stable'] as const;
export type TownBuildingKind = (typeof TOWN_BUILDINGS)[number];
/** One building of a town's layout: a box centred on (x, y), its length along (ux, uy), for the view only. */
const townBuilding = z.object({
  kind: z.enum(TOWN_BUILDINGS), x: z.number(), y: z.number(), ux: z.number(), uy: z.number(),
  halfLength: z.number().positive(), halfWidth: z.number().positive(), heightTiles: z.number().positive(),
}).strict();
export type TownBuilding = z.infer<typeof townBuilding>;

/** A route baked into samples about half a tile apart, so the sim does no spline math. */
export const RouteSchema = z.object({
  id: z.string(),
  closed: z.boolean(),
  smoothing: z.literal('catmull-rom'),
  /** Control points as drawn; the curve passes through them. */
  points: z.array(point).min(2),
  length: z.number().positive(),
  spacing: z.number().positive(),
  /**
   * Columnar samples. Sample i sits at distance s[i] along the route; (tx, ty) is the
   * unit tangent of the segment from sample i to the next (the last one wraps on a
   * closed route); speedScale is the lowest speed zone over the sample, else 1.
   */
  samples: z.object({ x: nums, y: nums, s: nums, tx: nums, ty: nums, speedScale: nums }).strict()
    .refine((c) => [c.y, c.s, c.tx, c.ty, c.speedScale].every((a) => a.length === c.x.length), { message: 'sample columns differ in length' }),
  /**
   * A service built from shared segments: its legs in order, each starting at distance `start`
   * and running from junction `from` to junction `to`. Every service that uses a segment bakes
   * the same samples for it. Routes drawn as one closed polyline have no legs.
   */
  legs: z.array(z.object({ segment: z.string(), start: z.number().min(0), length: z.number().positive(), from: z.string(), to: z.string() }).strict()).min(1).optional(),
}).strict();
export type Route = z.infer<typeof RouteSchema>;

export const MapDefSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  /** Hash of the Tiled source, so a stale build is detectable. */
  source: z.object({ file: z.string(), hash: z.string() }).strict(),
  size: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }).strict(),
  zoneLegend: z.array(z.enum(ZONES)),
  /**
   * Row-major run-length encoding: [count, legend index] pairs. A generated map may leave it (and
   * `elevation`) out: its tiles then come from chunks built on demand (see MapChunks).
   */
  zones: z.array(z.tuple([z.number().int().positive(), z.number().int().min(0)])).optional(),
  /**
   * Optional ground height per tile, run-length encoded like `zones`: [count, level] pairs with
   * levels 0 to ELEVATION_MAX. View only: the sim stays 2D and never reads it. A step of two or
   * more levels between neighbours is a cliff, and the converter blocks the tile on top of it.
   */
  elevation: z.array(z.tuple([z.number().int().positive(), z.number().int().min(0).max(ELEVATION_MAX)])).optional(),
  routes: z.array(RouteSchema).min(1),
  speedZones: z.array(z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), speedScale: z.number().gt(0).max(1) }).strict()),
  /**
   * Trains this map starts with, each on one of its routes at distance `d`. Without it the sim
   * starts one mail train (trainMix `map`), or spreads `trainMix.trainCount` along the mail route.
   */
  trains: z.array(z.object({ type: z.string(), route: z.string(), d: z.number().min(0) }).strict()).min(1).optional(),
  /** Where segments meet, with the track's shared unit tangent there (direction of travel). */
  junctions: z.array(z.object({ id: z.string(), x: z.number(), y: z.number(), tx: z.number(), ty: z.number() }).strict()).optional(),
  /**
   * Maps whose routes are open lines (`?map=line`): trains run one way, enter off the start of the
   * line and are removed past its end, a new one entering once the last is `headwayTiles` in.
   */
  openLine: z.object({
    headwayTiles: z.number().positive(),
    /** Each gap is headwayTiles plus or minus up to this, seeded per train; below headwayTiles. */
    headwaySpreadTiles: z.number().min(0).optional(),
  }).strict().optional(),
  /**
   * Towns along the line (G6): `d` is the distance along route `route`, (x, y) the middle of a flat
   * clearing of `radiusTiles` beside the track on `side` (+1 right of travel). Each has a name, a
   * size and a layout of buildings, all from the seed. `end` marks the two towns at the ends of an
   * open line, off the map, where trains set out from and arrive. The sim reads `route` and `d`
   * (the next-town clock and the timetables); the rest is for the view.
   */
  towns: z.array(z.object({
    id: z.string(), name: z.string(), size: z.enum(TOWN_SIZES), route: z.string(), d: z.number().min(0),
    x: z.number(), y: z.number(), side: z.union([z.literal(1), z.literal(-1)]), radiusTiles: z.number().min(0),
    end: z.enum(['start', 'end']).optional(),
    layout: z.array(townBuilding),
  }).strict()).optional(),
  /** The player starts mounted at playerSpawn; there is no separate horse spawn. */
  markers: z.object({ playerSpawn: point }).catchall(point),
  /**
   * Set on generated open lines (G4): what the map is built from. Its tiles are the same for the
   * same generator, version, seed and settings, so `mapHash` hashes this instead of every tile, and
   * they can be built chunk by chunk, `chunkTiles` square, from these alone.
   */
  generated: z.object({
    generator: z.string(), version: z.string(), seed: z.string(),
    settings: z.record(z.unknown()), chunkTiles: z.number().int().positive(),
  }).strict().optional(),
}).strict().superRefine((m, ctx) => {
  if (!m.zones) {
    if (!m.generated) ctx.addIssue({ code: 'custom', path: ['zones'], message: 'zones are required on a map that is not generated' });
    if (m.elevation) ctx.addIssue({ code: 'custom', path: ['elevation'], message: 'elevation without zones' });
  }
  const tiles = m.zones?.reduce((n, [count]) => n + count, 0) ?? m.size.cols * m.size.rows;
  if (tiles !== m.size.cols * m.size.rows) ctx.addIssue({ code: 'custom', path: ['zones'], message: `zones cover ${tiles} tiles, map has ${m.size.cols * m.size.rows}` });
  if (m.zones?.some(([, i]) => i >= m.zoneLegend.length)) ctx.addIssue({ code: 'custom', path: ['zones'], message: 'zone index outside the legend' });
  const lifted = m.elevation?.reduce((n, [count]) => n + count, 0);
  if (lifted !== undefined && lifted !== m.size.cols * m.size.rows) ctx.addIssue({ code: 'custom', path: ['elevation'], message: `elevation covers ${lifted} tiles, map has ${m.size.cols * m.size.rows}` });
  m.towns?.forEach((t, i) => {
    if (!m.routes.some((r) => r.id === t.route)) ctx.addIssue({ code: 'custom', path: ['towns', i, 'route'], message: `no route ${t.route}` });
  });
  if (m.openLine && m.routes.some((r) => r.closed)) ctx.addIssue({ code: 'custom', path: ['openLine'], message: 'openLine needs every route open' });
  m.trains?.forEach((t, i) => {
    if (!m.routes.some((r) => r.id === t.route)) ctx.addIssue({ code: 'custom', path: ['trains', i, 'route'], message: `no route ${t.route}` });
  });
  for (const [ri, r] of m.routes.entries()) {
    r.legs?.forEach((l, i) => {
      for (const j of [l.from, l.to]) if (!m.junctions?.some((q) => q.id === j)) ctx.addIssue({ code: 'custom', path: ['routes', ri, 'legs', i], message: `no junction ${j}` });
    });
  }
});
export type MapDef = z.infer<typeof MapDefSchema>;

/** A stretch of track to draw: one shared segment, or a whole route drawn as one polyline. */
export interface TrackPiece {
  id: string;
  closed: boolean;
  x: number[]; y: number[]; tx: number[]; ty: number[];
}

/**
 * The map's track with every shared segment once, so track two services share is drawn
 * once. An open piece includes the junction sample it ends on.
 */
export function trackPieces(m: Pick<MapDef, 'routes'>): TrackPiece[] {
  const out: TrackPiece[] = [];
  const seen = new Set<string>();
  for (const r of m.routes) {
    const { x, y, s, tx, ty } = r.samples;
    if (!r.legs) { out.push({ id: r.id, closed: r.closed, x: [...x], y: [...y], tx: [...tx], ty: [...ty] }); continue; }
    for (const l of r.legs) {
      if (seen.has(l.segment)) continue;
      seen.add(l.segment);
      const p: TrackPiece = { id: l.segment, closed: false, x: [], y: [], tx: [], ty: [] };
      const idx: number[] = [];
      for (let i = 0; i < s.length; i++) if (s[i]! >= l.start - 1e-6 && s[i]! < l.start + l.length - 1e-6) idx.push(i);
      // Close the gap to the junction: the sample that starts the next leg.
      idx.push((idx[idx.length - 1]! + 1) % s.length);
      for (const i of idx) { p.x.push(x[i]!); p.y.push(y[i]!); p.tx.push(tx[i]!); p.ty.push(ty[i]!); }
      out.push(p);
    }
  }
  return out;
}

/** Side of a terrain chunk in tiles (G4). Chunk (cx, cy) covers tiles [cx, cx + 1) x [cy, cy + 1) times this. */
export const CHUNK_TILES = 64;

/** One chunk of a generated map: `tiles` x `tiles` tiles row-major (tiles off the map are blocked, level 0) and the scenery standing on them. */
export interface MapChunk {
  cx: number; cy: number;
  zones: Uint8Array; heights: Uint8Array;
  scenery: { kind: number[]; x: number[]; y: number[]; size: number[] };
}

/**
 * Where a generated map's tiles come from when it carries no `zones`: any chunk, built from the
 * seed, the settings and the chunk's position alone, the same every time. Not JSON: it rides along
 * on the map object as `terrain` and is left out when the map is written out.
 */
export interface MapChunks {
  readonly tiles: number;
  chunk(cx: number, cy: number): MapChunk;
}

/** A map whose tiles may come from chunks. */
export type ChunkedMap = MapDef & { terrain?: MapChunks };

/** Copy every chunk's tiles into one whole-map grid. */
function assemble(m: Pick<MapDef, 'size'>, terrain: MapChunks, pick: (c: MapChunk) => Uint8Array): Uint8Array {
  const { cols, rows } = m.size, T = terrain.tiles;
  const out = new Uint8Array(cols * rows);
  for (let cy = 0; cy * T < rows; cy++) {
    for (let cx = 0; cx * T < cols; cx++) {
      const src = pick(terrain.chunk(cx, cy));
      const w = Math.min(T, cols - cx * T);
      for (let y = 0; y < T && cy * T + y < rows; y++) out.set(src.subarray(y * T, y * T + w), (cy * T + y) * cols + cx * T);
    }
  }
  return out;
}

/** Expand the run-length grid into one legend index per tile, row-major (from the chunks on a map without one). */
export function decodeZones(m: Pick<MapDef, 'size' | 'zones'> & { terrain?: MapChunks }): Uint8Array {
  if (!m.zones) {
    if (!m.terrain) throw new Error('map has neither zones nor chunks');
    return assemble(m, m.terrain, (c) => c.zones);
  }
  const out = new Uint8Array(m.size.cols * m.size.rows);
  let i = 0;
  for (const [count, zone] of m.zones) { out.fill(zone, i, i + count); i += count; }
  return out;
}

/** Expand the elevation grid into one level per tile, row-major; all zero when the map has none (from the chunks on a map without zones). */
export function decodeElevation(m: Pick<MapDef, 'size' | 'elevation' | 'zones'> & { terrain?: MapChunks }): Uint8Array {
  if (!m.zones && m.terrain) return assemble(m, m.terrain, (c) => c.heights);
  const out = new Uint8Array(m.size.cols * m.size.rows);
  let i = 0;
  for (const [count, level] of m.elevation ?? []) { out.fill(level, i, i + count); i += count; }
  return out;
}
