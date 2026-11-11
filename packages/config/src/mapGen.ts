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

/** How a stretch of the open line paces the ride: `quiet` rests, `busy` slows you, `big` is a moment. */
export const STRETCH_PACES = ['quiet', 'busy', 'big'] as const;
export type StretchPace = (typeof STRETCH_PACES)[number];

/** Each feature's noise threshold is moved by this much in a stretch: positive gives less of it, negative more. */
const shift = z.number().min(-0.5).max(0.5);
const count = (max: number) => range(z.number().int().min(0).max(max));

/** One kind of stretch of the open line (G10a): what grows there and how it paces the ride. */
export const StretchProfileSchema = z.object({
  /** How often the director picks it, against the other profiles' weights. */
  weight: z.number().min(0),
  pace: z.enum(STRETCH_PACES),
  /** The second word of a stretch's name ("Flats", "Wash"); one is picked per stretch. */
  names: z.array(z.string().min(1)).min(1),
  /** Moves each feature's noise threshold for the stretch (see `shift`), after the line's own settings. */
  shift: z.object({ mud: shift, rocks: shift, forest: shift, lakes: shift, mesas: shift, hills: shift }).strict(),
  /** Rivers that cross the track in the stretch (each on a bridge, as on a loop). */
  rivers: count(4),
  /** Chance of a river running beside the track for most of the stretch, crossable at fords. */
  riverBeside: unit,
  /** Cuts through a long mesa, ridges beside the track and free-standing ridges in the stretch. */
  cuts: count(3),
  besideTrack: count(4),
  ridges: count(6),
  /** Chance of a grade (trains slow) and of a canyon cut with a rim trail in the stretch (G10b set pieces). */
  grade: unit,
  canyon: unit,
}).strict();
export type StretchProfile = z.infer<typeof StretchProfileSchema>;

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
    /**
     * Stretches (G10a): the line is cut into named stretches, each a profile with its own mix of
     * features, so the land changes as you ride. Off: one theme for the whole line (`mix`), as before.
     */
    stretches: z.object({
      enabled: z.boolean(),
      /** Each stretch is this long along the track. */
      lengthTiles: range(z.number().min(100)),
      /** Thresholds blend from one stretch to the next over this many tiles. */
      blendTiles: z.number().min(0).max(300),
      /** The first stretch (where you start) has this pace; empty lets the director pick any. */
      firstPace: z.enum([...STRETCH_PACES, '']),
      /** After a `big` stretch the next one is `quiet`; two `big` ones never meet anyway. */
      quietAfterBig: z.boolean(),
      /** The first word of a stretch's name ("Coyote", "Dead Man's"). */
      namePrefixes: z.array(z.string().min(1)).min(1),
      /** A river beside the track: how far out its middle runs, and the gap between fords along it. */
      riverBesideGapTiles: range(z.number().min(12)),
      riverBesideFordTiles: range(z.number().min(10)),
      /** It is wider than a crossing river, so its deep middle keeps you to the fords. */
      riverBesideWidthTiles: range(z.number().min(2).max(10)),
      profiles: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), StretchProfileSchema).refine((p) => Object.keys(p).length >= 2, { message: 'needs at least two profiles' }),
    }).strict(),
    /**
     * Set pieces (G10b): named moments on the line. A horseshoe bend (the track loops away and back,
     * the horse cuts straight across), a grade (trains slow) and a canyon cut (the lanes close up; a
     * trail along the rim lets you drop onto the roofs). Grades and canyons need stretches; each
     * stretch's profile sets their chances.
     */
    setPieces: z.object({
      enabled: z.boolean(),
      /** The first word of a set piece's name ("Coyote Grade"); the second comes from its kind's `names`. */
      namePrefixes: z.array(z.string().min(1)).min(1),
      /** Set pieces are at least this far apart along the track. */
      gapTiles: z.number().min(0),
      /** And at least this far along the track from a town. */
      townGapTiles: z.number().min(0),
      horseshoe: z.object({
        /** Chance that a piece of line is a horseshoe bend instead (from piece `fromPiece` on). */
        chance: unit,
        fromPiece: z.number().int().min(0),
        /** Horseshoes are at least this far apart along the map. */
        minGapTiles: z.number().min(0),
        /** How far each leg runs straight away from the line before the turn at the top. */
        legTiles: range(z.number().min(0)),
        /** How far the top runs straight between its two turns (0: one round turn). */
        topTiles: range(z.number().min(0)),
        /** Trains run at this share of their speed round the bend. */
        speedScale: z.number().min(0.2).max(1),
        /** The trail straight across the bottom of the bend, kept open for the horse. */
        trailWidthTiles: z.number().min(2).max(30),
        names: z.array(z.string().min(1)).min(1),
      }).strict(),
      grade: z.object({
        lengthTiles: range(z.number().min(40)),
        /** Trains slow to this share of their speed on the grade... */
        speedScale: z.number().min(0.2).max(1),
        /** ...easing down to it and back up over this many tiles at each end. */
        rampTiles: z.number().min(1),
        names: z.array(z.string().min(1)).min(1),
      }).strict(),
      canyon: z.object({
        lengthTiles: range(z.number().min(40)),
        /** The cut's walls stand this far out from the track's centre: too close to ride beside the cars. */
        floorTiles: z.number().min(4).max(12),
        /** The rim trail along the top of one wall, this wide, at this height (view levels). */
        rimWidthTiles: range(z.number().min(3).max(16)),
        rimLevel: z.number().int().min(2).max(8),
        /** The rim trail comes down to the ground over this many tiles past each end of the cut. */
        rampTiles: z.number().min(6),
        /** How thick the walls behind the rim and on the other side are. */
        wallTiles: range(z.number().min(2)),
        names: z.array(z.string().min(1)).min(1),
      }).strict(),
    }).strict(),
    /**
     * Lookouts (G10 boarding plan): named buttes off the track, a flat top `level` high with cliffs
     * all round and a ramp down toward the track, and a cleared trail from the ramp to the lanes.
     * From the top the view opens wide (`hud.lookoutZoomOut`), so you can see trains coming and
     * plan where to meet them. One every `everyTiles` along the track, `offsetTiles` out.
     */
    lookouts: z.object({
      enabled: z.boolean(),
      everyTiles: range(z.number().min(100)),
      /** How far the top's centre is from the track. */
      offsetTiles: range(z.number().min(20)),
      topRadiusTiles: range(z.number().min(4).max(20)),
      level: z.number().int().min(2).max(8),
      rampTiles: z.number().min(6),
      rampWidthTiles: z.number().min(4).max(16),
      names: z.array(z.string().min(1)).min(1),
    }).strict(),
    /** Town spots: a marker and a flat clearing beside the track (towns themselves come in G6). */
    towns: z.object({
      count: range(z.number().int().min(0).max(4)),
      /** Fractions of the way along the line where towns may sit. */
      along: range(unit),
      /** Towns are at least this far apart along the track. */
      minGapTiles: positive,
      clearingRadiusTiles: z.number().min(4).max(60),
      /** Gap between the track's centre line and the clearing's edge. */
      gapTiles: z.number().min(4),
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
