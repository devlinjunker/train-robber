// Phase 2 M5: the outcome policy as a table. applyOutcome is the only writer of PersistentState.
import { describe, expect, it } from 'vitest';
import { applyOutcome, isPractice, runWantedLevel, type OutcomePolicy, type PersistentState, type RunOutcome } from '../src';
import { testConfig } from './fixtures';

const config = testConfig();
/** The shipped policy (base/game.json): only extracted and cashedOut bank; only expired raises wanted (throw-offs add theirs through wantedBonus). */
const POLICY = config.values.outcomePolicy;
const MAX = config.values.wanted.maxLevel;
const START: PersistentState = { wantedLevel: 2, bank: 100, lifetimeEarned: 300 };

const withDied = (died: Partial<OutcomePolicy['died']>): OutcomePolicy => ({ ...POLICY, died: { ...POLICY.died, ...died } });

interface Row { name: string; outcome: RunOutcome; cashOut: number; wantedBonus?: number; start?: PersistentState; policy?: OutcomePolicy; after: PersistentState; banked: number }

const TABLE: Row[] = [
  // The shipped policy, every outcome, with loot carried out.
  { name: 'extracted banks the loot, wanted +0', outcome: 'extracted', cashOut: 40, after: { wantedLevel: 2, bank: 140, lifetimeEarned: 340 }, banked: 40 },
  { name: 'cashedOut banks the loot, wanted +0', outcome: 'cashedOut', cashOut: 25, after: { wantedLevel: 2, bank: 125, lifetimeEarned: 325 }, banked: 25 },
  { name: 'expired loses the loot, wanted +1', outcome: 'expired', cashOut: 40, after: { wantedLevel: 3, bank: 100, lifetimeEarned: 300 }, banked: 0 },
  { name: 'died loses the loot, wanted +0', outcome: 'died', cashOut: 40, after: START, banked: 0 },
  { name: 'caught loses the loot, wanted +0 of its own (the throw adds it)', outcome: 'caught', cashOut: 0, after: START, banked: 0 },
  // Wanted picked up on the way (wanted.perThrowOff per throw-off) adds to any outcome's delta.
  { name: 'caught after one throw-off: wanted +1', outcome: 'caught', cashOut: 0, wantedBonus: 1, after: { wantedLevel: 3, bank: 100, lifetimeEarned: 300 }, banked: 0 },
  { name: 'cashedOut after two throw-offs banks, wanted +2', outcome: 'cashedOut', cashOut: 25, wantedBonus: 2, after: { wantedLevel: 4, bank: 125, lifetimeEarned: 325 }, banked: 25 },
  { name: 'expired after a throw-off: wanted +2, within maxLevel', outcome: 'expired', cashOut: 0, wantedBonus: 1, start: { wantedLevel: MAX - 1, bank: 0, lifetimeEarned: 0 }, after: { wantedLevel: MAX, bank: 0, lifetimeEarned: 0 }, banked: 0 },
  { name: 'cancelled loses the loot, wanted +0', outcome: 'cancelled', cashOut: 40, after: START, banked: 0 },
  // Nothing carried.
  { name: 'extracted with nothing banks nothing', outcome: 'extracted', cashOut: 0, after: START, banked: 0 },
  // Fractions and nonsense values never reach the save.
  { name: 'banking floors to whole dollars', outcome: 'extracted', cashOut: 12.9, after: { wantedLevel: 2, bank: 112, lifetimeEarned: 312 }, banked: 12 },
  { name: 'a negative cash out banks nothing', outcome: 'extracted', cashOut: -5, after: START, banked: 0 },
  // Wanted level stays within 0 to maxLevel.
  { name: 'expired at the top level stays at maxLevel', outcome: 'expired', cashOut: 0, start: { wantedLevel: MAX, bank: 0, lifetimeEarned: 0 }, after: { wantedLevel: MAX, bank: 0, lifetimeEarned: 0 }, banked: 0 },
  { name: 'a negative wantedDelta stops at 0', outcome: 'cancelled', cashOut: 0, start: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, policy: { ...POLICY, cancelled: { bankRunLoot: false, wantedDelta: -1 } }, after: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, banked: 0 },
  { name: 'cancelWantedDelta-style policy: cancel costs a level', outcome: 'cancelled', cashOut: 0, policy: { ...POLICY, cancelled: { bankRunLoot: false, wantedDelta: 1 } }, after: { wantedLevel: 3, bank: 100, lifetimeEarned: 300 }, banked: 0 },
  // Death policies (standard and roguelike presets).
  { name: 'died with bankLossFraction takes a share of the bank, never lifetime earned', outcome: 'died', cashOut: 40, policy: withDied({ bankLossFraction: 0.25 }), after: { wantedLevel: 2, bank: 75, lifetimeEarned: 300 }, banked: 0 },
  { name: 'died with reset wipes the named fields', outcome: 'died', cashOut: 0, policy: withDied({ reset: ['wantedLevel', 'bank'] }), after: { wantedLevel: 0, bank: 0, lifetimeEarned: 300 }, banked: 0 },
  { name: 'died with wantedDelta +1 raises wanted', outcome: 'died', cashOut: 0, policy: withDied({ wantedDelta: 1 }), after: { wantedLevel: 3, bank: 100, lifetimeEarned: 300 }, banked: 0 },
  { name: 'died with bankRunLoot banks first, then the loss applies', outcome: 'died', cashOut: 100, policy: withDied({ bankRunLoot: true, bankLossFraction: 0.5 }), after: { wantedLevel: 2, bank: 100, lifetimeEarned: 400 }, banked: 100 },
  // Lifetime earned never decreases, even under a policy that names it in reset.
  { name: 'lifetime earned never decreases, even when reset names it', outcome: 'died', cashOut: 0, policy: withDied({ reset: ['lifetimeEarned', 'upgrades'] }), after: START, banked: 0 },
  { name: 'expired with bankRunLoot on banks', outcome: 'expired', cashOut: 30, policy: { ...POLICY, expired: { bankRunLoot: true, wantedDelta: 1 } }, after: { wantedLevel: 3, bank: 130, lifetimeEarned: 330 }, banked: 30 },
];

