// Heat and the countdown (U1, U2, U3). Heat only ever goes up through raiseHeat, so every gain
// is one HeatChanged event with its cause; the countdown drains faster as heat rises.
import type { GameState, HeatCause, HeatSource, PlayerState, RunState, SimConfig, SimEvent, TrainState } from '../types';
import type { WorldMap } from '../world/map';
import { escaping } from '../world/mount';
import { routeOf, trainSpeed } from '../world/trains';

/** What these helpers need from the tick; the run system's context satisfies it. */
export interface HeatCtx {
  state: GameState;
  config: SimConfig;
  emit(ev: SimEvent): void;
}

export const HEAT_SOURCES: readonly HeatSource[] = ['shotFired', 'alarmRaised', 'playerSpotted', 'actorKilled', 'lootTaken'];

/** Countdown seconds drained per second of play: `1 + heatDrainFactor x heat/100` (U2). */
export function drainRate(heat: number, cfg: SimConfig['values']['heat']): number {
  return 1 + (cfg.heatDrainFactor * heat) / 100;
}

/** The run's whole countdown: the train's `countdown.baseSec` x `countdown.scale` (U1, U7). */
export function runCountdownSec(config: SimConfig, trainType: string): number {
  return config.values.trains[trainType]!.countdown.baseSec * config.values.countdown.scale;
}

/** A town closer than this many seconds of train travel is skipped, so the clock never starts nearly empty. */
export const LINE_CLOCK_MIN_SEC = 30;

/**
 * The line clock (`countdown.lineClock: town` on an open line): the next town at least
 * LINE_CLOCK_MIN_SEC ahead of the train, or the end of the line, and the train's time to reach it.
 * Null on loops, or when the line clock is `fixed`.
 */
export function lineClock(map: WorldMap, config: SimConfig, train: TrainState): { to: string; sec: number } | null {
  if (!map.openLine || (config.values.countdown.lineClock ?? 'town') !== 'town') return null;
  const { route } = routeOf(map, config, train);
  const speed = trainSpeed(config, train.type);
  const town = map.towns.find((t) => t.route === route.id && (t.d - train.d) / speed >= LINE_CLOCK_MIN_SEC);
  const to = town?.id ?? 'end';
  return { to, sec: lineClockSec(map, config, train, to) };
}

/** Seconds until `train` reaches town `to` (or the end of its line with `end`), never below 0. */
export function lineClockSec(map: WorldMap, config: SimConfig, train: TrainState, to: string): number {
  const { route } = routeOf(map, config, train);
  const d = map.towns.find((t) => t.id === to)?.d ?? route.length;
  return Math.max(0, (d - train.d) / trainSpeed(config, train.type));
}

/**
 * The one way heat goes up: add `amount`, clamped to `heat.maxHeat`, and emit HeatChanged with the
 * cause when anything was added. No run, no heat. Returns what was actually added.
 */
export function raiseHeat(ctx: HeatCtx, amount: number, cause: HeatCause): number {
  const run = ctx.state.run;
  if (!run || !(amount > 0)) return 0;
  const before = run.heat;
  run.heat = Math.min(ctx.config.values.heat.maxHeat, before + amount);
  const delta = run.heat - before;
  if (delta > 0) ctx.emit({ type: 'HeatChanged', tick: ctx.state.tick, heat: run.heat, delta, cause });
  return delta;
}

/** Raise heat by the amount `heat.sources` gives an event (for loot, guards and combat as they land). */
export function raiseHeatFor(ctx: HeatCtx, source: HeatSource): number {
  return raiseHeat(ctx, ctx.config.values.heat.sources[source], source);
}

/**
 * G30 hook: true once heat reaches `heat.boardingResistanceAt`. Nothing acts on it until combat
 * (phase 3), when guards shoot at a rider trying to board; off by default.
 */
export function boardingResistanceActive(run: RunState | null, cfg: SimConfig['values']['heat']): boolean {
  const at = cfg.boardingResistanceAt;
  return !!run && at !== null && at !== undefined && run.heat >= at;
}

/**
 * U3: the player is already escaping, so expiry waits up to `countdown.graceTicks`. That is while
 * the horse is alongside and the player is within `extraction.doorReachTiles` of a door on its side (G18).
 */
export function graceApplies(state: GameState, map: WorldMap, config: SimConfig, p: PlayerState): boolean {
  return escaping(state, map, config, p);
}

/**
 * Before run end each tick: start the clock on boarding when `countdown.startsAt` is `boarding`,
 * add time-aboard heat, and drain the countdown at the heat's rate. Expiry itself is a run end,
 * decided in the run end system with `countdownExpired`.
 */
export function countdownSystem(ctx: HeatCtx): void {
  const { state, config } = ctx;
  const run = state.run;
  if (!run || run.phase === 'ended') return;
  const v = config.values;
  // Extracting is still aboard: the player is on the train until the mount lands.
  const aboard = run.phase === 'aboard' || run.phase === 'extracting';
  if (!run.clockRunning && aboard) run.clockRunning = v.countdown.enabled;
  if (aboard && v.heat.sources.timeAboardPerTick > 0) {
    run.pendingHeat += v.heat.sources.timeAboardPerTick;
    if (run.pendingHeat >= 1) {
      const whole = Math.floor(run.pendingHeat);
      run.pendingHeat -= whole;
      raiseHeat(ctx, whole, 'timeAboard');
    }
  }
  if (run.clockRunning && run.countdownSec > 0) {
    // The line clock counts down to a place: heat does not speed the train up.
    const rate = run.clockTo !== undefined ? 1 : drainRate(run.heat, v.heat);
    run.countdownSec = Math.max(0, run.countdownSec - rate / v.sim.tickRateHz);
  }
}

/**
 * True when the run should end as `expired` this tick: the clock is at zero and the grace window
 * does not hold it. Inside grace, each tick waited counts toward `countdown.graceTicks`.
 */
export function countdownExpired(ctx: HeatCtx & { map: WorldMap }, p: PlayerState): boolean {
  const run = ctx.state.run;
  if (!run || !run.clockRunning || run.countdownSec > 0) return false;
  if (graceApplies(ctx.state, ctx.map, ctx.config, p) && run.graceTicks < ctx.config.values.countdown.graceTicks) {
    run.graceTicks += 1;
    return false;
  }
  return true;
}
