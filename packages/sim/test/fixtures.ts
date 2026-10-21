// Test config and maps built in code, so sim tests do not depend on the config package.
// Tests may use trig; only sim source may not.
import type { CarTemplateDef, SimConfig, SimMap, SimRoute } from '../src';

type Horse = SimConfig['values']['horse'];
type Values = SimConfig['values'];

export const TEST_CELL_TYPES: Values['cellTypes'] = [
  { id: 'floor', blocksMove: false, blocksSight: false, cover: 0, noise: 1, colour: '#8a6a4a' },
  { id: 'wall', blocksMove: true, blocksSight: true, cover: 1, colour: '#4a3022' },
  { id: 'door', blocksMove: false, blocksSight: true, cover: 0, noise: 1.5, opensOnInteract: true, colour: '#e8c872' },
  { id: 'crate-stack', blocksMove: true, blocksSight: false, cover: 0.5, colour: '#b08850' },
  { id: 'window', blocksMove: true, blocksSight: false, cover: 0, colour: '#9fd3e8' },
];
const CHAR: Record<string, string> = { '#': 'wall', '.': 'floor', D: 'door', C: 'crate-stack', W: 'window' };

/**
 * A car template from rows of characters (# wall, . floor, D door, C crate, W window), as build-cars would
 * write it: cells run-length encoded against a legend.
 */
export function asciiCar(carType: string, rows: string[], extra: Partial<Pick<CarTemplateDef, 'entryPoints' | 'lootSlots' | 'guardSpawns' | 'patrols'>> = {}): CarTemplateDef {
  const legend: string[] = [];
  const cells: [number, number][] = [];
  for (const ch of rows.join('')) {
    const type = CHAR[ch]!;
    if (!legend.includes(type)) legend.push(type);
    const v = legend.indexOf(type), last = cells[cells.length - 1];
    if (last && last[1] === v) last[0]++;
    else cells.push([1, v]);
  }
  return { carType, size: { cols: rows[0]!.length, rows: rows.length }, legend, cells, entryPoints: [], lootSlots: [], guardSpawns: [], patrols: {}, ...extra };
}

const WALLED = ['################', '#..............#', '#..............#', '#..............#', '#..............#', '################'];
const ENDS = [{ id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }] as const;

/** Phase 1's cars, now as templates: an engine with no doors, and blank cars with a two-cell door mid-car on both sides and end doors. */
export const TEST_CARS: Values['carTemplates'] = {
  engine: asciiCar('engine', WALLED),
  'blank-car': asciiCar('blank-car', ['#######DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
    entryPoints: [{ id: 'side-left', side: 'left', cell: [8, 0] }, { id: 'side-right', side: 'right', cell: [8, 5] }, ...ENDS],
  }),
  /** Mail cars for loot tests: both doors (a), the left side only (b), end doors only (c). */
  'mail-a': asciiCar('mail', ['#######DD#######', '#..C...........#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
    entryPoints: [{ id: 'side-left', side: 'left', cell: [8, 0] }, { id: 'side-right', side: 'right', cell: [8, 5] }, ...ENDS],
    lootSlots: [{ cell: [2, 1], tags: ['small'] }, { cell: [5, 2], tags: ['small'] }, { cell: [10, 3], tags: ['small', 'hidden'] }, { cell: [12, 4], tags: ['large'] }],
  }),
  'mail-b': asciiCar('mail', ['#######DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '################'], {
    entryPoints: [{ id: 'side-left', side: 'left', cell: [8, 0] }, ...ENDS],
    lootSlots: [{ cell: [3, 1], tags: ['small'] }, { cell: [6, 3], tags: ['small'] }, { cell: [13, 4], tags: ['large'] }],
  }),
  'mail-c': asciiCar('mail', ['################', '#..............#', 'D..............D', 'D..............D', '#..............#', '################'], {
    entryPoints: [...ENDS],
    lootSlots: [{ cell: [4, 1], tags: ['small'] }, { cell: [9, 4], tags: ['large'] }],
  }),
};

export const TEST_ITEMS: Values['items'] = {
  letter: { name: 'Letter', value: 5, weight: 0.1, category: 'mail', slotTags: ['small'] },
  'cash-bundle': { name: 'Cash bundle', value: 40, weight: 0.2, category: 'cash', slotTags: ['small'] },
  parcel: { name: 'Parcel', value: 20, weight: 0.5, category: 'mail', slotTags: ['small'] },
  strongbox: { name: 'Strongbox', value: 450, weight: 6, category: 'prize', slotTags: ['large'] },
  'mail-sack': { name: 'Registered mail sack', value: 250, weight: 4, category: 'prize', slotTags: ['large'] },
};

