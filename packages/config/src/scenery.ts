import { z } from 'zod';

// SceneryDef: the render-only part of a map, which `tools build-maps` writes next to the MapDef
// (base/scenery/<id>.json). The sim never reads it, so scenery cannot change a replay or a hash.
// Units are tiles, as in MapDef.

/**
 * Scenery kinds. Solid kinds stand on `blocked` tiles (the terrain is what stops the horse; the
 * tree only shows why), and the others on ground the horse can ride through.
 */
export const SCENERY_KINDS = ['tree', 'pine', 'bush', 'flowers'] as const;
export type SceneryKind = (typeof SCENERY_KINDS)[number];
export const SOLID_SCENERY: ReadonlySet<SceneryKind> = new Set(['tree', 'pine']);

const nums = z.array(z.number());
const rect = { x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() };

export const SceneryDefSchema = z.object({
  schemaVersion: z.literal(1),
  /** The map this belongs to, and the hash of the same Tiled source, so a stale pair is detectable. */
  map: z.string(),
  source: z.object({ file: z.string(), hash: z.string() }).strict(),
  kindLegend: z.array(z.enum(SCENERY_KINDS)),
  /** Columnar items: kind index into kindLegend, position of the base, and a size factor around 1. */
  items: z.object({ kind: z.array(z.number().int().min(0)), x: nums, y: nums, size: nums }).strict()
    .refine((c) => [c.x, c.y, c.size].every((a) => a.length === c.kind.length), { message: 'item columns differ in length' }),
  /** Plank decks over water, drawn over the open tiles under them. `along` is the way you cross. */
  bridges: z.array(z.object({ ...rect, along: z.enum(['x', 'y']) }).strict()),
}).strict();
export type SceneryDef = z.infer<typeof SceneryDefSchema>;

/** A map with nothing on it, for maps built before scenery or without scenery layers. */
export function emptyScenery(map: { id: string; source: { file: string; hash: string } }): SceneryDef {
  return { schemaVersion: 1, map: map.id, source: map.source, kindLegend: [...SCENERY_KINDS], items: { kind: [], x: [], y: [], size: [] }, bridges: [] };
}
