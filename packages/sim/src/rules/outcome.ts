// The only code that writes PersistentState: apply a run's outcome under `outcomePolicy`.
// Phase 1 has no loot, so `bankRunLoot` has nothing to bank yet.
import type { PersistentState, RunOutcome, SimConfig } from '../types';

export function applyOutcome(persistent: PersistentState, outcome: RunOutcome, policy: SimConfig['values']['outcomePolicy']): PersistentState {
  const next = { ...persistent };
  const p = policy[outcome];
  next.wantedLevel = Math.max(0, next.wantedLevel + p.wantedDelta);
  if (outcome === 'died') {
    const died = policy.died;
    next.bank -= Math.floor(next.bank * died.bankLossFraction);
    for (const key of died.reset) if (key !== 'upgrades') next[key] = 0;
  }
  return next;
}
