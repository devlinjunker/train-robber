// G8 day clock (2026-11-12): a budget of daylight for a few trains. Dawn runs to nightfall in
// `day.lengthSec`; the last `day.duskSec` is dusk, when one free train near you becomes the day's
// last train (richer, better guarded). A run on at nightfall holds the clock (dusk waits for a
// robbery in progress). After nightfall nothing new can be committed to, and the rider has
// `day.nightGraceSec` to make camp; when the grace runs out the day ends where they are and
// `day.nightLossShare` of the saddlebag is lost. Making camp or dying ends the day at any time.
import type { GameState, PlayerState, SimConfig, SimEvent } from '../types';
import type { WorldMap } from '../world/map';
import { distanceToTrain, doorsClosed } from '../world/boarding';
import { isPractice } from './outcome';

interface DayCtx {
  state: GameState;
  map: WorldMap;
  config: SimConfig;
  emit(ev: SimEvent): void;
}

/** Where a day stands: `day` before dusk, `dusk`, `night` (after nightfall, the grace to make camp). */
export type DayPhase = 'day' | 'dusk' | 'night';

export interface DayClock {
  phase: DayPhase;
  /** Seconds until nightfall (0 after it). */
  toNightfallSec: number;
  /** After nightfall: seconds of grace left to make camp (held at full while a run is on); null before. */
  graceLeftSec: number | null;
  /** 0 at dawn to 1 at nightfall, for a sun bar. */
  daylight: number;
  /**
   * The time of day in game minutes after midnight: `day.dawnHour` at dawn to `day.nightfallHour` at
   * nightfall, at the same rate on into the night. For the HUD clock and, later, timetables and tips.
   */
  minutes: number;
}

const ticks = (config: SimConfig, sec: number) => Math.max(0, Math.round(sec * config.values.sim.tickRateHz));

/** The day clock's tick marks for this config: dusk starts, nightfall, and the grace's end. */
export function dayMarks(config: SimConfig): { dusk: number; nightfall: number; graceEnd: number } {
  const d = config.values.day;
  const nightfall = Math.max(1, ticks(config, d.lengthSec));
  return { dusk: Math.max(0, nightfall - ticks(config, d.duskSec)), nightfall, graceEnd: nightfall + ticks(config, d.nightGraceSec) };
}

/** Whether the day clock runs at all (`day.clock`). */
export const dayClockOn = (config: SimConfig): boolean => !!config.values.day?.clock;

/** True once the light is gone for `p`: no new commits. False with the clock off. */
export function isNight(config: SimConfig, p: PlayerState): boolean {
  return dayClockOn(config) && p.dayTicks >= dayMarks(config).nightfall;
}

/** Game minutes after midnight `ticks` into the day: dawnHour at 0, nightfallHour at nightfall, the same rate after. */
export function timeOfDay(config: SimConfig, ticks: number): number {
  const d = config.values.day;
  const perTick = ((d.nightfallHour - d.dawnHour) * 60) / dayMarks(config).nightfall;
  return d.dawnHour * 60 + ticks * perTick;
}

/** The clock as the HUD shows it. */
export function dayClock(config: SimConfig, p: PlayerState): DayClock {
  const m = dayMarks(config);
  const hz = config.values.sim.tickRateHz;
  const t = p.dayTicks;
  const phase: DayPhase = t >= m.nightfall ? 'night' : t >= m.dusk ? 'dusk' : 'day';
  return {
    phase,
    toNightfallSec: Math.max(0, (m.nightfall - t) / hz),
    graceLeftSec: phase === 'night' ? Math.max(0, (m.graceEnd - t) / hz) : null,
    daylight: Math.min(1, t / m.nightfall),
    minutes: timeOfDay(config, t),
  };
}

/**
 * The free train nearest the rider when dusk starts: not pinned, doors open. Null when none is.
 * Deterministic: trains are compared by distance, then by id.
 */
export function pickLastTrain(ctx: DayCtx, p: PlayerState): string | null {
  const { state, map, config } = ctx;
  const h = state.world.horses.find((q) => q.id === p.horseId);
  if (!h) return null;
  let best: { id: string; d: number } | null = null;
  for (const t of state.world.trains) {
    if (t.pinnedBy !== null || doorsClosed(state, t)) continue;
    const d = distanceToTrain(state, map, config, t.id, h.x, h.y);
    if (!best || d < best.d || (d === best.d && t.id < best.id)) best = { id: t.id, d };
  }
  return best?.id ?? null;
}

/** Lose `day.nightLossShare` of the saddlebag (value rounded down, at least 1; items rounded up). */
export function nightLoss(ctx: DayCtx, p: PlayerState): void {
  const share = ctx.config.values.day.nightLossShare;
  const bag = p.saddlebag;
  if (share <= 0 || bag.value <= 0) return;
  const value = Math.min(bag.value, Math.max(1, Math.floor(bag.value * share)));
  const items = Math.min(bag.items, Math.ceil(bag.items * share - 1e-9));
  p.saddlebag = { value: bag.value - value, items: bag.items - items, runs: bag.runs };
  ctx.emit({ type: 'SaddlebagLost', tick: ctx.state.tick, player: p.id, value, items, cause: 'nightfall' });
}

/**
 * Tick system, after banking and making camp: move each player's day clock on one tick. Emits
 * `DuskStarted` (marking the last train) and `Nightfall` as the marks are crossed. While a run is
 * on, the clock holds at nightfall, so the grace only starts once the robbery ends. Returns the
 * players whose grace ran out with no run on: the caller ends their day (`nightfall`).
 */
export function dayClockSystem(ctx: DayCtx): PlayerState[] {
  const { state, config } = ctx;
  const out: PlayerState[] = [];
  if (!dayClockOn(config)) return out;
  const m = dayMarks(config);
  const d = config.values.day;
  for (const p of state.players) {
    const onRun = !!state.run?.players[p.id];
    if (onRun && p.dayTicks >= m.nightfall) continue;
    const before = p.dayTicks;
    p.dayTicks = before + 1;
    if (before < m.dusk && p.dayTicks >= m.dusk) {
      let lastTrain: string | null = null;
      if (d.lastTrain.enabled && !isPractice(config)) {
        lastTrain = pickLastTrain(ctx, p);
        const t = lastTrain ? state.world.trains.find((q) => q.id === lastTrain) : undefined;
        if (t) t.lastTrain = true;
      }
      ctx.emit({ type: 'DuskStarted', tick: state.tick, player: p.id, day: p.day, lastTrain });
    }
    if (before < m.nightfall && p.dayTicks >= m.nightfall) {
      ctx.emit({ type: 'Nightfall', tick: state.tick, player: p.id, day: p.day, onRun, graceSec: d.nightGraceSec });
    }
    if (!onRun && p.dayTicks >= m.graceEnd) out.push(p);
  }
  return out;
}
