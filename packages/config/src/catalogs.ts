import { z } from 'zod';

// The shared catalogs next to game.json: cell types, items, loot tables and the car templates
// `tools build-cars` writes. Each file is checked on its own, then merged into the config under
// the key of the same name, so the sim reads them like any other value and the config hash
// covers them (a changed car layout shows up as a config change in replays).

const positive = z.number().positive();
const fraction = z.number().min(0).max(1);
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id with dashes');
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour as #rrggbb');

/**
 * One cell type: each field feeds one system. `blocksMove` feeds movement, `blocksSight` and
 * `shootThrough` perception and combat, `cover` the share of ranged damage absorbed (0 to 1), and
 * `noise` the footstep multiplier (unused until guards listen in M3). `colour` is placeholder art
 * for the Tiled tileset and the renderer.
 */
export const CellTypeSchema = z.object({
  id: idSchema,
  blocksMove: z.boolean(),
  blocksSight: z.boolean(),
  cover: fraction,
  noise: z.number().min(0).optional(),
  opensOnInteract: z.boolean().optional(),
  shootThrough: z.boolean().optional(),
  colour,
}).strict();
export type CellType = z.infer<typeof CellTypeSchema>;

export const CellTypesFileSchema = z.object({
  schemaVersion: z.literal(1),
  cellTypes: z.array(CellTypeSchema).min(1),
}).strict().superRefine((f, ctx) => {
  const ids = f.cellTypes.map((c) => c.id);
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) ctx.addIssue({ code: 'custom', path: ['cellTypes', i, 'id'], message: `duplicate cell type ${id}` }); });
});

export const ItemSchema = z.object({
  name: z.string(),
  value: z.number().min(0),
  weight: positive,
  category: z.string(),
  /** Loot slot tags this item can be placed on (a slot's `hidden` tag is not one of these). */
  slotTags: z.array(z.string()).min(1),
}).strict();
export type Item = z.infer<typeof ItemSchema>;

export const ItemsFileSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.record(idSchema, ItemSchema),
}).strict();

const weighted = z.object({ item: z.string(), weight: positive }).strict();

/**
 * A weighted table. Run generation fills each picked slot with an item from `items` that fits
 * the slot's tags, then places `prizes.count` (an inclusive [min, max] range per train) prizes on
 * slots that fit them, before the small items.
 */
export const LootTableSchema = z.object({
  items: z.array(weighted).min(1),
  prizes: z.object({
    count: z.tuple([z.number().int().min(0), z.number().int().min(0)]).refine((c) => c[0] <= c[1], { message: 'min above max' }),
    items: z.array(weighted).min(1),
  }).strict().optional(),
}).strict();
export type LootTable = z.infer<typeof LootTableSchema>;

export const LootTablesFileSchema = z.object({
  schemaVersion: z.literal(1),
  lootTables: z.record(idSchema, LootTableSchema),
}).strict();

const cell = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
export const ENTRY_SIDES = ['left', 'right', 'front', 'rear'] as const;
export const FACINGS = ['left', 'right', 'up', 'down'] as const;

/**
 * A car layout as `tools build-cars` writes it from a Tiled file. Cells are [col, row]: col 0 at
 * the car's front, row 0 on its left side. `cells` is a row-major run-length encoding of indices
 * into `legend`, which names catalog cell types, so reordering the catalog never breaks a car.
 */
export const CarTemplateSchema = z.object({
  carType: idSchema,
  size: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }).strict(),
  legend: z.array(z.string()).min(1),
  cells: z.array(z.tuple([z.number().int().positive(), z.number().int().min(0)])),
  entryPoints: z.array(z.object({ id: z.string(), side: z.enum(ENTRY_SIDES), cell }).strict()),
  lootSlots: z.array(z.object({ cell, tags: z.array(z.string()) }).strict()),
  guardSpawns: z.array(z.object({ cell, facing: z.enum(FACINGS), patrol: z.string().optional() }).strict()),
  patrols: z.record(z.array(cell)),
  /** Entry point ids that lead to the roof (phase 3). */
  roofAccess: z.array(z.string()),
  /** Marked in Tiled as a deliberate one-cell corridor, which build-cars otherwise refuses. */
  corridor: z.boolean(),
  /** Hash of the Tiled source and tileset, so a stale build is detectable. */
  source: z.object({ file: z.string(), hash: z.string() }).strict(),
}).strict().superRefine((t, ctx) => {
  const n = t.cells.reduce((s, [count]) => s + count, 0);
  if (n !== t.size.cols * t.size.rows) ctx.addIssue({ code: 'custom', path: ['cells'], message: `cells cover ${n}, car has ${t.size.cols * t.size.rows}` });
  if (t.cells.some(([, i]) => i >= t.legend.length)) ctx.addIssue({ code: 'custom', path: ['cells'], message: 'cell index outside the legend' });
});
export type CarTemplateDef = z.infer<typeof CarTemplateSchema>;

export const CarTemplatesFileSchema = z.object({
  schemaVersion: z.literal(1),
  generatedBy: z.string(),
  cars: z.record(idSchema, CarTemplateSchema),
}).strict();

/** Expand a template's run-length cells into one legend index per cell, row-major. */
export function decodeCells(t: Pick<CarTemplateDef, 'size' | 'cells'>): Uint8Array {
  const out = new Uint8Array(t.size.cols * t.size.rows);
  let i = 0;
  for (const [count, v] of t.cells) { out.fill(v, i, i + count); i += count; }
  return out;
}
