// The only code that writes PersistentState: apply a run's outcome under `outcomePolicy` (phase 2 M5).
import type { GameState, PersistentState, RunOutcome, SimConfig } from '../types';

export type OutcomePolicy = SimConfig['values']['outcomePolicy'];

/** What the run brings to its outcome. */
export interface RunSummary {
  /**
   * The loot value the run carried out: on an extraction the carried value after any mount spill, on
   * a cash-out what was left after being thrown off or falling. Other outcomes pass what was carried
   * (or 0); it banks only when the outcome's policy has `bankRunLoot`.
   */
  cashOut: number;
  /** Wanted levels the run picked up on the way (`wanted.perThrowOff` per guard throw-off), added to the outcome's `wantedDelta`. */
  wantedBonus?: number;
  /** The wanted bonus on the loot (`lootMultiplier`), 1 when absent. */
  lootMultiplier?: number;
  /** `bank.atCamp` (stakes PR): loot the outcome would bank goes to the saddlebag (`stashed`) instead, banked when you make camp. */
  atPlace?: boolean;
}

export interface OutcomeResult {
  persistent: PersistentState;
  /** The loot value that went into the bank and lifetime earned. */
  banked: number;
  /** With `atPlace`: the loot value for the saddlebag instead (wanted bonus included), banked later when you make camp. */
  stashed: number;
}

/** The wanted bonus on loot robbed at `level` stars: 1 + `wanted.lootBonusPerLevel` x level. */
export function lootMultiplier(config: SimConfig, level: number): number {
  return 1 + config.values.wanted.lootBonusPerLevel * Math.max(0, level);
}

/**
 * Apply `outcome` to `persistent` under `policy`, a pure function. The wanted level moves by the
 * outcome's `wantedDelta` and stays within 0 to `maxWantedLevel`; `bankRunLoot` banks the run's cash
 * out into the bank and lifetime earned. A death also takes `bankLossFraction` of the bank and wipes
 * the fields in `reset`. Lifetime earned never decreases, whatever the policy says (C2).
 */
export function applyOutcome(persistent: PersistentState, outcome: RunOutcome, summary: RunSummary, policy: OutcomePolicy, maxWantedLevel: number): OutcomeResult {
  const next = { ...persistent };
  const p = policy[outcome];
  next.wantedLevel = Math.max(0, Math.min(maxWantedLevel, next.wantedLevel + p.wantedDelta + (summary.wantedBonus ?? 0)));
  const value = p.bankRunLoot ? Math.max(0, Math.floor(summary.cashOut * (summary.lootMultiplier ?? 1))) : 0;
  const banked = summary.atPlace ? 0 : value;
  const stashed = summary.atPlace ? value : 0;
  next.bank += banked;
  next.lifetimeEarned += banked;
  if (outcome === 'died') {
    const died = policy.died;
    next.bank -= Math.floor(next.bank * died.bankLossFraction);
    for (const key of died.reset) if (key !== 'upgrades') next[key] = 0;
  }
  next.lifetimeEarned = Math.max(persistent.lifetimeEarned, next.lifetimeEarned);
  return { persistent: next, banked, stashed };
}

/** Whether runs are practice: `wanted.forceLevel` is set, so they save nothing (G9). */
export function isPractice(config: SimConfig): boolean {
  return config.values.wanted.forceLevel != null;
}

/** The wanted level a run generated now uses: `wanted.forceLevel` if set, else the saved level, within 0 to `maxLevel`. */
export function runWantedLevel(state: Pick<GameState, 'persistent'>, config: SimConfig): number {
  const w = config.values.wanted;
  return Math.max(0, Math.min(w.maxLevel, w.forceLevel ?? state.persistent.wantedLevel));
}
