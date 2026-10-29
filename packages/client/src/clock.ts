// How the countdown and heat read on the HUD and sound through the AudioBus: pure functions of
// sim state, so they can be tested without a page.
import { heatBandIndex, type HeatCause, type SimConfig } from '@train-robber/sim';

/** The countdown bar's colour step for the share of time left (0 to 1). */
export type ClockStep = 'calm' | 'low' | 'critical';
/** Below this share of the countdown the bar turns red and the tick doubles (design doc: 20%). */
export const CRITICAL_SHARE = 0.2;
export const LOW_SHARE = 0.5;

export function clockStep(share: number): ClockStep {
  return share < CRITICAL_SHARE ? 'critical' : share < LOW_SHARE ? 'low' : 'calm';
}

/**
 * Three heat bands for the meter: low, mid and high in the sim (`heat.bandEdgeShares`, which the
 * guards read too since M6b), named cool, warm and hot on the HUD.
 */
export type HeatBand = 'cool' | 'warm' | 'hot';
export const HEAT_BAND_NAMES: readonly HeatBand[] = ['cool', 'warm', 'hot'];

export function heatBand(heat: number, cfg: SimConfig['values']['heat']): HeatBand {
  return HEAT_BAND_NAMES[heatBandIndex(heat, cfg)]!;
}

/** `m:ss` for the countdown, rounding up so 0:00 only shows at zero. */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.ceil(sec - 1e-9));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}


/** Readable names for heat causes in the per-gain notices. */
export const HEAT_CAUSE_TEXT: Readonly<Record<HeatCause, string>> = {
  shotFired: 'shot fired', alarmRaised: 'alarm raised', playerSpotted: 'spotted', actorKilled: 'killed someone',
  lootTaken: 'loot taken', debug: 'debug key',
};

export const heatNotice = (delta: number, cause: HeatCause) => `+${Number.isInteger(delta) ? delta : delta.toFixed(1)} heat: ${HEAT_CAUSE_TEXT[cause] ?? cause}`;

/** When the countdown ticks (`audio` in game.json): every `tickEverySec` countdown seconds, then every `finalTickEverySec` in the last `finalCountdownSec`. 0 turns that part off. */
export interface TickPlan { tickEverySec: number; finalCountdownSec: number; finalTickEverySec: number }

/**
 * Which countdown tick the clock is on. The client plays a tick whenever this changes, so the
 * ticks follow the clock (faster with heat): one each time it passes a multiple of `tickEverySec`
 * (2:00, 1:30, ...), then every `finalTickEverySec` once `finalCountdownSec` or less is left.
 * Final-stretch buckets are negative so the client can play the sharper tick for them.
 */
export function tickBucket(sec: number, plan: TickPlan): number {
  if (plan.finalCountdownSec > 0 && plan.finalTickEverySec > 0 && sec <= plan.finalCountdownSec) return -Math.ceil(sec / plan.finalTickEverySec) - 1;
  return plan.tickEverySec > 0 ? Math.ceil(sec / plan.tickEverySec) : 0;
}
