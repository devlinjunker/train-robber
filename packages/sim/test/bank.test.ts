// Stakes PR: the saddlebag, making camp where you are, and crash spills.
import { describe, it, expect } from 'vitest';
import { campCheck, campDistance, campView, createSim, distanceToLine, prepareMap, type Command, type GameState, type Sim, type SimConfig, type SimEvent } from '../src';
import { testConfig, testMap } from './fixtures';

type Values = SimConfig['values'];
// The test track is a stadium from y 30 to 70; (100, 50) in its middle is 20 tiles from it.
const MID = { x: 100, y: 50 };
const cfgWith = (bank: Partial<Values['bank']> = {}): SimConfig => {
  const c = testConfig();
  return { ...c, values: { ...c.values, bank: { ...c.values.bank, atCamp: true, campHoldTicks: 30, campDistanceTiles: 15, campDistancePerWantedTiles: 5, trainSightTiles: 0, ...bank } } };
};
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number, ...commands: Command[]) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim, ...commands)); return ev; };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const at = (sim: Sim, x: number, y: number, speed = 0) => {
  const p = S(sim).players[0]!, h = S(sim).world.horses[0]!;
  Object.assign(h, { x, y, speed, cruiseTarget: speed });
  p.placement = { ...p.placement, x, y };
};
const make = (cfg: SimConfig, persistent = { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, paint?: Parameters<typeof testMap>[0]) =>
  createSim({ config: cfg, map: testMap(paint, { x: 60, y: 60 }), seed: 'bank', playerIds: [1], persistent });
/** Hold C for `ticks` ticks (the press, then held), keeping the horse still at (x, y). */
const hold = (sim: Sim, ticks: number) => {
  const { x, y } = S(sim).players[0]!.placement;
  const ev = step(sim, { type: 'camp', held: true });
  for (let i = 1; i < ticks; i++) { at(sim, x, y); ev.push(...step(sim)); }
  return ev;
};

describe('making camp', () => {
  it('holding C far enough off the line banks the saddlebag and ends the day there', () => {
    const sim = make(cfgWith(), { wantedLevel: 0, bank: 5, lifetimeEarned: 5 });
    expect(distanceToLine(prepareMap(testMap()), MID.x, MID.y)).toBeCloseTo(20, 0);
    const p = S(sim).players[0]!;
    p.health = 40;
    p.saddlebag = { value: 120, items: 3, runs: 2 };
    at(sim, MID.x, MID.y);
    expect(ofType(hold(sim, 29), 'LootBanked')).toHaveLength(0);
    const ev = hold(sim, 31);
    expect(ofType(ev, 'LootBanked')[0]).toMatchObject({ value: 120, items: 3, runs: 2, place: 'camp' });
    expect(ofType(ev, 'PersistentChanged')[0]).toMatchObject({ outcome: 'banked', after: { bank: 125, lifetimeEarned: 125 } });
    expect(ofType(ev, 'DayEnded')[0]).toMatchObject({ day: 1, cause: 'camp', onRun: false });
    expect(ofType(ev, 'DayStarted')[0]).toMatchObject({ day: 2, health: 100 });
    expect(ofType(ev, 'SaddlebagLost')).toHaveLength(0);
    expect(p).toMatchObject({ day: 2, health: 100, saddlebag: { value: 0, items: 0, runs: 0 }, campedAt: { x: MID.x, y: MID.y } });
    // At camp already: another hold is refused until you ride campLeaveTiles away.
    expect(ofType(step(sim, { type: 'camp', held: false }, { type: 'camp', held: true }), 'CommandRejected')[0]).toMatchObject({ command: 'camp', reason: 'already camped' });
    at(sim, MID.x + 11, MID.y);
    step(sim, { type: 'camp', held: false });
    expect(p.campedAt).toBeNull();
  });

  it('an empty saddlebag still makes camp (rest, health back) but banks nothing', () => {
    const sim = make(cfgWith());
    S(sim).players[0]!.health = 30;
    at(sim, MID.x, MID.y);
    const ev = hold(sim, 31);
    expect(ofType(ev, 'LootBanked')).toHaveLength(0);
    expect(ofType(ev, 'DayEnded')[0]).toMatchObject({ cause: 'camp' });
    expect(S(sim).players[0]!.health).toBe(100);
  });

  it('refused too close to the line, while moving, or with a run on', () => {
    const sim = make(cfgWith());
    at(sim, MID.x, 64);
    expect(ofType(step(sim, { type: 'camp', held: true }), 'CommandRejected')[0]).toMatchObject({ reason: 'too close to the line' });
    expect(ofType(steps(sim, 40), 'DayEnded')).toHaveLength(0);
    step(sim, { type: 'camp', held: false });
    at(sim, MID.x, MID.y, 5);
    expect(ofType(step(sim, { type: 'camp', held: true }), 'CommandRejected')[0]).toMatchObject({ reason: 'moving' });
  });

  it('reads where the horse is, not where the rider mounted (Devlin, PR #72: safe to camp next to the track)', () => {
    const cfg = cfgWith();
    const sim = make(cfg);
    at(sim, MID.x, MID.y);
    // Ride to the track: only the horse moves.
    Object.assign(S(sim).world.horses[0]!, { x: MID.x, y: 69 });
    expect(campView(S(sim), sim.map, cfg, S(sim).players[0]!).distance).toBeLessThan(2);
    expect(ofType(step(sim, { type: 'camp', held: true }), 'CommandRejected')[0]).toMatchObject({ reason: 'too close to the line' });
    // Riding near the line says too close, not "stop to camp".
    step(sim, { type: 'camp', held: false });
    Object.assign(S(sim).world.horses[0]!, { x: MID.x, y: 64, speed: 6, cruiseTarget: 6 });
    expect(campCheck(S(sim), sim.map, cfg, S(sim).players[0]!)).toBe('too close to the line');
  });

  it('needs dry ground: no water or mud within campGroundRadiusTiles', () => {
    const wet = make(cfgWith({ campGroundRadiusTiles: 2 }), undefined, (c, r) => (c === MID.x + 2 && r === MID.y ? 'water' : 'open'));
    at(wet, MID.x, MID.y);
    expect(ofType(step(wet, { type: 'camp', held: true }), 'CommandRejected')[0]).toMatchObject({ reason: 'bad ground' });
    const dry = make(cfgWith({ campGroundRadiusTiles: 1 }), undefined, (c, r) => (c === MID.x + 2 && r === MID.y ? 'water' : 'open'));
    at(dry, MID.x, MID.y);
    expect(ofType(hold(dry, 31), 'DayEnded')).toHaveLength(1);
  });

  it('the distance grows with the wanted level; cover lets you camp closer', () => {
    const cfg = cfgWith();
    expect(campDistance(cfg, 0, false)).toBe(15);
    expect(campDistance(cfg, 2, false)).toBe(25);
    expect(campDistance(cfg, 2, true)).toBe(12.5);
    const open = make(cfg, { wantedLevel: 2, bank: 0, lifetimeEarned: 0 });
    at(open, MID.x, MID.y);
    expect(ofType(step(open, { type: 'camp', held: true }), 'CommandRejected')[0]).toMatchObject({ reason: 'too close to the line' });
    // Timber round the spot: 20 tiles off is enough at two stars.
    const wooded = make(cfg, { wantedLevel: 2, bank: 0, lifetimeEarned: 0 }, (c, r) => (Math.abs(c - MID.x) === 2 && Math.abs(r - MID.y) <= 2 ? 'blocked' : 'open'));
    at(wooded, MID.x, MID.y);
    expect(ofType(hold(wooded, 31), 'DayEnded')[0]).toMatchObject({ cause: 'camp' });
  });

  it('the train you robbed must not see you', () => {
    const sim = make(cfgWith({ trainSightTiles: 200 }));
    const p = S(sim).players[0]!;
    p.robbedTrain = S(sim).world.trains[0]!.id;
    at(sim, MID.x, MID.y);
    expect(ofType(step(sim, { type: 'camp', held: true }), 'CommandRejected')[0]).toMatchObject({ reason: 'train sees you' });
    // Another train seeing you does not matter.
    p.robbedTrain = 'gone';
    step(sim, { type: 'camp', held: false });
    expect(ofType(hold(sim, 31), 'DayEnded')).toHaveLength(1);
  });
});

describe('the saddlebag', () => {
  it('a hard crash spills crashSpillShare of it; practice camping saves nothing', () => {
    const cfg = cfgWith({ crashSpillShare: 0.25 });
    // Ride hard into a wall of rocks.
    const blocked = createSim({ config: cfg, map: testMap((c) => (c === 95 ? 'blocked' : 'open'), { x: 60, y: 60 }), seed: 'bank', playerIds: [1] });
    const bp = S(blocked).players[0]!;
    bp.saddlebag = { value: 100, items: 3, runs: 1 };
    const h = S(blocked).world.horses[0]!;
    Object.assign(h, { x: 93, y: 40, hx: 1, hy: 0, speed: 14, cruiseTarget: 14 });
    bp.placement = { ...bp.placement, x: 93, y: 40 };
    const ev = steps(blocked, 30, { type: 'move', x: 0, y: -127 });
    expect(ofType(ev, 'DamageDealt').some((e) => e.cause === 'collision' && e.kind === 'crash')).toBe(true);
    expect(ofType(ev, 'SaddlebagLost')[0]).toMatchObject({ value: 25, items: 1, cause: 'crash' });
    expect(bp.saddlebag).toEqual({ value: 75, items: 2, runs: 1 });
    // Practice (wanted.forceLevel) empties the saddlebag at camp but saves nothing.
    const practice = make({ ...cfg, values: { ...cfg.values, wanted: { ...cfg.values.wanted, forceLevel: 0 } } });
    S(practice).players[0]!.saddlebag = { value: 50, items: 1, runs: 1 };
    at(practice, MID.x, MID.y);
    const pe = hold(practice, 31);
    expect(ofType(pe, 'LootBanked')[0]).toMatchObject({ value: 50, practice: true });
    expect(S(practice).persistent.bank).toBe(0);
  });
});