describe('applyOutcome (outcome policy table)', () => {
  it.each(TABLE)('$name', (row) => {
    const start = row.start ?? START;
    const frozen = Object.freeze({ ...start });
    const r = applyOutcome(frozen, row.outcome, { cashOut: row.cashOut, wantedBonus: row.wantedBonus ?? 0 }, row.policy ?? POLICY, MAX);
    expect(r.persistent).toEqual(row.after);
    expect(r.banked).toBe(row.banked);
    expect(r.persistent.lifetimeEarned).toBeGreaterThanOrEqual(start.lifetimeEarned);
    // Pure: the input is untouched.
    expect(frozen).toEqual(start);
  });

  it('covers every outcome in the shipped policy', () => {
    const outcomes = new Set(TABLE.map((r) => r.outcome));
    expect([...outcomes].sort()).toEqual(Object.keys(POLICY).sort());
  });
});

describe('wanted.forceLevel', () => {
  it('is practice when set, and the run uses it within 0 to maxLevel', () => {
    const saved = { persistent: { wantedLevel: 4, bank: 0, lifetimeEarned: 0 } };
    expect(isPractice(config)).toBe(false);
    expect(runWantedLevel(saved, config)).toBe(4);
    const forced = testConfig({}, 'force001', { wanted: { ...config.values.wanted, forceLevel: 1 } });
    expect(isPractice(forced)).toBe(true);
    expect(runWantedLevel(saved, forced)).toBe(1);
    expect(runWantedLevel({ persistent: { wantedLevel: 9, bank: 0, lifetimeEarned: 0 } }, config)).toBe(MAX);
  });
});
