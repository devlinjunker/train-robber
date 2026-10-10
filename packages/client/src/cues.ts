// Readouts the view shows beside the horse, as pure functions of what the sim reports.
import type { BoardingCheck } from '@train-robber/sim';

/** The too fast / too slow / matched readout: the sim's verdict in range, the same reading by speed out of it. */
export function speedLabel(check: BoardingCheck, tolerance: number): { text: string; colour: number } {
  const d = check.speedDelta;
  const sign = `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
  const state = check.state !== 'too far' ? check.state : d > tolerance ? 'too fast' : d < -tolerance ? 'too slow' : 'eligible';
  if (state === 'eligible') return { text: `MATCHED ${sign}`, colour: 0x6bff8a };
  return { text: `${state.toUpperCase()} ${sign}`, colour: 0xff9f43 };
}