export const TEST_LOOT_TABLES: Values['lootTables'] = {
  mail: {
    items: [{ item: 'letter', weight: 4 }, { item: 'cash-bundle', weight: 2 }, { item: 'parcel', weight: 3 }],
    prizes: { count: [1, 2], items: [{ item: 'strongbox', weight: 1 }, { item: 'mail-sack', weight: 1 }] },
  },
};

/** A mail train of `carCount` mail cars between engine and a blank caboose, for loot tests. */
export const TEST_MAIL_TRAIN: Values['trains'][string] = {
  route: 'main', speedTilesPerTick: 9 / 60, engine: 'engine', carType: 'mail', carCount: 3, caboose: 'blank-car',
  requireSideDoors: 'both', countdown: { baseSec: 150 }, loot: { table: 'mail', density: 0.6 }, verbs: ['search'],
};

/** Like the real base config at 60 Hz; `more` replaces whole sections. */
/** Outside values that leave the cars end to end with no ledges (the layout before sneaking PR 2). */
export const NO_OUTSIDE: Values['outside'] = {
  ledges: false, platformDepthTiles: 0, couplingGapTiles: 0, gangwayWidthTiles: 0, ledgeWidthTiles: 0, seeThroughDoorways: false,
  platformSpeedTilesPerTick: 4 / 60, ledgeSpeedTilesPerTick: 1.2 / 60, platformNoise: 1, ledgeNoise: 0, scrape: { glanceTiles: 0.3, knockOff: true, closeDoors: false },
};
/** The shipped outside values: one-tile platforms and gap, a three-tile coupling plate, half-tile ledges and open doorways. */
export const OUTSIDE: Values['outside'] = { ...NO_OUTSIDE, ledges: true, platformDepthTiles: 1, couplingGapTiles: 1, gangwayWidthTiles: 3, ledgeWidthTiles: 0.5, seeThroughDoorways: true };

export function testConfig(horse: Partial<Horse> = {}, hash = 'test0001', more: Partial<Omit<Values, 'horse'>> = {}): SimConfig {
  const rad = (120 * Math.PI) / 180 / 60, guardRad = (240 * Math.PI) / 180 / 60;
  return {
    hash,
    values: {
      sim: { tickRateHz: 60 },
      player: { speedTilesPerTick: 8 / 60, crouch: { speedScale: 0.25 } },
      world: { mode: 'separate' },
      commit: { rangeTiles: 12, timerSec: null, closeRangeTiles: null, promptSwitch: false, cancelInPlace: false, switchRangeTiles: 30, autoSwitch: false, autoSwitchMarginTiles: 4 },
      boarding: {
        rangeTiles: 2, speedToleranceTilesPerSec: 2,
        meter: { sweepPeriodTicks: 72, matchedSweepPeriodTicks: 108, zoneWidths: [0.1, 0.25] },
        failure: { stunTicks: 90, damageFraction: 0.25, horseSpeedScale: 0.5 },
        landing: { stumbleTicks: 30, stumbleSpeedScale: 0.5, goodStumbleInTiles: 0 },
      },
      health: { max: 100 },
      collision: { damageFraction: 0.1, obstacleDamageFraction: 0.1, scrapeDamageFraction: 0.01, minImpactTilesPerSec: 2, fullImpactTilesPerSec: 8, cooldownTicks: 60 },
      playtest: { quickRetry: true, quickRetryGapTiles: 60, debugHeatStep: 10 },
      extraction: {
        arrivalDelaySec: [5, 20], paceWindowTicks: 600, rewhistleCooldownTicks: 300, laneOffsetTiles: 2, dropBackTicks: 180,
        alongsideRangeTiles: 3, mountRangeTiles: 4, doorReachTiles: 1.5, meter: { sweepPeriodTicks: 111, zoneWidths: [0.1, 0.25] },
        mountSpill: 'random', spillShare: 0.3, pathCellTiles: 3, stuckTicks: 180, passThroughBeyondTiles: 30, goodMountStunTicks: 60,
      },
      countdown: { enabled: true, startsAt: 'commit', scale: 1, graceTicks: 180 },
      heat: { maxHeat: 100, heatDrainFactor: 1, sources: { shotFired: 2, alarmRaised: 15, playerSpotted: 5, actorKilled: 8, lootTaken: 1, timeAboardPerTick: 0 }, boardingResistanceAt: null },
      outcomePolicy: {
        died: { bankRunLoot: false, wantedDelta: 0, bankLossFraction: 0, reset: [] },
        cancelled: { bankRunLoot: false, wantedDelta: 0 },
        expired: { bankRunLoot: false, wantedDelta: 1 },
        extracted: { bankRunLoot: true, wantedDelta: 0 },
        cashedOut: { bankRunLoot: true, wantedDelta: 0 },
      },
      cashOut: { enabled: true, closeDoors: true, closeDoorsOnThrownOff: true, doorsReopenTicks: 0 },
      horse: {
        maxSpeed: 14, accel: 8, brake: 12, dragTilesPerSec2: 4, cruiseTargetRateTilesPerSec2: 10, slowZoneSpeedScale: 0.5, waterSpeedScale: 0.25,
        turnRateCosPerTick: Math.cos(rad), turnRateSinPerTick: Math.sin(rad), steering: 'heading', throttleModel: 'hold', runOffTicks: 180,
        boost: { enabled: true, durationTicks: 90, cooldownTicks: 360, topSpeedScale: 1.4, accelTilesPerSec2: 20 },
        ...horse,
      },
      ai: {
        guardCatch: 'heat-only', patrolSpeedTilesPerTick: 1.5 / 60, patrolPauseTicks: 90, chaseSpeedTilesPerTick: 5 / 60,
        turnRateCosPerTick: Math.cos(guardRad), turnRateSinPerTick: Math.sin(guardRad),
        sight: { rangeTiles: 7, coneCos: Math.cos((40 * Math.PI) / 180), crouchCoverMin: 0.4 }, noise: { walkRadiusTiles: 1.5, runRadiusTiles: 5, crouchRadiusTiles: 0.3, searchRadiusTiles: 3, stumbleRadiusTiles: 5 },
        alertAfterTicks: 60, calmTicks: 240, alertCalmTicks: 360, loseSightTicks: 180, catchRangeTiles: 0.8, thrownOffLootShare: 0.5,
      },
      // Cars end to end with no ledges, as before platforms; outside tests set their own.
      outside: NO_OUTSIDE,
      trains: { blank: { route: 'main', speedTilesPerTick: 9 / 60, engine: 'engine', carType: 'blank-car', carCount: 3, requireSideDoors: 'off', countdown: { baseSec: 150 }, verbs: [] } },
      trainMix: { mode: 'map', mailTrain: 'blank', blankTrain: 'blank', trainCount: 3, blankShare: 0 },
      carry: { limitEnabled: true, slowdownEnabled: true, maxWeight: 10, maxItems: 20, slowdownFromWeight: 6, minSpeedScale: 0.5 },
      verbs: { search: { searchTimeTicks: 72, hiddenSearchTimeTicks: 108, timeScale: 1, walkSpeedScale: 0.3, cancelRangeTiles: 1.5, reachTiles: 1.2, hiddenLoot: false } },
      loot: { densityScale: 1 },
      cellTypes: TEST_CELL_TYPES,
      items: TEST_ITEMS,
      lootTables: TEST_LOOT_TABLES,
      carTemplates: TEST_CARS,
      ...more,
    },
  };
}

