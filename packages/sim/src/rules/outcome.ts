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
}

export interface OutcomeResult {
  persistent: PersistentState;
  /** The loot value that went into the bank and lifetime earned. */
  banked: number;
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
  next.wantedLevel = Math.max(0, Math.min(maxWantedLevel, next.wantedLevel + p.wantedDelta));
  const banked = p.bankRunLoot ? Math.max(0, Math.floor(summary.cashOut)) : 0;
  next.bank += banked;
  next.lifetimeEarned += banked;
  if (outcome === 'died') {
    const died = policy.died;
    next.bank -= Math.floor(next.bank * died.bankLossFraction);
    for (const key of died.reset) if (key !== 'upgrades') next[key] = 0;
  }
  next.lifetimeEarned = Math.max(persistent.lifetimeEarned, next.lifetimeEarned);
  return { persistent: next, banked };
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
