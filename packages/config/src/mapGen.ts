import { z } from 'zod';

// MapGenSettings: the numbers the procedural map generator (packages/mapgen) reads. The defaults
// live in base/map-gen.json; a run changes them with `?set=mapGen.<path>=<value>`, which lands in
// the game config's optional `mapGen` tree (so it is in the log header and the config hash) and is
// merged over the defaults here. Distances are in tiles. Ranges are [min, max].

const positive = z.number().positive();
const unit = z.number().min(0).max(1);
const range = (inner: z.ZodNumber) => z.tuple([inner, inner]).refine(([a, b]) => a <= b, { message: 'range min is above max' });

export const MapGenSchema = z.object({
  schemaVersion: z.literal(1),
  size: z.object({ cols: z.number().int().min(160).max(1200), rows: z.number().int().min(120).max(1200) }).strict(),
  /** Blocked tiles round the map edge. */
  edgeTiles: z.number().int().min(0),
  track: z.object({
    /** Control points the loop is drawn through, evenly round it. */
    controlPoints: z.number().int().min(8).max(200),
    /** The loop bends with harmonics 2 up to a pick in this range: higher gives more, shorter bends. */
    harmonics: range(z.number().int().min(2).max(12)),
    /** 0 is a plain oval; 1 lets the loop pull in up to `maxDent` of the way to the centre. */
    curviness: unit,
    maxDent: z.number().min(0).max(0.8),
    /** Gap between the track and the map edge. */
    marginTiles: positive,
    /** Tightest curve the generator accepts; the map checks need 17. Looser loops are tried until one passes. */
    minRadiusTiles: positive,
  }).strict(),
  corridor: z.object({
    /** No rock, water or mud this close to the centre line (the cars are 3 tiles either side). */
    carClearTiles: positive,
    /** The open riding lane: no obstacles this close on the clear side. */
    laneTiles: positive,
    /** Lengths of the stretches that each keep obstacles on one side (or neither). */
    stretchTiles: range(positive),
    /** Share of stretches with both sides open. */
    bothOpenChance: unit,
    /** Open on both sides for this long where the obstacle side switches. */
    switchGapTiles: positive,
    /** Share of one-sided stretches that lay a mud bank or a broken rock line along their obstacle side. */
    stripChance: unit,
    stripWidthTiles: range(positive),
  }).strict(),
  /** Layered noise: a tile gets the feature where the noise (0 to 1) is above `threshold`. */
  mud: z.object({ scaleTiles: positive, threshold: unit }).strict(),
  rocks: z.object({ scaleTiles: positive, threshold: unit }).strict(),
  forest: z.object({ scaleTiles: positive, threshold: unit, treesPerTile: positive, pineShare: unit }).strict(),
  lakes: z.object({ scaleTiles: positive, threshold: unit, deepThreshold: unit, trackGapTiles: positive }).strict(),
  rivers: z.object({
    count: range(z.number().int().min(0).max(6)),
    widthTiles: range(z.number().min(2).max(14)),
    /** Length of each arm, either side of the bridge. */
    lengthTiles: range(positive),
    /** How hard the river bends (radians per tile at most). */
    meander: z.number().min(0).max(0.3),
    /** Straight run either side of the bridge, so the crossing is square. */
    straightTiles: positive,
    trackGapTiles: positive,
    /** Bridges this far apart along the track at least. */
    spacingTiles: positive,
  }).strict(),
  hills: z.object({ scaleTiles: positive, threshold: unit, maxLevel: z.number().int().min(0).max(8), trackGapTiles: positive, tilesPerLevel: positive }).strict(),
  ground: z.object({ bushesPerTile: z.number().min(0), flowersPerTile: z.number().min(0), scaleTiles: positive }).strict(),
  /** How far from the track the player starts, on the open side. */
  spawnDistanceTiles: positive,
}).strict();
export type MapGenSettings = z.infer<typeof MapGenSchema>;

/** Thrown when the merged settings are invalid; `path` names the bad value under `mapGen`. */
export class MapGenError extends Error {
  constructor(readonly path: string, detail: string) { super(`mapGen.${path}: ${detail}`); this.name = 'MapGenError'; }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function mergeTree(base: unknown, over: unknown): unknown {
  if (!isObject(over) || !isObject(base)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? mergeTree(out[k], v) : v;
  return out;
}

/** The defaults file with a run's `mapGen` overrides on top, validated. */
export function resolveMapGen(defaults: unknown, overrides?: Readonly<Record<string, unknown>>): MapGenSettings {
  const r = MapGenSchema.safeParse(overrides ? mergeTree(defaults, overrides) : defaults);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  throw new MapGenError(issue.path.join('.') || '(root)', issue.message);
}
