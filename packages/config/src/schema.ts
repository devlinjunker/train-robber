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
  player: z.object({
    speedTilesPerSec: positive,
    /** Crouching aboard (C): the one speed you creep at, as a share of speedTilesPerSec (running; walking is half), whatever the move axes say. */
    crouch: z.object({ speedScale: z.number().gt(0).max(1) }).strict(),
  }).strict(),
  commit: z.object({
    /** A free train this close (nearest car body) brings up the commit prompt, and E commits. */
    rangeTiles: positive,
    /** Staying in range of the same train this long commits with no key (the prompt shows a filling bar). Missing or null (`?set=commit.timerSec=null`): only E commits; 0: at once. */
    timerSec: z.number().min(0).nullable().optional(),
    /** Riding this close to the prompted train commits at once. Missing or null: off. */
    closeRangeTiles: positive.nullable().optional(),
    /** During a run that can still switch, another free train in `rangeTiles` gets the same prompt (Tab, timer, close range) to switch to it. */
    promptSwitch: z.boolean(),
    /** The switch prompt's timer, like `timerSec` for committing. Missing or null: only Tab and the close range switch. */
    switchTimerSec: z.number().min(0).nullable().optional(),
    /** Esc while still on the horse ends the run where you are instead of back at the spawn. */
    cancelInPlace: z.boolean(),
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
    /**
     * A good landing stumbles: walk speed is scaled for a moment after boarding, and the player
     * staggers `goodStumbleInTiles` in from the door, out in the open. A perfect landing stays in the doorway.
     */
    landing: z.object({ stumbleSec: z.number().min(0), stumbleSpeedScale: fraction, goodStumbleInTiles: z.number().min(0) }).strict(),
  }).strict(),
  health: z.object({
    max: positive,
    /**
     * `day` (Devlin, 2026-10-28): one health bar for the whole day; committing doesn't refill it and
     * dying ends the day, starting the next at full health back at the spawn. `run`: refilled at every commit.
     */
    scope: z.enum(['day', 'run']),
  }).strict(),
  /** Running into a train or blocked ground (water and the map edge never hurt). */
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
    /**
     * Off a run with `health.scope: day` (Devlin, 2026-10-28): a crash only hurts from this impact,
     * then costs what the same crash would on a run; slower touches and scrapes are free.
     */
    offRunMinImpactTilesPerSec: z.number().min(0),
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
    /**
     * Test setup for being seen from outside (Devlin, PR #36 playtest): the first guard stands on the
     * left ledge of its car and the second on that car's rear platform, both on watch. Preset `roof-edge-test`.
     */
    edgeGuards: z.boolean(),
  }).strict(),
  world: z.object({ mode: z.enum(['separate', 'continuous']) }).strict(),
  /** The whistle, the riderless horse and the mount jump (U4; phase 2 M4). */
  extraction: z.object({
    /** Arrival delay [min, max] drawn from the horse stream at each whistle; it sets how far behind the last car the horse starts. */
    arrivalDelaySec: z.tuple([z.number().min(0), z.number().min(0)]).refine(([a, b]) => a <= b, { message: 'min must not be above max' }),
    /** How long the horse paces alongside before it drops back. */
    paceWindowSec: positive,
    /** After the pace window, how long before a whistle works again. */
    rewhistleCooldownSec: z.number().min(0),
    /** The lane the horse rides in, tiles out from the car's side. */
    laneOffsetTiles: positive,
    /** How long the horse drops back after the pace window before it leaves the world. */
    dropBackSec: z.number().min(0),
    /** The horse has arrived when it is this close to its lane point beside the player's car. */
    alongsideRangeTiles: positive,
    /** A mount jump needs the horse this close to the door the player stands at. */
    mountRangeTiles: positive,
    /** The player must be this close to a side door on the horse's side to mount (and for the grace window, G18). */
    doorReachTiles: positive,
    /** The mount meter: one back and forth, and perfect and good zone widths (G24: 3% and 15% at 1.85 s). */
    meter: z.object({
      sweepPeriodSec: positive,
      zoneWidths: z.tuple([fraction, fraction]),
    }).strict().refine((m) => m.zoneWidths[0] <= m.zoneWidths[1], { message: 'perfect zone must not be wider than good zone', path: ['zoneWidths'] }),
    /** mountSpill variant group (G15): what a good mount spills. */
    mountSpill: z.enum(['random', 'heaviest', 'share']),
    /** Under `share`, the share of carried value a good mount loses. */
    spillShare: fraction,
    /** Cell size of the coarse grid the horse paths around blocked and water tiles on. */
    pathCellTiles: z.number().int().positive(),
    /** No progress toward the player's car for this long and the HUD says the horse is blocked. */
    stuckSec: positive,
    /** Farther than this from the player's car (off screen at the run zoom), the riderless horse passes through rocks and water so it cannot get stuck; 0 turns that off. */
    passThroughBeyondTiles: z.number().min(0),
    /** A good mount stuns the horse this long (no steering, speed held), as a failed boarding jump does. */
    goodMountStunSec: z.number().min(0),
  }).strict(),
  /**
   * Overrides for the procedural map generator (`?map=gen`), merged over base/map-gen.json and checked
   * by MapGenSchema when a map is generated. Absent unless a run sets one, so other runs keep their hash.
   */
  mapGen: z.record(z.unknown()).optional(),
  countdown: z.object({
    /** The run's clock (phase 2). Off, a run never expires. */
    enabled: z.boolean(),
    /** U1: the run and countdown start when the player commits to a train. */
    startsAt: z.enum(['commit', 'boarding']),
    /** Multiplies every train's countdown.baseSec: run length is a plain value (U7, G22); the medium-run preset sets 4. */
    scale: positive,
    /** U3: how long expiry waits while the player is already escaping (horse alongside, near a door on its side). */
    graceSec: z.number().min(0),
    /**
     * Open lines only: `town` (the default) makes the clock the committed train's time to reach the
     * next town (or the end of the line), and heat no longer speeds it up; `fixed` keeps the
     * train's baseSec clock that heat drains, as on loops (Devlin, PR #34).
     */
    lineClock: z.enum(['town', 'fixed']).optional(),
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
    /** Guards at wanted level 0: `base` plus `perCar` for each car with guard spawns, rounded (Devlin 2026-10-17: about 2 per 3 cars to start). */
    guards: z.object({
      base: z.number().int().min(0).optional(),
      perCar: z.number().min(0).optional(),
      /** Extra guards on this train per wanted level, rounded, on top of `wanted.guardBonus` (phase 2 M5). */
      perWantedLevel: z.number().min(0).optional(),
    }).strict().optional(),
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
  /** `lootTotalSec`: how long the loot total shows in the top right after you get off the train with loot (Devlin, PR #36). */
  hud: z.object({ showTrainNames: z.boolean(), lootTotalSec: z.number().min(0) }).strict(),
  /**
   * Placeholder sound levels (client only; U still mutes). Volumes scale each sound's normal level
   * (1 = as before, 0 = silent); `tickVolume` multiplies `volume` for the countdown ticks. The
   * countdown ticks every `tickEverySec` countdown seconds, then every `finalTickEverySec` in the
   * last `finalCountdownSec` (Devlin, 2026-10-19). Any of the three at 0 turns that part off.
   */
  audio: z.object({
    volume: z.number().min(0),
    tickVolume: z.number().min(0),
    tickEverySec: z.number().min(0),
    finalCountdownSec: z.number().min(0),
    finalTickEverySec: z.number().min(0),
  }).strict(),
  /** Catalogs merged in from cell-types.json, items.json, loot-tables.json and car-templates.json. */
  cellTypes: z.array(CellTypeSchema).min(1),
  items: z.record(ItemSchema),
  lootTables: z.record(LootTableSchema),
  carTemplates: z.record(CarTemplateSchema),
  /**
   * Wanted level (phase 2 M5, U11): 0 to `maxLevel`, read only when a run is generated. Each level
   * adds `guardBonus[level]` guards to every train (the last entry covers higher levels), plus the
   * train's `guards.perWantedLevel` x level. `forceLevel` (preset or `?wanted=`) sets the level a run
   * uses; such runs are practice and save nothing (G8, G9). Null or absent: the saved level.
   */
  wanted: z.object({
    maxLevel: z.number().int().min(0),
    guardBonus: z.array(z.number().int().min(0)).min(1),
    forceLevel: z.number().int().min(0).nullable().optional(),
    /** Wanted levels each guard throw-off adds at the end of the run, whatever the outcome (Devlin, PR #46 playtest). */
    perThrowOff: z.number().int().min(0),
  }).strict().refine((w) => w.forceLevel == null || w.forceLevel <= w.maxLevel, { message: 'forceLevel must not be above maxLevel', path: ['forceLevel'] }),
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
    extracted: z.object({ bankRunLoot: z.boolean(), wantedDelta: z.number().int() }).strict(),
    /** F on the horse mid-run (Devlin, 2026-10-19). */
    cashedOut: z.object({ bankRunLoot: z.boolean(), wantedDelta: z.number().int() }).strict(),
    /** A guard threw you off and the doors shut behind you (Devlin, PR #46 playtest): the run ends there. The throw's own wanted level is `wanted.perThrowOff`. */
    caught: z.object({ bankRunLoot: z.boolean(), wantedDelta: z.number().int() }).strict(),
  }).strict(),
  /**
   * F on the horse during a run (after a guard throws you off) ends the run and banks what you
   * carry (Devlin, 2026-10-19). Doors: with `closeDoors` a cash-out shuts that train's doors, and
   * with `closeDoorsOnThrownOff` being thrown off by a guard does (Devlin, 2026-10-20), so you
   * cannot board it again: cash out or Tab to another train. A shut train cannot be boarded,
   * committed or switched to for `doorsReopenSec` (0: for the rest of the session).
   */
  cashOut: z.object({ enabled: z.boolean(), closeDoors: z.boolean(), closeDoorsOnThrownOff: z.boolean(),
    /** A guard throw that shuts the doors ends the run `caught` (Devlin, PR #46 playtest). Off for later, when outside ladders give a way back on. */
    shutDoorsEndRun: z.boolean(), doorsReopenSec: z.number().min(0) }).strict(),
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
    /** After boarding, the riderless horse runs off for this long and then leaves the world (U4). */
    runOffSec: z.number().min(0),
    /** handlingModel variant group (`arcade-boost` on, `arcade` off): Shift gives a short burst above top speed, then a cooldown (G20). */
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
  /**
   * Outside the cars (sneaking PR 2): end platforms, the coupling between them and side ledges.
   * Sizes may be fractions of a tile: the grid gives each a whole number of cells and cuts the
   * outermost short, so the train's spacing in the world is exact.
   */
  outside: z.object({
    /** Side ledges are walkable (off: they are still drawn, but blocked). */
    ledges: z.boolean(),
    /** Depth of the platform at each end of every car; with the coupling gap this spaces the cars apart. */
    platformDepthTiles: z.number().min(0).max(8),
    /** Open gap between two cars' platforms, crossed on the coupling plate. */
    couplingGapTiles: z.number().min(0).max(8),
    /** Width of the coupling plate across the gap, centred on the car (end doors are rows 2-4 of 7). */
    gangwayWidthTiles: z.number().int().min(0),
    /** Width of the ledge outside each long wall (any width over 0: on a ledge you press flat against the wall). */
    ledgeWidthTiles: z.number().min(0).max(4),
    /** Open doorways (end and side doors) do not block sight, so a guard sees out onto a platform or the ledge by a door, and through the end doors along the train. */
    seeThroughDoorways: z.boolean(),
    /** Top speed on a platform or the coupling plate (inside: 4 walking, 8 running). */
    platformSpeedTilesPerSec: positive,
    /** Top speed shimmying along a ledge. */
    ledgeSpeedTilesPerSec: positive,
    /** How far footsteps carry on a platform and on a ledge, as a multiple (floor is 1). */
    platformNoise: z.number().min(0),
    /** Moving on a ledge, at any pace: how far it carries, through the wall (Devlin, 2026-10-21: a guard just the other side hears you). */
    ledgeNoiseRadiusTiles: z.number().min(0),
    /** Trackside rocks: blocked ground this far outward of a player on a ledge scrapes them (collision scrape damage); under them, knocks them off when `knockOff` is on, shutting the train's doors only with `closeDoors`. */
    scrape: z.object({ glanceTiles: z.number().min(0), knockOff: z.boolean(), closeDoors: z.boolean() }).strict(),
    /** Walking on the roofs (sneaking PR 3). */
    roof: z.object({
      /** Ladders and roofs are there to use (off: no ladders, so no one gets up). */
      enabled: z.boolean(),
      /** Which end platforms of a car with ladders have one. */
      ladderEnds: z.enum(['both', 'front', 'rear']),
      /** The share of a train's cars that have ladders (at least one car); which ones is fixed by the train's car list (Devlin, PR #36: 2 of 3). */
      ladderCarShare: z.number().gt(0).max(1),
      /** The row across the car the ladder stands at (0 is the left side; end doors are rows 2-4 of 7). */
      ladderRow: z.number().int().min(0),
      /** E climbs within this distance of a ladder's foot (on the platform) or its top (on the roof). */
      ladderReachTiles: positive,
      /** How long a climb up or down takes, for the player and for guards. */
      climbSec: z.number().min(0),
      /** Top speed on a roof, running; walking is half, crouched is this times player.crouch.speedScale (inside: 8 running). */
      speedTilesPerSec: positive,
      /** Footsteps on a roof carry this far to a guard in the car below or on a roof: walking, running, crouched; and the thud of a jump's landing for landSec. */
      noise: z.object({ walkRadiusTiles: z.number().min(0), runRadiusTiles: z.number().min(0), crouchRadiusTiles: z.number().min(0), landRadiusTiles: z.number().min(0), landSec: z.number().min(0) }).strict(),
      /** A guard out on a platform, the coupling or a ledge sees you on a roof within this far of the edge over them (inside, never). */
      edgeSeenTiles: z.number().min(0),
      /** The same, crouched. */
      crouchEdgeSeenTiles: z.number().min(0),
      /** How far a guard up on a roof sees along the roofs (Devlin, PR #36: the whole car). */
      guardSightTiles: positive,
      /** Guards who heard or saw you up there climb up after you (off: they stand below and look up). */
      guardsClimb: z.boolean(),
      /**
       * Guards on a roof run and jump the gap to follow you to the next car's roof, landing short on the
       * platform this share of the time; they also climb a neighbour's ladder to reach a roof without one,
       * and drop off a roof end when their car has no ladder down (Devlin, PR #36 playtest, 2026-10-28).
       */
      guardJump: z.object({ enabled: z.boolean(), shortShare: z.number().min(0).max(1) }).strict(),
      /** A drop off a roof onto the platform or coupling (a short jump, or walking off the end) staggers you this long; it is loud, like the landing stumble. */
      dropStumbleSec: z.number().min(0),
      /** Space on a roof: you fly airSec at your speed, plus pushTiles; a running jump clears a gap only from near the edge. */
      jump: z.object({ airSec: positive, pushTiles: z.number().min(0), /** How high the player is drawn at the top of a jump (view only). */ liftTiles: z.number().min(0) }).strict(),
      /** Falling off a roof (a bad jump or a slip) brings the guards in the car you fell from and `cars` cars either side to check, for at least checkSec. */
      fallAlert: z.object({ enabled: z.boolean(), cars: z.number().int().min(0), checkSec: z.number().min(0) }).strict(),
      /**
       * Slipping on curves: the curve's pull (train speed² x curvature) times your share of top roof
       * speed at thresholdTilesPerSec2 or more starts a slip; you slide outward at slideTilesPerSec
       * until you push the other way for leanSec; then no slip for cooldownSec.
       */
      slip: z.object({
        enabled: z.boolean(), thresholdTilesPerSec2: z.number().min(0), slideTilesPerSec: z.number().min(0), leanSec: z.number().min(0), cooldownSec: z.number().min(0),
        /** Guards on a roof slip too (Devlin, PR #36 playtest): the same pull test at their pace, sliding outward for guardCatchSec before they catch themselves; they never fall. */
        guards: z.boolean(), guardCatchSec: z.number().min(0),
      }).strict(),
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
    /** `crouchCoverMin`: a cell with at least this `cover` between a guard and a crouched player blocks the guard's sight of them (crates 0.5, barrels 0.4). */
    sight: z.object({ rangeTiles: positive, ledgeRangeTiles: positive, coneHalfAngleDeg: z.number().gt(0).max(180), crouchCoverMin: z.number().min(0) }).strict(),
    /** Footsteps carry this far walking, running and crouching, times the noise of the cell the player is on. */
    noise: z.object({ walkRadiusTiles: z.number().min(0), runRadiusTiles: z.number().min(0), crouchRadiusTiles: z.number().min(0), searchRadiusTiles: z.number().min(0), stumbleRadiusTiles: z.number().min(0) }).strict(),
    /** A suspicious guard that keeps seeing the player this long goes alert and raises the alarm. */
    alertAfterSec: z.number().min(0),
    /** A suspicious guard with no sight or sound of the player this long goes back to unaware. */
    calmSec: z.number().min(0),
    /** An alert guard that has not seen or heard the player this long drops back to suspicious. */
    alertCalmSec: z.number().min(0),
    /** A chasing guard that has not seen or heard the player this long gives up the chase: it stays alert and searches where it last knew they were. */
    loseSightSec: z.number().min(0),
    /** An alert, chasing guard this close catches the player (guardCatch `thrown-off`). */
    catchRangeTiles: positive,
    /** Share of carried items lost when a guard throws the player off, rounded up, picked at random (0 keeps everything). */
    thrownOffLootShare: z.number().min(0).max(1),
    /** The share of carried loot lost in a fall: a rock off a ledge, a bad roof jump or a slip. */
    fellLootShare: z.number().min(0).max(1),
    /** A suspicious guard whose sighting or sound was outside the car (platform, coupling, ledge) walks out to look there. */
    suspiciousStepOutside: z.boolean(),
    /** A suspicious guard walks toward where it saw or heard the player instead of standing and staring. */
    suspiciousApproach: z.boolean(),
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
