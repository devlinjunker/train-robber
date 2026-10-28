import { z } from 'zod';

// MapGenSettings: the numbers the procedural map generator (packages/mapgen) reads. The defaults
// live in base/map-gen.json; a run changes them with `?set=mapGen.<path>=<value>`, which lands in
// the game config's optional `mapGen` tree (so it is in the log header and the config hash) and is
// merged over the defaults here. Distances are in tiles. Ranges are [min, max].

const positive = z.number().positive();
const unit = z.number().min(0).max(1);
const range = (inner: z.ZodNumber) => z.tuple([inner, inner]).refine(([a, b]) => a <= b, { message: 'range min is above max' });

/** What a generated map is full of; `balanced` favours nothing. */
export const MAP_THEMES = ['balanced', 'forest', 'rocks', 'mesas', 'water', 'mud'] as const;
export type MapTheme = (typeof MAP_THEMES)[number];

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
    maxDent: z.number().min(0).max(0.95),
    /** Gap between the track and the map edge. */
    marginTiles: positive,
    /** Tightest curve the generator accepts; the map checks need 17. Looser loops are tried until one passes. */
    minRadiusTiles: positive,
    /** Two parts of the loop never come closer than this (the inside of a deep bend). */
    selfGapTiles: positive,
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
    /** A ford (shallow water across the river, so it can be waded) every so often along each arm, this wide along the river. */
    fordSpacingTiles: range(positive),
    fordWidthTiles: positive,
  }).strict(),
  /** Sandstone mesas: flat-topped rock rising by a cliff all round, where the noise is above `threshold`. */
  mesas: z.object({
    /** Clumps: where the noise at this scale is above `threshold`, at least trackGapTiles from the track. */
    scaleTiles: positive, threshold: unit, trackGapTiles: positive,
    /** Free-standing long thin ridges per map, and how long and wide. */
    ridges: range(z.number().int().min(0).max(12)),
    ridgeLengthTiles: range(positive),
    ridgeWidthTiles: range(positive),
    /** Ridges that run beside the track (same length and width), this far out from the centre line. */
    besideTrack: range(z.number().int().min(0).max(8)),
    besideGapTiles: range(positive),
    /** Cuts: stretches where the track runs through a long mesa, its cliff walls cutGapTiles out each side. */
    cuts: range(z.number().int().min(0).max(4)),
    cutLengthTiles: range(positive),
    cutDepthTiles: range(positive),
    /** Keep it beyond the riding lane and the 6 flat tiles the cars need. */
    cutGapTiles: z.number().min(7),
    /** Top heights; keep the lowest at least 2 above hills.maxLevel so every edge is a cliff. */
    topLevels: range(z.number().int().min(2).max(8)),
  }).strict(),
  /**
   * Each map picks a theme and a busyness, so maps differ in what they are full of. The theme's
   * feature gets its noise threshold lowered by `boost` (more of it; water also gets one more
   * river, mesas one more ridge) and the other features theirs raised by `damp`. Busyness, picked
   * in its range, lowers every threshold (busier) or raises them (emptier).
   */
  mix: z.object({
    themes: z.array(z.enum(MAP_THEMES)).min(1),
    boost: z.number().min(0).max(0.5),
    damp: z.number().min(0).max(0.5),
    busyness: range(z.number().min(-0.3).max(0.3)),
  }).strict(),
  hills: z.object({ scaleTiles: positive, threshold: unit, maxLevel: z.number().int().min(0).max(8), trackGapTiles: positive, tilesPerLevel: positive }).strict(),
  ground: z.object({ bushesPerTile: z.number().min(0), flowersPerTile: z.number().min(0), scaleTiles: positive }).strict(),
  /** How far from the track the player starts, on the open side. */
  spawnDistanceTiles: positive,
  /**
   * The open line (`?map=line`, G3): one railway across a long map instead of a loop, built piece by
   * piece so the same code can keep growing it. The terrain rules above apply along it unchanged.
   */
  line: z.object({
    /** Map length along the line's overall direction (east), and its width. */
    lengthTiles: z.number().int().min(600).max(20000),
    widthTiles: z.number().int().min(200).max(1200),
    /** The track starts this far off the west edge and runs this far past the east edge, so trains enter and leave off the map. */
    leadInTiles: positive,
    /** Each piece of track is this long. */
    pieceTiles: range(z.number().min(40)),
    /** Control points this far apart along a piece. */
    stepTiles: z.number().min(4).max(60),
    /**
     * The heading never strays further than this from east. Past 90 the line can run north or
     * south and a little back west, steering east before it comes within selfGapTiles of itself.
     */
    maxHeadingDeg: z.number().min(0).max(120),
    /** Track laid earlier stays at least about this far from the line ahead (only matters past 90 degrees). */
    selfGapTiles: z.number().min(10),
    /** `east` runs the line west to east; `west` mirrors the whole map, so trains run right to left. */
    direction: z.enum(['east', 'west']),
    /** 0 is a straight line; 1 lets each piece pick any heading up to maxHeadingDeg. */
    curviness: unit,
    /** Share of pieces that swing out and back (an S-bend) on top of their turn, and how far. */
    swingChance: unit,
    swingDeg: z.number().min(0).max(90),
    /** Each piece makes its turn over this share of its length, then runs straight. */
    bendShare: range(z.number().min(0.05).max(1)),
    /** How hard a piece steers back toward the middle of the map, 0 to 1. */
    centrePull: unit,
    /** The track stays about this far from the top and bottom edges. */
    marginTiles: positive,
    /** Turns are limited so no curve is tighter than this; the map checks need 17. */
    minRadiusTiles: positive,
    /**
     * Rivers, cuts and ridges beside the track scale with track length: the loop's counts are per
     * this many tiles of track. Free-standing ridges and noise scale with the map's area instead.
     */
    featureTilesPerLoop: positive,
    /** A new train enters at the start of the line once the last one is about this far in. */
    trainHeadwayTiles: z.number().min(100),
    /** Each gap between trains is trainHeadwayTiles plus or minus up to this much, seeded per train. */
    trainHeadwaySpreadTiles: z.number().min(0),
    /** The player starts beside the track between these fractions of the way along it. */
    spawnAlong: range(unit),
    /** Towns: a marker and a flat clearing beside the track, with a name, a size and buildings (G6). */
    towns: z.object({
      count: range(z.number().int().min(0).max(4)),
      /** Fractions of the way along the line where towns may sit. */
      along: range(unit),
      /** Towns are at least this far apart along the track. */
      minGapTiles: positive,
      clearingRadiusTiles: z.number().min(4).max(60),
      /** Gap between the track's centre line and the clearing's edge. */
      gapTiles: z.number().min(4),
      /** How often each size comes up (G6); a size's buildings fit the clearing. */
      sizeWeights: z.object({ halt: z.number().min(0), village: z.number().min(0), town: z.number().min(0) }).strict()
        .refine((w) => w.halt + w.village + w.town > 0, 'one size needs a weight above 0'),
      /** Add a town off each end of the line, where trains set out from and arrive (G6). */
      endTowns: z.boolean(),
    }).strict(),
  }).strict(),
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
