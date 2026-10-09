import { z } from 'zod';

// MapDef: what `tools build-maps` writes from a Tiled file and what the game reads.
// Units are tiles; x grows right and y grows down, as in Tiled.

export const ZONES = ['open', 'slow', 'blocked', 'water'] as const;
export type Zone = (typeof ZONES)[number];

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
  routes: z.array(RouteSchema).min(1),
  speedZones: z.array(z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), speedScale: z.number().gt(0).max(1) }).strict()),
  markers: z.object({ playerSpawn: point, horseSpawn: point }).catchall(point),
}).strict().superRefine((m, ctx) => {
  const tiles = m.zones.reduce((n, [count]) => n + count, 0);
  if (tiles !== m.size.cols * m.size.rows) ctx.addIssue({ code: 'custom', path: ['zones'], message: `zones cover ${tiles} tiles, map has ${m.size.cols * m.size.rows}` });
  if (m.zones.some(([, i]) => i >= m.zoneLegend.length)) ctx.addIssue({ code: 'custom', path: ['zones'], message: 'zone index outside the legend' });
});
export type MapDef = z.infer<typeof MapDefSchema>;

/** Expand the run-length grid into one legend index per tile, row-major. */
export function decodeZones(m: Pick<MapDef, 'size' | 'zones'>): Uint8Array {
  const out = new Uint8Array(m.size.cols * m.size.rows);
  let i = 0;
  for (const [count, zone] of m.zones) { out.fill(zone, i, i + count); i += count; }
  return out;
}
