import { describe, it, expect } from 'vitest';
import { derive, loadContent, merge, overridesFromSet, resolveConfig, setEntries, type ContentSet } from '../src';

const base = {
  schemaVersion: 1,
  sim: { tickRateHz: 60 },
  logging: { hashEverySec: 1, events: [] },
  player: { speedTilesPerSec: 8 },
  commit: { rangeTiles: 12, auto: true, switchRangeTiles: 30, autoSwitch: false, autoSwitchMarginTiles: 4 },
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
  },
  world: { mode: 'separate' },
  countdown: { enabled: true, startsAt: 'commit', scale: 1, graceSec: 3 },
  heat: { maxHeat: 100, heatDrainFactor: 1, sources: { shotFired: 2, alarmRaised: 15, playerSpotted: 5, actorKilled: 8, lootTaken: 1, timeAboardPerSec: 0 }, boardingResistanceAt: null },
  loot: { densityScale: 1 },
  trains: { blank: { name: 'Blank', route: 'main', speedTilesPerSec: 9, cars: [{ template: 'engine' }, { template: 'blank-car', count: 3 }], countdown: { baseSec: 150 } } },
  outcomePolicy: {
    died: { bankRunLoot: false, wantedDelta: 0, bankLossFraction: 0, reset: [] },
    cancelled: { bankRunLoot: false, wantedDelta: 0 },
    expired: { bankRunLoot: false, wantedDelta: 1 },
  },
};

const variant = (group: string, id: string, patch: object) =>
  ({ file: `variants/${id}.json`, data: { schemaVersion: 1, id, group, label: id, question: '?', patch } });

function content(extra: Partial<ContentSet> = {}): ContentSet {
  return {
    base: { file: 'base/game.json', data: base },
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
    expect(overridesFromSet(['countdown.scale=4', 'heat.sources.timeAboardPerSec=0.2', 'commit.auto=false', 'heat.boardingResistanceAt=null', 'horse.steering=screen']))
      .toEqual({ countdown: { scale: 4 }, heat: { sources: { timeAboardPerSec: 0.2 }, boardingResistanceAt: null }, commit: { auto: false }, horse: { steering: 'screen' } });
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
