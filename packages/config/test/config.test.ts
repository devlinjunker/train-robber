import { describe, it, expect } from 'vitest';
import { derive, loadContent, merge, resolveConfig, type ContentSet } from '../src';

const base = {
  schemaVersion: 1,
  sim: { tickRateHz: 60 },
  logging: { hashEverySec: 1, events: [] },
  player: { speedTilesPerSec: 8 },
  commit: { rangeTiles: 12 },
  boarding: {
    rangeTiles: 2, speedToleranceTilesPerSec: 1.5,
    meter: { sweepPeriodSec: 1.2, zoneWidths: [0.1, 0.25] },
    failure: { stunSec: 1.5, damageFraction: 0.25 },
  },
  health: { max: 100 },
  horse: {
    maxSpeed: 14, accel: 8, brake: 12, dragTilesPerSec2: 4, cruiseTargetRateTilesPerSec2: 10,
    slowZoneSpeedScale: 0.5, turnRateDegPerSec: 120, steering: 'screen', throttleModel: 'hold',
  },
  world: { mode: 'separate' },
  countdown: { enabled: false, startsAt: 'commit', scale: 1 },
  trains: { blank: { name: 'Blank', route: 'main', speedTilesPerSec: 9, cars: [{ template: 'engine' }, { template: 'blank-car', count: 3 }] } },
  outcomePolicy: {
    died: { bankRunLoot: false, wantedDelta: 0, bankLossFraction: 0, reset: [] },
    cancelled: { bankRunLoot: false, wantedDelta: 0 },
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
});