/**
 * Clockwise stadium (y grows down): the top straight runs right along y = cy - r from
 * x0 to x1, a U-turn of radius r, then the bottom straight runs left along y = cy + r.
 */
export function stadium(x0 = 40, x1 = 160, cy = 50, r = 20, spacing = 0.5): SimRoute {
  const straight = x1 - x0, arc = Math.PI * r;
  const length = 2 * straight + 2 * arc;
  const n = Math.round(length / spacing);
  const step = length / n;
  const at = (d: number): [number, number] => {
    if (d < straight) return [x0 + d, cy - r];
    d -= straight;
    if (d < arc) { const a = -Math.PI / 2 + d / r; return [x1 + r * Math.cos(a), cy + r * Math.sin(a)]; }
    d -= arc;
    if (d < straight) return [x1 - d, cy + r];
    d -= straight;
    const a = Math.PI / 2 + d / r;
    return [x0 + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const x: number[] = [], y: number[] = [], s: number[] = [], tx: number[] = [], ty: number[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = at(i * step), [bx, by] = at(((i + 1) % n) * step);
    const len = Math.hypot(bx - ax, by - ay);
    x.push(ax); y.push(ay); s.push(i * step); tx.push((bx - ax) / len); ty.push((by - ay) / len);
  }
  return { id: 'main', closed: true, length, spacing: step, samples: { x, y, s, tx, ty } };
}

export type Paint = (x: number, y: number) => 'open' | 'slow' | 'blocked' | 'water' | 'deep';

/** An open 200 x 100 map with the stadium route; `paint` sets other zones per tile. */
export function testMap(paint: Paint = () => 'open', spawn = { x: 100, y: 90 }): SimMap {
  const cols = 200, rows = 100;
  const legend = ['open', 'slow', 'blocked', 'water', 'deep'] as const;
  const zones: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = legend.indexOf(paint(c, r));
      const last = zones[zones.length - 1];
      if (last && last[1] === z) last[0]++;
      else zones.push([1, z]);
    }
  }
  return { id: 'test', size: { cols, rows }, zoneLegend: [...legend], zones, routes: [stadium()], markers: { playerSpawn: spawn } };
}
