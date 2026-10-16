import { z } from 'zod';
import { CarTemplateSchema, CellTypeSchema, ItemSchema, LootTableSchema } from './catalogs';

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
  commit: z.object({
    rangeTiles: positive,
    auto: z.boolean(),
    /** Switching the run to another train (Tab) needs it within this distance, nearest car body. */
    switchRangeTiles: positive,
    /** trainSwitch variant group `auto`: during a run, riding closer to another free train in `rangeTiles` moves the run to it. */
    autoSwitch: z.boolean(),
    /** Auto switching needs the other train this much closer than the committed one, so the run does not flip back and forth. */
    autoSwitchMarginTiles: positive,
  }).strict(),
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
    /** Health lost by a crash into a train car at fullImpactTilesPerSec or harder, as a fraction of max (collisionDamage variant group: 0 turns it off). */
    damageFraction: fraction,
    /** The same for a crash into blocked ground (rocks), kept separate so train hits can hurt more. */
    obstacleDamageFraction: fraction,
    /** Health lost by scraping a train car (any touch below minImpactTilesPerSec), as a fraction of max. Blocked ground never scrapes. */
    scrapeDamageFraction: fraction,
    /** Speed lost against a car or blocked ground from which a touch is a crash; below it a car touch is a scrape and a rock touch is free. */
    minImpactTilesPerSec: z.number().min(0),
    /** Impact at and above which a crash costs the full damageFraction; between the two it scales up from the scrape damage. */
    fullImpactTilesPerSec: z.number().min(0),
    /** After a crash, further crashes are free for this long, so one crash costs health once. */
    cooldownSec: z.number().min(0),
  }).strict().refine((c) => c.fullImpactTilesPerSec >= c.minImpactTilesPerSec, { message: 'full impact must not be below min impact', path: ['fullImpactTilesPerSec'] }),
  /** Playtest conveniences that later phases switch off. */
  playtest: z.object({
    /** R ends the run and puts the player on the horse, stopped, behind the train. */
    quickRetry: z.boolean(),
    /** How far behind the train's last car quick retry places the horse. */
    quickRetryGapTiles: positive,
    /** H raises heat by this much (cause `debug`), so the heat meter and drain can be playtested before loot and guards; 0 turns it off. */
    debugHeatStep: z.number().min(0),
  }).strict(),
  world: z.object({ mode: z.enum(['separate', 'continuous']) }).strict(),
  countdown: z.object({
    /** The run's clock (phase 2). Off, a run never expires. */
    enabled: z.boolean(),
    /** U1: the run and countdown start when the player commits to a train. */
    startsAt: z.enum(['commit', 'boarding']),
    /** Multiplies every train's countdown.baseSec: run length is a plain value (U7, G22); the medium-run preset sets 4. */
    scale: positive,
    /** U3: how long expiry waits while the player is already escaping (horse alongside, near a door on its side). */
    graceSec: z.number().min(0),
  }).strict(),
  /** Heat 0 to maxHeat speeds up the countdown (U2). Every gain goes through raiseHeat with one of these sources. */
  heat: z.object({
    maxHeat: positive,
    /** Countdown drain rate is 1 + heatDrainFactor x heat/100. */
    heatDrainFactor: z.number().min(0),
    /** Heat added per event; timeAboardPerSec is added per second aboard instead (0.33 by default since the M1 playtest, G26). */
    sources: z.object({
      shotFired: z.number().min(0),
      alarmRaised: z.number().min(0),
      playerSpotted: z.number().min(0),
      actorKilled: z.number().min(0),
      lootTaken: z.number().min(0),
      timeAboardPerSec: z.number().min(0),
    }).strict(),
    /** Heat from which guards resist boarding once combat exists (G30); null or absent is off. A hook only in phase 2. */
    boardingResistanceAt: z.number().min(0).nullable().optional(),
  }).strict(),
  /** Loot density is each train's loot.density x densityScale (U7); read once loot exists (phase 2 M2). */
  loot: z.object({ densityScale: positive }).strict(),
  trains: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id with dashes'), z.object({
    name: z.string(),
    /** Route id in the map the train runs on. */
    route: z.string(),
    speedTilesPerSec: positive,
    /** Template of the engine at the front. */
    engine: z.string(),
    /** The car type between engine and caboose; run generation picks a layout of that type for each car. */
    carType: z.string(),
    /** How many cars of `carType` (a plain value: the long-train preset sets 6). */
    carCount: z.number().int().min(0),
    /** Only pick from these layouts of `carType` (the doors-both-sides preset); all layouts of the type when absent. */
    layouts: z.array(z.string()).min(1).optional(),
    /** Template of the last car, if any. */
    caboose: z.string().optional(),
    /**
     * After picking layouts, make sure the train can be boarded: `both` swaps in layouts until each
     * side has at least one side door, `one` until any side has one, `off` leaves the picks alone.
     */
    requireSideDoors: z.enum(['both', 'one', 'off']),
    /** At most this many cars get side doors: extra door cars swap to doorless layouts (long trains). */
    maxSideDoorCars: z.number().int().min(0).optional(),
    countdown: z.object({ baseSec: positive }).strict(),
    /** Loot table and the share of each car's eligible loot slots filled (times loot.densityScale, at most all of them). */
    loot: z.object({ table: z.string(), density: fraction }).strict().optional(),
    /** Guards placed on the layouts' guard spawns at commit (at most one per spawn): `base`, plus the wanted level bonus from phase 2 M5. */
    guards: z.object({ base: z.number().int().min(0) }).strict().optional(),
    /** Train verbs the train uses (M2: search). */
    verbs: z.array(z.enum(['search'])),
  }).strict()).refine((t) => Object.keys(t).length > 0, { message: 'at least one train' }),
  /**
   * Which trains run on the map (trainMix variant group). `map` uses the map's own trains, or one
   * `mailTrain` when the map lists none; the other modes take the map's train slots (or
   * `trainCount` slots spread along the mail train's route) and make about `blankShare` of them
   * `blankTrain`, keeping at least one mail train.
   */
  trainMix: z.object({
    mode: z.enum(['map', 'all-mail', 'mixed', 'mostly-blank']),
    mailTrain: z.string(),
    blankTrain: z.string(),
    trainCount: z.number().int().positive(),
    blankShare: fraction,
  }).strict(),
  /** Carrying (lootCarry variant group switches the two flags): a hard limit and a weight slowdown. */
  carry: z.object({
    limitEnabled: z.boolean(),
    slowdownEnabled: z.boolean(),
    /** Weight units; a pickup that would go over is refused while the limit is on. */
    maxWeight: positive,
    /** Items; a pickup that would go over is refused while the limit is on. */
    maxItems: z.number().int().positive(),
    /** Walking slows from this weight, linearly down to minSpeedScale at maxWeight. */
    slowdownFromWeight: z.number().min(0),
    minSpeedScale: z.number().gt(0).max(1),
  }).strict().refine((c) => c.slowdownFromWeight <= c.maxWeight, { message: 'slowdown must start at or below the max', path: ['slowdownFromWeight'] }),
  verbs: z.object({
    /** Hold E on a loot slot for searchTimeSec (or the item's own searchTimeSec) x timeScale to take what is there. */
    search: z.object({
      searchTimeSec: positive,
      /** Holding E on a hidden stash this long (x timeScale) reveals its item, which is then searched like visible loot. */
      hiddenSearchTimeSec: positive,
      /** Scales every search time (the slow-search preset sets 2.5). */
      timeScale: positive,
      /** Walk speed while searching, as a share of normal. */
      walkSpeedScale: fraction,
      /** Moving this far from the slot cancels the search and loses its progress. */
      cancelRangeTiles: positive,
      /** How close to a slot pressing E starts searching it. */
      reachTiles: positive,
      /** Fill loot slots tagged hidden (on by default since the M2 playtest, so a stash can be missed). */
      hiddenLoot: z.boolean(),
    }).strict(),
  }).strict(),
  /** HUD options that presets may set. `showTrainNames: false` hides train names on the off-screen arrows. */
  hud: z.object({ showTrainNames: z.boolean() }).strict(),
  /** Catalogs merged in from cell-types.json, items.json, loot-tables.json and car-templates.json. */
  cellTypes: z.array(CellTypeSchema).min(1),
  items: z.record(ItemSchema),
  lootTables: z.record(LootTableSchema),
  carTemplates: z.record(CarTemplateSchema),
  outcomePolicy: z.object({
    died: z.object({
      bankRunLoot: z.boolean(),
      wantedDelta: z.number().int(),
      bankLossFraction: fraction,
      /** Persistent fields a death wipes (roguelike presets). */
      reset: z.array(z.enum(['wantedLevel', 'bank', 'lifetimeEarned', 'upgrades'])),
    }).strict(),
    cancelled: z.object({ bankRunLoot: z.boolean(), wantedDelta: z.number().int() }).strict(),
    expired: z.object({ bankRunLoot: z.boolean(), wantedDelta: z.number().int() }).strict(),
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
    /** Top speed wading through water, as a fraction of maxSpeed; entering water drops to it at once. */
    waterSpeedScale: z.number().gt(0).max(1),
    turnRateDegPerSec: positive,
    /** steering variant group: direction keys set a screen heading, or A/D turn the horse. */
    steering: z.enum(['screen', 'heading']),
    /** throttleModel variant group: what releasing W does. */
    throttleModel: z.enum(['hold', 'coast', 'cruise']),
    /** handlingModel variant group (`arcade-boost` on, `arcade` off): C gives a short burst above top speed, then a cooldown (G20). */
    boost: z.object({
      enabled: z.boolean(),
      /** How long the burst lasts. */
      durationSec: positive,
      /** Top speed during the burst, as a multiple of maxSpeed (1.4 is +40%). */
      topSpeedScale: z.number().min(1),
      /** Wait after a burst ends before the next. */
      cooldownSec: z.number().min(0),
      /** Extra acceleration toward the raised top speed during the burst, on top of the throttle. */
      accelTilesPerSec2: positive,
    }).strict(),
  }).strict(),
  /** Light guards (phase 2 M3): patrol, sight cone and noise, unaware to suspicious to alert; no combat yet. */
  ai: z.object({
    /** guardCatch variant group: `heat-only` guards only raise heat; `thrown-off` alert guards chase and throw the player off the train. */
    guardCatch: z.enum(['heat-only', 'thrown-off']),
    /** Walking a patrol route, and going back to it or to the post. */
    patrolSpeedTilesPerSec: positive,
    /** Pause at each end of a route that is not a loop. */
    patrolPauseSec: z.number().min(0),
    /** An alert guard's chase under guardCatch `thrown-off` (the player walks at half player.speedTilesPerSec and runs at full). */
    chaseSpeedTilesPerSec: positive,
    /** How fast a guard turns to face where it walks or what it noticed. */
    turnRateDegPerSec: positive,
    /** The sight cone: range, and half its angle (turned into a cosine threshold); cells with blocksSight stop it. */
    sight: z.object({ rangeTiles: positive, coneHalfAngleDeg: z.number().gt(0).max(180) }).strict(),
    /** Footsteps carry this far walking and running, times the noise of the cell the player is on. */
    noise: z.object({ walkRadiusTiles: z.number().min(0), runRadiusTiles: z.number().min(0) }).strict(),
    /** A suspicious guard that keeps seeing the player this long goes alert and raises the alarm. */
    alertAfterSec: z.number().min(0),
    /** A suspicious guard with no sight or sound of the player this long goes back to unaware. */
    calmSec: z.number().min(0),
    /** An alert guard that has not seen or heard the player this long drops back to suspicious. */
    alertCalmSec: z.number().min(0),
    /** An alert, chasing guard this close catches the player (guardCatch `thrown-off`). */
    catchRangeTiles: positive,
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
  /** A preset to build on: its variants and values apply first, and this preset's replace them. */
  extends: id.optional(),
  /** Exactly one variant per group, counting the ones inherited through `extends`. */
  variants: z.record(z.string()),
  /** Plain config values this preset sets, as a partial game.json tree (numbers are values, not variants). */
  values: z.record(z.unknown()).optional(),
}).strict();
export type Preset = z.infer<typeof PresetSchema>;
