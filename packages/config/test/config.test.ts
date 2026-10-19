import { describe, it, expect } from 'vitest';
import { derive, loadContent, merge, overridesFromSet, resolveConfig, setEntries, type ContentSet } from '../src';

const base = {
  schemaVersion: 1,
  sim: { tickRateHz: 60 },
  logging: { hashEverySec: 1, events: [] },
  player: { speedTilesPerSec: 8 },
  commit: { rangeTiles: 12, timerSec: 2, closeRangeTiles: 4, promptSwitch: true, switchTimerSec: 3, cancelInPlace: true, switchRangeTiles: 30, autoSwitch: false, autoSwitchMarginTiles: 4 },
  boarding: {
    rangeTiles: 2, speedToleranceTilesPerSec: 1.5,
    meter: { sweepPeriodSec: 1.2, matchedSweepPeriodSec: 1.8, zoneWidths: [0.1, 0.25] },
    failure: { stunSec: 1.5, damageFraction: 0.25, horseSpeedScale: 0.5 },
    landing: { stumbleSec: 0.5, stumbleSpeedScale: 0.5 },
  },
  health: { max: 100 },
  collision: { damageFraction: 0.1, obstacleDamageFraction: 0.1, scrapeDamageFraction: 0.01, minImpactTilesPerSec: 2, fullImpactTilesPerSec: 8, cooldownSec: 1 },
  playtest: { quickRetry: true, quickRetryGapTiles: 60, debugHeatStep: 10 },
  horse: {
    maxSpeed: 14, accel: 8, brake: 12, dragTilesPerSec2: 4, cruiseTargetRateTilesPerSec2: 10,
    slowZoneSpeedScale: 0.5, waterSpeedScale: 0.25, turnRateDegPerSec: 120, steering: 'screen', throttleModel: 'hold',
    boost: { enabled: true, durationSec: 1.5, topSpeedScale: 1.4, cooldownSec: 6, accelTilesPerSec2: 20 },
  },
  ai: {
    guardCatch: 'heat-only', patrolSpeedTilesPerSec: 1.5, patrolPauseSec: 1.5, chaseSpeedTilesPerSec: 5, turnRateDegPerSec: 240,
    sight: { rangeTiles: 7, coneHalfAngleDeg: 40 }, noise: { walkRadiusTiles: 1.5, runRadiusTiles: 5 },
    alertAfterSec: 1, calmSec: 4, alertCalmSec: 6, catchRangeTiles: 0.8, thrownOffLootShare: 0.5,
  },
  world: { mode: 'separate' },
  countdown: { enabled: true, startsAt: 'commit', scale: 1, graceSec: 3 },
  heat: { maxHeat: 100, heatDrainFactor: 1, sources: { shotFired: 2, alarmRaised: 15, playerSpotted: 5, actorKilled: 8, lootTaken: 1, timeAboardPerSec: 0 }, boardingResistanceAt: null },
  loot: { densityScale: 1 },
  trains: { blank: { name: 'Blank', route: 'main', speedTilesPerSec: 9, engine: 'engine', carType: 'blank-car', carCount: 3, requireSideDoors: 'off', countdown: { baseSec: 150 }, verbs: [] } },
  trainMix: { mode: 'map', mailTrain: 'blank', blankTrain: 'blank', trainCount: 3, blankShare: 0 },
  carry: { limitEnabled: true, slowdownEnabled: true, maxWeight: 10, maxItems: 20, slowdownFromWeight: 6, minSpeedScale: 0.5 },
  verbs: { search: { searchTimeSec: 1.2, hiddenSearchTimeSec: 1.8, timeScale: 1, walkSpeedScale: 0.3, cancelRangeTiles: 1.5, reachTiles: 1.2, hiddenLoot: false } },
  hud: { showTrainNames: true },
  audio: { volume: 1, tickVolume: 1, tickEverySec: 30, finalCountdownSec: 30, finalTickEverySec: 1 },
  outcomePolicy: {
    died: { bankRunLoot: false, wantedDelta: 0, bankLossFraction: 0, reset: [] },
    cancelled: { bankRunLoot: false, wantedDelta: 0 },
    expired: { bankRunLoot: false, wantedDelta: 1 },
    cashedOut: { bankRunLoot: true, wantedDelta: 0 },
  },
  cashOut: { enabled: true, closeDoors: true, doorsReopenSec: 0 },
};

