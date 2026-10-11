import { z } from 'zod';

// MapDef: what `tools build-maps` writes from a Tiled file and what the game reads.
// Units are tiles; x grows right and y grows down, as in Tiled.

export const ZONES = ['open', 'slow', 'blocked', 'water', 'deep'] as const;
export type Zone = (typeof ZONES)[number];
/** Highest elevation level a tile can have. */
export const ELEVATION_MAX = 8;

const point = z.object({ x: z.number(), y: z.number() }).strict();
const nums = z.array(z.number());

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
}).strict();
export type Route = z.infer<typeof RouteSchema>;

export const MapDefSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  /** Hash of the Tiled source, so a stale build is detectable. */
  source: z.object({ file: z.string(), hash: z.string() }).strict(),
  size: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }).strict(),
  zoneLegend: z.array(z.enum(ZONES)),
  /** Row-major run-length encoding: [count, legend index] pairs. */
  zones: z.array(z.tuple([z.number().int().positive(), z.number().int().min(0)])),
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
  /** The player starts mounted at playerSpawn; there is no separate horse spawn. */
  markers: z.object({ playerSpawn: point }).catchall(point),
}).strict().superRefine((m, ctx) => {
  const tiles = m.zones.reduce((n, [count]) => n + count, 0);
  if (tiles !== m.size.cols * m.size.rows) ctx.addIssue({ code: 'custom', path: ['zones'], message: `zones cover ${tiles} tiles, map has ${m.size.cols * m.size.rows}` });
  if (m.zones.some(([, i]) => i >= m.zoneLegend.length)) ctx.addIssue({ code: 'custom', path: ['zones'], message: 'zone index outside the legend' });
  const lifted = m.elevation?.reduce((n, [count]) => n + count, 0);
  if (lifted !== undefined && lifted !== m.size.cols * m.size.rows) ctx.addIssue({ code: 'custom', path: ['elevation'], message: `elevation covers ${lifted} tiles, map has ${m.size.cols * m.size.rows}` });
  m.trains?.forEach((t, i) => {
    if (!m.routes.some((r) => r.id === t.route)) ctx.addIssue({ code: 'custom', path: ['trains', i, 'route'], message: `no route ${t.route}` });
  });
});
export type MapDef = z.infer<typeof MapDefSchema>;

/** Expand the run-length grid into one legend index per tile, row-major. */
export function decodeZones(m: Pick<MapDef, 'size' | 'zones'>): Uint8Array {
  const out = new Uint8Array(m.size.cols * m.size.rows);
  let i = 0;
  for (const [count, zone] of m.zones) { out.fill(zone, i, i + count); i += count; }
  return out;
}

/** Expand the elevation grid into one level per tile, row-major; all zero when the map has none. */
export function decodeElevation(m: Pick<MapDef, 'size' | 'elevation'>): Uint8Array {
  const out = new Uint8Array(m.size.cols * m.size.rows);
  let i = 0;
  for (const [count, level] of m.elevation ?? []) { out.fill(level, i, i + count); i += count; }
  return out;
}
