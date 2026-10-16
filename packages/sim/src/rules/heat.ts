// Heat and the countdown (U1, U2, U3). Heat only ever goes up through raiseHeat, so every gain
// is one HeatChanged event with its cause; the countdown drains faster as heat rises.
import type { GameState, HeatCause, HeatSource, PlayerState, RunState, SimConfig, SimEvent } from '../types';

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
 * U3 hook: the player is already escaping, so expiry waits up to `countdown.graceTicks`. That is
 * while the horse is alongside and the player is within reach of a door on its side (G18), which
 * needs the extraction horse (M4); until then nobody is ever escaping and the grace never applies.
 */
export function graceApplies(state: GameState, p: PlayerState): boolean {
  // M4 replaces this with: the player's horse is alongside, and p is near a door on its side.
  void state; void p;
  return false;
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
  if (!run.clockRunning && run.phase === 'aboard') run.clockRunning = v.countdown.enabled;
  if (run.phase === 'aboard' && v.heat.sources.timeAboardPerTick > 0) {
    run.pendingHeat += v.heat.sources.timeAboardPerTick;
    if (run.pendingHeat >= 1) {
      const whole = Math.floor(run.pendingHeat);
      run.pendingHeat -= whole;
      raiseHeat(ctx, whole, 'timeAboard');
    }
  }
  if (run.clockRunning && run.countdownSec > 0) {
    run.countdownSec = Math.max(0, run.countdownSec - drainRate(run.heat, v.heat) / v.sim.tickRateHz);
  }
}

/**
 * True when the run should end as `expired` this tick: the clock is at zero and the grace window
 * does not hold it. Inside grace, each tick waited counts toward `countdown.graceTicks`.
 */
export function countdownExpired(ctx: HeatCtx, p: PlayerState): boolean {
  const run = ctx.state.run;
  if (!run || !run.clockRunning || run.countdownSec > 0) return false;
  if (graceApplies(ctx.state, p) && run.graceTicks < ctx.config.values.countdown.graceTicks) {
    run.graceTicks += 1;
    return false;
  }
  return true;
}
