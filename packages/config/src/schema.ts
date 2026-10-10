import { z } from 'zod';

// Keys carry their unit in the name (Sec, Tiles, PerSec, Deg). The resolve step
// derives tick-based values from those suffixes; see derive.ts.

const positive = z.number().positive();
const fraction = z.number().min(0).max(1);

export const GameSchema = z.object({
  schemaVersion: z.literal(1),
  sim: z.object({ tickRateHz: z.number().int().positive() }).strict(),
  logging: z.object({
    hashEverySec: positive,
    /** Event allowlist for the events log. */
    events: z.array(z.string()),
  }).strict(),
  player: z.object({ speedTilesPerSec: positive }).strict(),
  commit: z.object({ rangeTiles: positive }).strict(),
  boarding: z.object({
    rangeTiles: positive,
    speedToleranceTilesPerSec: positive,
    meter: z.object({
      /** One full back and forth while in range but not speed matched: fast, so a mismatched jump is a long shot. */
      sweepPeriodSec: positive,
      /** One full back and forth while in range and speed matched: slower, the intended way on. */
      matchedSweepPeriodSec: positive,
      /** Perfect and good zone widths as fractions of the meter track. */
      zoneWidths: z.tuple([fraction, fraction]),
    }).strict().refine((m) => m.zoneWidths[0] <= m.zoneWidths[1], { message: 'perfect zone must not be wider than good zone', path: ['zoneWidths'] }),
    failure: z.object({
      stunSec: z.number().min(0),
      damageFraction: fraction,
      /** The horse's speed is scaled by this when a jump fails, and held there during the stun. */
      horseSpeedScale: fraction,
    }).strict(),
    /** A good landing stumbles: walk speed is scaled for a moment after boarding. */
    landing: z.object({ stumbleSec: z.number().min(0), stumbleSpeedScale: fraction }).strict(),
  }).strict(),
  health: z.object({ max: positive }).strict(),
  /** Running into a train or blocked ground on a run (water and the map edge never hurt). */
  collision: z.object({
    /** Health lost per crash, as a fraction of max (collisionDamage variant group: 0 turns it off). */
    damageFraction: fraction,
    /** The speed the horse must lose against the obstacle for it to hurt, so brushing a car while matching its speed is free. */
    minImpactTilesPerSec: z.number().min(0),
    /** After a crash, further crashes are free for this long, so one crash costs health once. */
    cooldownSec: z.number().min(0),
  }).strict(),
  /** Playtest conveniences that later phases switch off. */
  playtest: z.object({
    /** R ends the run and puts the player on the horse, stopped, behind the train. */
    quickRetry: z.boolean(),
    /** How far behind the train's last car quick retry places the horse. */
    quickRetryGapTiles: positive,
  }).strict(),
  world: z.object({ mode: z.enum(['separate', 'continuous']) }).strict(),
  countdown: z.object({
    /** Off until phase 2 brings the countdown and heat. */
    enabled: z.boolean(),
    /** U1: the run and countdown start when the player commits to a train. */
    startsAt: z.enum(['commit', 'boarding']),
    /** Multiplies every train's countdown.baseSec (runLength variants). */
    scale: positive,
  }).strict(),
  trains: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id with dashes'), z.object({
    name: z.string(),
    /** Route id in the map the train runs on. */
    route: z.string(),
    speedTilesPerSec: positive,
    cars: z.array(z.object({ template: z.string(), count: z.number().int().positive().optional() }).strict()).min(1),
  }).strict()).refine((t) => Object.keys(t).length > 0, { message: 'at least one train' }),
  outcomePolicy: z.object({
    died: z.object({
      bankRunLoot: z.boolean(),
      wantedDelta: z.number().int(),
      bankLossFraction: fraction,
      /** Persistent fields a death wipes (roguelike presets). */
      reset: z.array(z.enum(['wantedLevel', 'bank', 'lifetimeEarned', 'upgrades'])),
    }).strict(),
    cancelled: z.object({ bankRunLoot: z.boolean(), wantedDelta: z.number().int() }).strict(),
  }).strict(),
  horse: z.object({
    /** Tiles per second. */
    maxSpeed: positive,
    /** Tiles per second squared, as are the rates below. */
    accel: positive,
    brake: positive,
    /** Slowdown with the throttle released, under the coast throttle model. */
    dragTilesPerSec2: positive,
    /** How fast W and S move the target speed under the cruise throttle model. */
    cruiseTargetRateTilesPerSec2: positive,
    /** Top speed on slow ground, as a fraction of maxSpeed. */
    slowZoneSpeedScale: z.number().gt(0).max(1),
    turnRateDegPerSec: positive,
    /** steering variant group: direction keys set a screen heading, or A/D turn the horse. */
    steering: z.enum(['screen', 'heading']),
    /** throttleModel variant group: what releasing W does. */
    throttleModel: z.enum(['hold', 'coast', 'cruise']),
  }).strict(),
}).strict();
export type Game = z.infer<typeof GameSchema>;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id with dashes');

export const VariantSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  group: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'camelCase group name'),
  label: z.string(),
  question: z.string(),
  patch: z.record(z.unknown()),
}).strict();
export type Variant = z.infer<typeof VariantSchema>;

export const PresetSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  /** Exactly one variant per group. */
  variants: z.record(z.string()),
}).strict();
export type Preset = z.infer<typeof PresetSchema>;
