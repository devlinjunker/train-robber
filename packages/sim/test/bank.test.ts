// Stakes PR: the saddlebag, bank places, crash spills and paying wanted down.
import { describe, it, expect } from 'vitest';
import { bankPlaces, createSim, nearestBankPlace, prepareMap, type Command, type GameState, type Sim, type SimConfig, type SimEvent } from '../src';
import { testConfig, testMap } from './fixtures';

type Values = SimConfig['values'];
const SPAWN = { x: 60, y: 60 };
const cfgWith = (bank: Partial<Values['bank']> = {}, wanted: Partial<Values['wanted']> = {}): SimConfig => {
  const c = testConfig();
  return { ...c, values: { ...c.values, bank: { ...c.values.bank, atPlace: true, ...bank }, wanted: { ...c.values.wanted, ...wanted } } };
};
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const at = (sim: Sim, x: number, y: number) => {
  const p = S(sim).players[0]!, h = S(sim).world.horses[0]!;
  Object.assign(h, { x, y, speed: 0, cruiseTarget: 0 });
  p.placement = { ...p.placement, x, y };
};
const make = (cfg: SimConfig, persistent = { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }) => createSim({ config: cfg, map: testMap(undefined, SPAWN), seed: 'bank', playerIds: [1], persistent });

describe('bank places', () => {
  it('the camp is the player spawn; a town with a position banks within its clearing plus townReachTiles', () => {
    const cfg = cfgWith({ campRadiusTiles: 8, townReachTiles: 4 });
    const m = { ...testMap(undefined, SPAWN), towns: [{ id: 'town1', route: 'main', d: 10, x: 150, y: 50, radiusTiles: 6 }, { id: 'town2', route: 'main', d: 20 }] };
    const places = bankPlaces(prepareMap(m), cfg);
    expect(places).toEqual([{ id: 'camp', kind: 'camp', x: 60, y: 60, radiusTiles: 8 }, { id: 'town1', kind: 'town', x: 150, y: 50, radiusTiles: 10 }]);
    expect(nearestBankPlace(prepareMap(m), cfg, 150, 70)).toMatchObject({ place: { id: 'town1' }, distanceTiles: 10 });
  });
});

describe('the saddlebag', () => {
  it('banks on riding into the camp, not before; lifetime earned rises with it', () => {
    const sim = make(cfgWith({ campRadiusTiles: 8 }), { wantedLevel: 1, bank: 5, lifetimeEarned: 5 });
    at(sim, SPAWN.x + 20, SPAWN.y);
    S(sim).players[0]!.saddlebag = { value: 120, items: 3, runs: 2 };
    expect(ofType(step(sim), 'LootBanked')).toHaveLength(0);
    at(sim, SPAWN.x + 7, SPAWN.y);
    const ev = step(sim);
    expect(ofType(ev, 'LootBanked')[0]).toMatchObject({ value: 120, items: 3, runs: 2, place: 'camp' });
    expect(ofType(ev, 'PersistentChanged')[0]).toMatchObject({ outcome: 'banked', after: { wantedLevel: 1, bank: 125, lifetimeEarned: 125 } });
    expect(S(sim).players[0]!.saddlebag).toEqual({ value: 0, items: 0, runs: 0 });
  });
  it('a crash spills crashSpillShare of it; a practice run banks nothing', () => {
    const cfg = cfgWith({ crashSpillShare: 0.25 });
    // Ride hard into a wall of rocks well away from the camp.
    const blocked = createSim({ config: cfg, map: testMap((c) => (c === 95 ? 'blocked' : 'open'), SPAWN), seed: 'bank', playerIds: [1] });
    const bp = S(blocked).players[0]!;
    bp.saddlebag = { value: 100, items: 3, runs: 1 };
    const h = S(blocked).world.horses[0]!;
    Object.assign(h, { x: 93, y: 40, hx: 1, hy: 0, speed: 14, cruiseTarget: 14 });
    bp.placement = { ...bp.placement, x: 93, y: 40 };
    const ev: SimEvent[] = [];
    for (let i = 0; i < 30; i++) ev.push(...step(blocked, { type: 'move', x: 0, y: -127 }));
    expect(ofType(ev, 'DamageDealt').some((e) => e.cause === 'collision' && e.kind === 'crash')).toBe(true);
    expect(ofType(ev, 'SaddlebagLost')[0]).toMatchObject({ value: 25, items: 1, cause: 'crash' });
    expect(bp.saddlebag).toEqual({ value: 75, items: 2, runs: 1 });
    // Practice (wanted.forceLevel) still empties the saddlebag at the camp but saves nothing.
    const practice = make({ ...cfg, values: { ...cfg.values, wanted: { ...cfg.values.wanted, forceLevel: 2 } } });
    S(practice).players[0]!.saddlebag = { value: 50, items: 1, runs: 1 };
    at(practice, SPAWN.x, SPAWN.y);
    const pe = step(practice);
    expect(ofType(pe, 'LootBanked')[0]).toMatchObject({ value: 50, practice: true });
    expect(S(practice).persistent.bank).toBe(0);
  });
});