const variant = (group: string, id: string, patch: object) =>
  ({ file: `variants/${id}.json`, data: { schemaVersion: 1, id, group, label: id, question: '?', patch } });

const car = (carType: string) => ({
  carType, size: { cols: 2, rows: 2 }, legend: ['wall'], cells: [[4, 0]], entryPoints: [], lootSlots: [], guardSpawns: [], patrols: {},
  roofAccess: [], corridor: false, source: { file: `${carType}.tmj`, hash: '0' },
});
const catalogs = {
  cellTypes: { file: 'base/cell-types.json', data: { schemaVersion: 1, cellTypes: [{ id: 'wall', blocksMove: true, blocksSight: true, cover: 1, colour: '#000000' }] } },
  items: { file: 'base/items.json', data: { schemaVersion: 1, items: { letter: { name: 'Letter', value: 5, weight: 0.1, category: 'mail', slotTags: ['small'] } } } },
  lootTables: { file: 'base/loot-tables.json', data: { schemaVersion: 1, lootTables: { mail: { items: [{ item: 'letter', weight: 1 }] } } } },
  carTemplates: { file: 'base/car-templates.json', data: { schemaVersion: 1, generatedBy: 'test', cars: { engine: car('engine'), 'blank-car': car('blank-car') } } },
};

function content(extra: Partial<ContentSet> = {}): ContentSet {
  return {
    base: { file: 'base/game.json', data: base },
    catalogs,
    variants: [
      variant('boardingFailure', 'time-and-damage', {}),
      variant('boardingFailure', 'time-only', { boarding: { failure: { damageFraction: 0 } } }),
    ],
    presets: [{ file: 'presets/p.json', data: { schemaVersion: 1, id: 'p', variants: { boardingFailure: 'time-and-damage' } } }],
    ...extra,
  };
}

describe('derive', () => {
  it('turns seconds into whole ticks and rates into per-tick values', () => {
    const d = derive({ stunSec: 1.5, delaySec: [2, 4.01], speedTilesPerSec: 9 }, 60);
    expect(d.stunTicks).toBe(90);
    expect(d.delayTicks).toEqual([120, 241]);
    expect(d.speedTilesPerTick).toBeCloseTo(0.15, 12);
    expect(d.stunSec).toBe(1.5);
  });
  it('precomputes cosine thresholds and per-tick rotations', () => {
    const d = derive({ sightHalfAngleDeg: 60, turnRateDegPerSec: 120 }, 60);
    expect(d.sightCos).toBeCloseTo(0.5, 12);
    expect(d.turnRateCosPerTick).toBeCloseTo(Math.cos((2 * Math.PI) / 180), 12);
    expect(d.turnRateSinPerTick).toBeCloseTo(Math.sin((2 * Math.PI) / 180), 12);
  });
  it('rejects a source key that collides with a derived one', () => {
    expect(() => derive({ stunSec: 1, stunTicks: 60 }, 60)).toThrow(/stunTicks/);
  });
});

describe('merge', () => {
  it('deep-merges objects, replaces arrays and removes null keys', () => {
    expect(merge({ a: { b: 1, c: 2 }, l: [1, 2], x: 1 }, { a: { b: 3 }, l: [9], x: null })).toEqual({ a: { b: 3, c: 2 }, l: [9] });
  });
});

