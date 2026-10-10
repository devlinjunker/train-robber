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

/** How long the landing banner shows above the player, and the red hit flash lasts, in seconds. */
export const LANDING_CUE_SEC = 1.6;
export const HIT_FLASH_SEC = 1.2;
export const PERFECT_COLOUR = 0x6bff8a, GOOD_COLOUR = 0xffb02e, HIT_COLOUR = 0xff3b30;

/**
 * A perfect landing and a good one read differently at a glance (Devlin, 2026-10-10): perfect is
 * a big green PERFECT with a ring burst at the feet, good is a smaller amber GOOD with the stumble
 * spelled out, and the player flashes amber while the stumble lasts.
 */
export function landingCue(result: 'perfect' | 'good'): { title: string; detail: string; colour: number; size: number; notice: string } {
  return result === 'perfect'
    ? { title: 'PERFECT!', detail: 'clean landing', colour: PERFECT_COLOUR, size: 40, notice: 'PERFECT LANDING: clean, full speed' }
    : { title: 'GOOD', detail: 'stumbling', colour: GOOD_COLOUR, size: 28, notice: 'Good landing: stumbling, slowed for a moment' };
}

/** The notice for a crash. */
export function collisionNotice(against: 'train' | 'obstacle', amount: number): string {
  return `Crashed into ${against === 'train' ? 'the train' : 'a rock'}: -${Math.round(amount)} health`;
}

/** On/off for a flash at `hz` blinks per second, `ageSec` after it started. */
export const flashOn = (ageSec: number, hz = 8): boolean => Math.floor(ageSec * hz) % 2 === 0;