describe('making camp (bank.campEndsDay)', () => {
  it('banking at the camp with no run on ends the day: health refilled, next day; a town only banks', () => {
    const sim = make(cfgWith({ campEndsDay: true }));
    const p = S(sim).players[0]!;
    p.health = 40;
    p.saddlebag = { value: 60, items: 2, runs: 1 };
    at(sim, SPAWN.x, SPAWN.y);
    const ev = step(sim);
    expect(ofType(ev, 'LootBanked')).toHaveLength(1);
    expect(ofType(ev, 'DayEnded')[0]).toMatchObject({ day: 1, cause: 'camp', onRun: false });
    expect(ofType(ev, 'DayStarted')[0]).toMatchObject({ day: 2, health: 100 });
    expect(ofType(ev, 'SaddlebagLost')).toHaveLength(0);
    expect(p).toMatchObject({ day: 2, health: 100 });
    expect(S(sim).persistent.bank).toBe(60);
    // Riding about the camp with an empty saddlebag does nothing more.
    expect(ofType(step(sim), 'DayEnded')).toHaveLength(0);
    // Off, the camp only banks.
    const off = make(cfgWith({ campEndsDay: false }));
    S(off).players[0]!.saddlebag = { value: 60, items: 2, runs: 1 };
    at(off, SPAWN.x, SPAWN.y);
    expect(ofType(step(off), 'DayEnded')).toHaveLength(0);
  });
});

describe('paying wanted down (P)', () => {
  it('at a bank place, costs costPerLevel x the level from the bank and drops one star; lifetime earned stays', () => {
    const sim = make(cfgWith({}, { payDown: { enabled: true, costPerLevel: 100 } }), { wantedLevel: 3, bank: 500, lifetimeEarned: 900 });
    at(sim, SPAWN.x + 30, SPAWN.y);
    expect(ofType(step(sim, { type: 'payWanted' }), 'CommandRejected')[0]).toMatchObject({ reason: 'not at a bank' });
    at(sim, SPAWN.x, SPAWN.y);
    const ev = step(sim, { type: 'payWanted' });
    expect(ofType(ev, 'WantedPaidDown')[0]).toMatchObject({ cost: 300, level: 2, place: 'camp' });
    expect(ofType(ev, 'PersistentChanged')[0]).toMatchObject({ outcome: 'paidWanted', after: { wantedLevel: 2, bank: 200, lifetimeEarned: 900 } });
    expect(ofType(step(sim, { type: 'payWanted' }), 'WantedPaidDown')[0]).toMatchObject({ cost: 200, level: 1 });
    expect(ofType(step(sim, { type: 'payWanted' }), 'CommandRejected')[0]).toMatchObject({ reason: 'cannot afford' });
  });
  it('refused with no stars, or when turned off', () => {
    const sim = make(cfgWith(), { wantedLevel: 0, bank: 500, lifetimeEarned: 0 });
    at(sim, SPAWN.x, SPAWN.y);
    expect(ofType(step(sim, { type: 'payWanted' }), 'CommandRejected')[0]).toMatchObject({ reason: 'not wanted' });
    const off = make(cfgWith({}, { payDown: { enabled: false, costPerLevel: 100 } }), { wantedLevel: 2, bank: 500, lifetimeEarned: 0 });
    expect(ofType(step(off, { type: 'payWanted' }), 'CommandRejected')[0]).toMatchObject({ reason: 'disabled' });
  });
});