describe('resolveConfig', () => {
  it('derives, freezes and hashes deterministically', () => {
    const a = resolveConfig(loadContent(content()), { preset: 'p' });
    expect(a.values.boarding.failure.stunTicks).toBe(90);
    expect(a.values.boarding.meter.sweepPeriodTicks).toBe(72);
    expect(a.values.boarding.meter.matchedSweepPeriodTicks).toBe(108);
    expect(a.values.boarding.landing.stumbleTicks).toBe(30);
    expect(a.values.logging.hashEveryTicks).toBe(60);
    expect(a.values.trains.blank!.speedTilesPerTick).toBeCloseTo(0.15, 12);
    expect(a.values.horse.turnRateCosPerTick).toBeCloseTo(Math.cos((2 * Math.PI) / 180), 12);
    expect(Object.isFrozen(a.values.boarding.meter.zoneWidths)).toBe(true);
    expect(a.hash).toBe(resolveConfig(loadContent(content()), { preset: 'p' }).hash);
  });
  it('switches a variant and records the choice', () => {
    const r = resolveConfig(loadContent(content()), { preset: 'p', variants: { boardingFailure: 'time-only' } });
    expect(r.values.boarding.failure.damageFraction).toBe(0);
    expect(r.variants).toEqual({ boardingFailure: 'time-only' });
    expect(r.hash).not.toBe(resolveConfig(loadContent(content()), { preset: 'p' }).hash);
  });
  it('derives tick counts from the resolved tick rate', () => {
    const r = resolveConfig(loadContent(content()), { preset: 'p', overrides: { sim: { tickRateHz: 30 } } });
    expect(r.values.boarding.failure.stunTicks).toBe(45);
  });
  it('rejects unknown keys with the path', () => {
    expect(() => resolveConfig(loadContent(content()), { preset: 'p', overrides: { player: { speedTilesPerSecc: 1 } } }))
      .toThrow(/at player: Unrecognized key/);
  });
  it('rejects two groups patching the same value', () => {
    const c = content();
    c.variants.push(variant('other', 'x', { boarding: { failure: { damageFraction: 1 } } }));
    c.presets[0]!.data = { schemaVersion: 1, id: 'p', variants: { boardingFailure: 'time-only', other: 'x' } };
    expect(() => resolveConfig(loadContent(c), { preset: 'p' })).toThrow(/also patched by group boardingFailure/);
  });
  it('requires a preset to choose every group', () => {
    const c = content();
    c.variants.push(variant('other', 'x', {}));
    expect(() => resolveConfig(loadContent(c), { preset: 'p' })).toThrow(/presets\/p.json at variants.other/);
  });
  it('names the file of a malformed variant', () => {
    const c = content({ variants: [{ file: 'variants/bad.json', data: { schemaVersion: 2 } }] });
    expect(() => loadContent(c)).toThrow(/^variants\/bad.json at schemaVersion/);
  });
  it('derives the grace window and time-aboard heat per tick', () => {
    const r = resolveConfig(loadContent(content()), { preset: 'p', overrides: { heat: { sources: { timeAboardPerSec: 0.6 } } } });
    expect(r.values.countdown.graceTicks).toBe(180);
    expect(r.values.heat.sources.timeAboardPerTick).toBeCloseTo(0.01, 12);
    expect(r.values.trains.blank!.countdown.baseTicks).toBe(9000);
  });

  it('derives the guards\' cone threshold, timers and speeds, and the boost timers (phase 2 M3)', () => {
    const r = resolveConfig(loadContent(content()), { preset: 'p' });
    const ai = r.values.ai;
    expect(ai.sight.coneCos).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 12);
    expect([ai.alertAfterTicks, ai.calmTicks, ai.alertCalmTicks, ai.patrolPauseTicks]).toEqual([60, 240, 360, 90]);
    expect(ai.chaseSpeedTilesPerTick).toBeCloseTo(5 / 60, 12);
    expect(ai.turnRateCosPerTick).toBeCloseTo(Math.cos((4 * Math.PI) / 180), 12);
    expect([r.values.horse.boost.durationTicks, r.values.horse.boost.cooldownTicks]).toEqual([90, 360]);
  });
});

