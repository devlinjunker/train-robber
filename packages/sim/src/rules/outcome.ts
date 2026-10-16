// The only code that writes PersistentState: apply a run's outcome under `outcomePolicy`.
// `bankRunLoot` cashes the run's loot into the bank and lifetime earned (an extraction, M4).
import type { PersistentState, RunOutcome, SimConfig } from '../types';

export function applyOutcome(persistent: PersistentState, outcome: RunOutcome, policy: SimConfig['values']['outcomePolicy'], runLootValue = 0): PersistentState {
  const next = { ...persistent };
  const p = policy[outcome];
  next.wantedLevel = Math.max(0, next.wantedLevel + p.wantedDelta);
  if (p.bankRunLoot && runLootValue > 0) {
    next.bank += runLootValue;
    next.lifetimeEarned += runLootValue;
  }
  if (outcome === 'died') {
    const died = policy.died;
    next.bank -= Math.floor(next.bank * died.bankLossFraction);
    for (const key of died.reset) if (key !== 'upgrades') next[key] = 0;
  }
  return next;
}
