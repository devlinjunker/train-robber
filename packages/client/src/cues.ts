// Readouts the view shows beside the horse, as pure functions of what the sim reports.
import type { BoardingCheck } from '@train-robber/sim';
import type { ObstacleKind } from './obstacle';

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

/**
 * Which train is which during a run (Devlin, switch-train playtests, 2026-10-12 and 13): the
 * train a commit or switch lands on flashes gold for SWITCH_FLASH_SEC, with no lasting highlight,
 * and the one Tab would switch to is outlined pale blue. The edge arrows use the same colours.
 */
export const COMMITTED_COLOUR = 0xffd34d, SWITCH_CANDIDATE_COLOUR = 0x9fe3ff;
export const SWITCH_FLASH_SEC = 1.2;

/** The trains to mark: the committed one, the one Tab would switch to, and seconds since the last commit or switch while its flash lasts. */
export interface TrainFocus {
  committed: string | null;
  candidate: string | null;
  switchAge: number | null;
}

/** A scrape flashes red only briefly; a crash for HIT_FLASH_SEC. */
export const SCRAPE_FLASH_SEC = 0.4;

/** The notice for a crash or a scrape; `obstacle` names what blocked ground was drawn as. */
export function collisionNotice(against: 'train' | 'obstacle', kind: 'crash' | 'scrape', amount: number, obstacle: ObstacleKind = 'rock'): string {
  const what = against === 'train' ? 'the train' : `a ${obstacle}`;
  return `${kind === 'scrape' ? 'Scraped' : 'Crashed into'} ${what}: -${Math.round(amount)} health`;
}

/** On/off for a flash at `hz` blinks per second, `ageSec` after it started. */
export const flashOn = (ageSec: number, hz = 8): boolean => Math.floor(ageSec * hz) % 2 === 0;

/** A map id in words: `alpha-flats` -> `Alpha Flats`. */
export const mapTitle = (id: string): string => id.split(/[-_]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/** What a fatal hit reads as on the wanted poster ("crushed under a train", "rode into a rock"). */
export function deathCause(hit: { cause: 'boarding' | 'mount' | 'thrownOff' | 'fell' | 'collision'; against?: 'train' | 'obstacle'; kind?: 'crash' | 'scrape' }, obstacle: ObstacleKind = 'rock'): string {
  switch (hit.cause) {
    case 'boarding': return 'fell under the wheels jumping for a train';
    case 'mount': return 'fell jumping for the horse';
    case 'thrownOff': return 'thrown from a moving train by a guard';
    case 'fell': return 'fell from a moving train';
    case 'collision': return hit.against === 'train' ? (hit.kind === 'scrape' ? 'dragged along a train' : 'crushed under a train') : `rode into a ${obstacle}`;
  }
}

/**
 * The HUD's day text: `day 2`, with a `life.days` life `day 2/3`, and with `life.trainsPerDay`
 * the train the rider is on or about to rob, `train 1/3`.
 */
export function dayLabel(life: { trainsPerDay: number; days: number }, p: { day: number; trainsToday: number }): string {
  const day = `day ${p.day}${life.days > 0 ? `/${life.days}` : ''}`;
  return life.trainsPerDay > 0 ? `${day} · train ${Math.min(p.trainsToday + 1, life.trainsPerDay)}/${life.trainsPerDay}` : day;
}

/** m:ss for the sun bar. */
const clockText = (sec: number) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * G8: the sun bar beside health, from the sim's day clock. By day it counts down to dusk; at dusk to
 * nightfall, with a warm wash rising to `DUSK_TINT`; at night it counts the grace to make camp (held
 * while a robbery is on) under a dark wash.
 */
export const DUSK_TINT = 0.35, NIGHT_TINT = 0.6;
export function sunView(
  clock: { phase: 'day' | 'dusk' | 'night'; toNightfallSec: number; graceLeftSec: number | null; daylight: number },
  duskSec: number, onRun: boolean,
): { phase: 'day' | 'dusk' | 'night'; share: number; text: string; tint: number } {
  const share = 1 - clock.daylight;
  if (clock.phase === 'day') return { phase: 'day', share, text: `${clockText(clock.toNightfallSec - duskSec)} to dusk`, tint: 0 };
  if (clock.phase === 'dusk') {
    const into = duskSec > 0 ? 1 - clock.toNightfallSec / duskSec : 1;
    return { phase: 'dusk', share, text: `dusk ${clockText(clock.toNightfallSec)}`, tint: DUSK_TINT * Math.max(0, Math.min(1, into)) };
  }
  return { phase: 'night', share: 0, text: onRun ? 'night: finish up' : `make camp ${clockText(clock.graceLeftSec ?? 0)}`, tint: NIGHT_TINT };
}