describe('presets that build on others', () => {
  const withChild = (child: object) => content({
    presets: [
      { file: 'presets/p.json', data: { schemaVersion: 1, id: 'p', variants: { boardingFailure: 'time-only' }, values: { countdown: { scale: 2 }, health: { max: 80 } } } },
      { file: 'presets/child.json', data: { schemaVersion: 1, id: 'child', extends: 'p', variants: {}, ...child } },
    ],
  });
  it('inherit the parent\'s variants and values, with their own values on top', () => {
    const r = resolveConfig(loadContent(withChild({ values: { countdown: { scale: 4 }, loot: { densityScale: 4 } } })), { preset: 'child' });
    expect(r.preset).toBe('child');
    expect(r.variants).toEqual({ boardingFailure: 'time-only' });
    expect(r.values.boarding.failure.damageFraction).toBe(0);
    expect(r.values.countdown.scale).toBe(4);
    expect(r.values.loot.densityScale).toBe(4);
    expect(r.values.health.max).toBe(80);
  });
  it('lose to URL variants and overrides', () => {
    const r = resolveConfig(loadContent(withChild({ values: { countdown: { scale: 4 } } })), {
      preset: 'child', variants: { boardingFailure: 'time-and-damage' }, overrides: { countdown: { scale: 1.5 } },
    });
    expect(r.values.boarding.failure.damageFraction).toBe(0.25);
    expect(r.values.countdown.scale).toBe(1.5);
    expect(r.overrides).toEqual({ countdown: { scale: 1.5 } });
  });
  it('name an unknown parent and refuse a loop', () => {
    expect(() => resolveConfig(loadContent(withChild({ extends: 'nope' })), { preset: 'child' })).toThrow(/presets\/child.json at extends: unknown preset nope/);
    const loop = content({
      presets: [
        { file: 'presets/a.json', data: { schemaVersion: 1, id: 'a', extends: 'b', variants: {} } },
        { file: 'presets/b.json', data: { schemaVersion: 1, id: 'b', extends: 'a', variants: { boardingFailure: 'time-only' } } },
      ],
    });
    expect(() => resolveConfig(loadContent(loop), { preset: 'a' })).toThrow(/extends itself/);
  });
  it('validate their values like any override', () => {
    expect(() => resolveConfig(loadContent(withChild({ values: { countdown: { scael: 4 } } })), { preset: 'child' })).toThrow(/at countdown: Unrecognized key/);
  });
});

describe('?set= overrides', () => {
  it('turn dotted paths into a nested tree, reading values as JSON', () => {
    expect(overridesFromSet(['countdown.scale=4', 'heat.sources.timeAboardPerSec=0.2', 'commit.timerSec=null', 'heat.boardingResistanceAt=null', 'horse.steering=screen']))
      .toEqual({ countdown: { scale: 4 }, heat: { sources: { timeAboardPerSec: 0.2 }, boardingResistanceAt: null }, commit: { timerSec: null }, horse: { steering: 'screen' } });
  });
  it('keep the last value for a path and skip anything aimed at a prototype', () => {
    expect(overridesFromSet(['countdown.scale=2', 'countdown.scale=3', '__proto__.polluted=1', 'a.constructor.b=1', '=5'])).toEqual({ countdown: { scale: 3 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('round-trip through setEntries for display', () => {
    expect(setEntries(overridesFromSet(['countdown.scale=4', 'loot.densityScale=4']))).toEqual(['countdown.scale=4', 'loot.densityScale=4']);
  });
  it('resolve into the config and are recorded', () => {
    const r = resolveConfig(loadContent(content()), { preset: 'p', overrides: overridesFromSet(['countdown.scale=4']) });
    expect(r.values.countdown.scale).toBe(4);
    expect(r.overrides).toEqual({ countdown: { scale: 4 } });
  });
});

describe('presets that build on others, two levels deep', () => {
  const withPresets = (...presets: object[]) => content({ presets: [
    { file: 'presets/p.json', data: { schemaVersion: 1, id: 'p', variants: { boardingFailure: 'time-and-damage' } } },
    ...presets.map((data, i) => ({ file: `presets/x${i}.json`, data: { schemaVersion: 1, ...data } })),
  ] });
  it('inherits variants, overrides some, and sets values before URL overrides', () => {
    const c = loadContent(withPresets(
      { id: 'long', extends: 'p', variants: {}, values: { trains: { blank: { carCount: 6 } }, countdown: { scale: 4 } } },
      { id: 'longer', extends: 'long', variants: { boardingFailure: 'time-only' }, values: { countdown: { scale: 5 } } },
    ));
    const long = resolveConfig(c, { preset: 'long' });
    expect(long.variants).toEqual({ boardingFailure: 'time-and-damage' });
    expect([long.values.trains.blank!.carCount, long.values.countdown.scale]).toEqual([6, 4]);
    const longer = resolveConfig(c, { preset: 'longer' });
    expect(longer.variants).toEqual({ boardingFailure: 'time-only' });
    expect([longer.values.trains.blank!.carCount, longer.values.countdown.scale, longer.values.boarding.failure.damageFraction]).toEqual([6, 5, 0]);
    expect(resolveConfig(c, { preset: 'longer', overrides: { countdown: { scale: 2 } } }).values.countdown.scale).toBe(2);
  });
});

describe('catalogs and cross-references', () => {
  it('merges the catalogs into the config, where the hash covers them', () => {
    const r = resolveConfig(loadContent(content()), { preset: 'p' });
    expect(r.values.carTemplates.engine!.carType).toBe('engine');
    expect(r.values.items.letter!.weight).toBe(0.1);
    const changed = content();
    (changed.catalogs.items.data as { items: { letter: { weight: number } } }).items.letter.weight = 0.2;
    expect(resolveConfig(loadContent(changed), { preset: 'p' }).hash).not.toBe(r.hash);
    (changed.catalogs.items.data as { items: { letter: { weight: number } } }).items.letter.weight = 0.1;
  });
  it('names a train template, layout or loot table that does not exist', () => {
    const c = loadContent(content());
    expect(() => resolveConfig(c, { preset: 'p', overrides: { trains: { blank: { engine: 'nope' } } } })).toThrow(/at trains.blank.engine: unknown car template nope/);
    expect(() => resolveConfig(c, { preset: 'p', overrides: { trains: { blank: { layouts: ['engine'] } } } })).toThrow(/trains.blank.layouts.0: engine is a engine, not a blank-car/);
    expect(() => resolveConfig(c, { preset: 'p', overrides: { trains: { blank: { loot: { table: 'gold', density: 1 } } } } })).toThrow(/trains.blank.loot.table: unknown loot table gold/);
    expect(() => resolveConfig(c, { preset: 'p', overrides: { trainMix: { blankTrain: 'ghost' } } })).toThrow(/trainMix.blankTrain: unknown train ghost/);
  });
  it('names a car that uses a cell type the catalog lacks', () => {
    const bad = content();
    const cars = (bad.catalogs.carTemplates.data as { cars: Record<string, { legend: string[] }> }).cars;
    bad.catalogs = { ...bad.catalogs, carTemplates: { ...bad.catalogs.carTemplates, data: { schemaVersion: 1, generatedBy: 't', cars: { ...cars, engine: { ...cars.engine, legend: ['lava'] } } } } };
    expect(() => resolveConfig(loadContent(bad), { preset: 'p' })).toThrow(/carTemplates.engine.legend.0: unknown cell type lava/);
  });
});
