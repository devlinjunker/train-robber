// The run lifecycle (idle, approach, boarding, aboard, ended) and tick system 4, boarding.
// Phase 1 has one player per run, so the run's phase is that player's phase.
import { runSeed, seedRng } from './rng';
import { applyOutcome } from './rules/outcome';
import type { Command, GameState, HorseState, PlayerId, PlayerState, RejectReason, RunOutcome, RunPhase, SimConfig, SimEvent } from './types';
import { advanceMeter, boardingCheck, commitCheck, commitTarget, distanceToTrain, meterResult, rollMeterZones, sideOf } from './world/boarding';
import { CAR_WIDTH, expandCars, trainLength, type Side } from './world/cars';
import type { WorldMap } from './world/map';
import { WORLD_FRAME, parseCarFrame, type WorldModel } from './world/separate';
import { carPosesOf, pinTrain, unpinTrain } from './world/trains';
import { trackAt } from './world/track';

export interface RunCtx {
  state: GameState;
  map: WorldMap;
  config: SimConfig;
  world: WorldModel;
  emit(ev: SimEvent): void;
}

export function runPhase(state: GameState): RunPhase {
  return state.run ? state.run.phase : 'idle';
}

export function horseOf(state: GameState, p: PlayerState): HorseState {
  const h = state.world.horses.find((q) => q.id === p.horseId);
  if (!h) throw new Error(`player ${p.id} has no horse ${p.horseId}`);
  return h;
}

function reject(ctx: RunCtx, player: PlayerId, command: Command['type'], reason: RejectReason): void {
  ctx.emit({ type: 'CommandRejected', tick: ctx.state.tick, player, command, reason });
}

function setPhase(ctx: RunCtx, player: PlayerId, to: RunPhase): void {
  const from = runPhase(ctx.state);
  if (from === to) return;
  if (ctx.state.run && to !== 'idle') ctx.state.run.phase = to;
  ctx.emit({ type: 'RunPhaseChanged', tick: ctx.state.tick, player, from, to });
}

/** `startRun` and `interact` while idle: validate the commit, pin the train and enter `approach`. */
export function startRun(ctx: RunCtx, p: PlayerState, trainId: string | undefined, command: Command['type']): void {
  const { state, map, config } = ctx;
  const h = horseOf(state, p);
  if (state.run) return reject(ctx, p.id, command, 'run active');
  const id = trainId ?? commitTarget(state, map, config, h);
  if (!id) return reject(ctx, p.id, command, 'no train in range');
  const why = commitCheck(state, map, config, h, id);
  if (why) return reject(ctx, p.id, command, why);
  pinTrain(state, id, p.id);
  state.runCount += 1;
  state.rng = seedRng(runSeed(state.seed, state.runCount));
  const rp = { health: config.values.health.max, meter: { phase: 0, zoneCentre: 0 }, boardingAttempts: 0, stumbleTicks: 0 };
  rollMeterZones(state, rp.meter, config.values.boarding.meter.zoneWidths);
  state.run = { runNumber: state.runCount, startedTick: state.tick, trainId: id, phase: 'approach', players: { [p.id]: rp } };
  ctx.emit({ type: 'RunStarted', tick: state.tick, player: p.id, runNumber: state.runCount, trainId: id });
  ctx.emit({ type: 'RunPhaseChanged', tick: state.tick, player: p.id, from: 'idle', to: 'approach' });
}

/** Put the player back on the horse in the world frame, stopped, at (x, y) facing (hx, hy). */
function remount(state: GameState, p: PlayerState, x: number, y: number, hx: number, hy: number): void {
  const h = horseOf(state, p);
  Object.assign(h, { x, y, hx, hy, speed: 0, cruiseTarget: 0, stunTicks: 0, mode: 'physical' as const });
  p.placement = { frame: WORLD_FRAME, x, y, layer: 'ground' };
}

/** Cancel's reset: mounted and stopped at playerSpawn, facing up the screen toward the track. */
function resetToSpawn(ctx: RunCtx, p: PlayerState): void {
  const s = ctx.map.playerSpawn;
  remount(ctx.state, p, s.x, s.y, 0, -1);
}

/** End the run: `ended`, apply the outcome to persistent state, unpin the train, then `idle`. */
function endRun(ctx: RunCtx, p: PlayerState, outcome: RunOutcome, retry: boolean): void {
  const { state } = ctx;
  const run = state.run;
  if (!run) return;
  setPhase(ctx, p.id, 'ended');
  ctx.emit({
    type: 'RunEnded', tick: state.tick, player: p.id, outcome, durationTicks: state.tick - run.startedTick,
    boardingAttempts: run.players[p.id]?.boardingAttempts ?? 0, retry,
  });
  const before = state.persistent;
  const after = applyOutcome(before, outcome, ctx.config.values.outcomePolicy);
  if (after.wantedLevel !== before.wantedLevel || after.bank !== before.bank || after.lifetimeEarned !== before.lifetimeEarned) {
    state.persistent = after;
    ctx.emit({ type: 'PersistentChanged', tick: state.tick, before, after });
  }
  unpinTrain(state, run.trainId);
  setPhase(ctx, p.id, 'idle');
  state.run = null;
}

/** Esc: accepted in every phase but `ended`; back to playerSpawn while the train keeps looping. */
export function cancelRun(ctx: RunCtx, p: PlayerState): void {
  const phase = runPhase(ctx.state);
  if (phase === 'idle' || phase === 'ended') return reject(ctx, p.id, 'cancelRun', 'no run');
  endRun(ctx, p, 'cancelled', false);
  resetToSpawn(ctx, p);
}

/** The train a quick retry lines up behind: the run's, else the nearest. */
function retryTrain(ctx: RunCtx, h: HorseState): string | null {
  if (ctx.state.run) return ctx.state.run.trainId;
  let best: string | null = null, bestD = Infinity;
  for (const t of ctx.state.world.trains) {
    const d = distanceToTrain(ctx.state, ctx.map, ctx.config, t.id, h.x, h.y);
    if (d < bestD) { bestD = d; best = t.id; }
  }
  return best;
}

/** The side of the train the player is on: from the car cell aboard, else from the nearest car. */
function retrySide(ctx: RunCtx, p: PlayerState, h: HorseState, trainId: string): Side {
  const f = parseCarFrame(p.placement.frame);
  if (f) return p.placement.y < CAR_WIDTH / 2 ? 'left' : 'right';
  let side: Side = 'left', best = Infinity;
  for (const car of carPosesOf(ctx.state, ctx.map, ctx.config, trainId)) {
    const dx = h.x - car.x, dy = h.y - car.y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; side = sideOf(car, h.x, h.y); }
  }
  return side;
}

/** Track centre to the waiting horse: half a car plus 1.5 tiles, so it lines up inside boarding range of the doors. */
const RETRY_SIDE_OFFSET = CAR_WIDTH / 2 + 1.5;

/**
 * R, with `playtest.quickRetry` on: end any run as a cancel and wait on the horse, stopped and
 * facing along the track, `quickRetryGapTiles` behind the train's last car on the same side.
 * Also works while idle, so a playtester can line up again after a death.
 */
export function quickRetry(ctx: RunCtx, p: PlayerState): void {
  const { state, map, config } = ctx;
  if (!config.values.playtest.quickRetry) return reject(ctx, p.id, 'quickRetry', 'disabled');
  if (runPhase(state) === 'ended') return reject(ctx, p.id, 'quickRetry', 'no run');
  const h = horseOf(state, p);
  const trainId = retryTrain(ctx, h);
  if (!trainId) return reject(ctx, p.id, 'quickRetry', 'no such train');
  const side = retrySide(ctx, p, h, trainId);
  if (state.run) endRun(ctx, p, 'cancelled', true);
  const train = state.world.trains.find((t) => t.id === trainId)!;
  const def = config.values.trains[train.type]!;
  const route = map.routes.get(def.route)!;
  const at = trackAt(route, train.d - trainLength(expandCars(def.cars)) - config.values.playtest.quickRetryGapTiles);
  // Left of travel is (ty, -tx).
  const s = side === 'left' ? RETRY_SIDE_OFFSET : -RETRY_SIDE_OFFSET;
  remount(state, p, at.x + at.ty * s, at.y - at.tx * s, at.tx, at.ty);
}

/** Tick system 4: the boarding phase timers, the meter sweep, and jumps sampled on this tick. */
export function boardingSystem(ctx: RunCtx, jumps: ReadonlySet<PlayerId>): void {
  const { state, map, config } = ctx;
  const b = config.values.boarding;
  for (const p of state.players) {
    const jumped = jumps.has(p.id);
    const run = state.run;
    const rp = run?.players[p.id];
    if (!run || !rp) { if (jumped) reject(ctx, p.id, 'jump', 'no run'); continue; }
    const h = horseOf(state, p);
    if (run.phase === 'boarding') {
      // A failed jump holds `boarding` while the horse is stunned, then the approach resumes.
      if (jumped) reject(ctx, p.id, 'jump', 'stunned');
      if (h.stunTicks === 0) setPhase(ctx, p.id, 'approach');
      continue;
    }
    if (run.phase !== 'approach') { if (jumped) reject(ctx, p.id, 'jump', 'aboard'); continue; }

    const check = boardingCheck(state, map, config, run.trainId, h);
    if (jumped) {
      // In range is enough to try; a speed mismatch only means the faster meter.
      if (check.state === 'too far') {
        reject(ctx, p.id, 'jump', 'too far');
      } else {
        resolveJump(ctx, p, h, check.car!, check.entry!);
        continue;
      }
    }
    // Leaving range parks the marker but keeps the zones.
    advanceMeter(rp.meter, check.state, b.meter);
  }
}

function resolveJump(ctx: RunCtx, p: PlayerState, h: HorseState, car: number, entry: string): void {
  const { state, config } = ctx;
  const run = state.run!;
  const rp = run.players[p.id]!;
  const b = config.values.boarding;
  rp.boardingAttempts += 1;
  const { result, position } = meterResult(rp.meter, b.meter.zoneWidths);
  setPhase(ctx, p.id, 'boarding');
  ctx.emit({ type: 'BoardingAttempt', tick: state.tick, player: p.id, result, attempt: rp.boardingAttempts, meter: position });
  // The jump has resolved, so the next attempt gets new zones.
  rollMeterZones(state, rp.meter, b.meter.zoneWidths);
  rp.meter.phase = 0;
  if (result !== 'fail') {
    ctx.world.enterTrain(state, p.id, { trainId: run.trainId, car, entry });
    rp.stumbleTicks = result === 'good' ? b.landing.stumbleTicks : 0;
    setPhase(ctx, p.id, 'aboard');
    return;
  }
  // Thrown clear: the horse is stunned at reduced speed while the train pulls ahead.
  h.stunTicks = b.failure.stunTicks;
  h.speed *= b.failure.horseSpeedScale;
  h.cruiseTarget = h.speed;
  const amount = config.values.health.max * b.failure.damageFraction;
  if (amount > 0) {
    rp.health = Math.max(0, rp.health - amount);
    ctx.emit({ type: 'DamageDealt', tick: state.tick, target: p.id, amount, health: rp.health, cause: 'boarding' });
  }
}

/** Tick system 11, run end: a player at no health dies, then resets as cancel does. */
export function runEndSystem(ctx: RunCtx): void {
  const run = ctx.state.run;
  if (!run) return;
  for (const p of ctx.state.players) {
    const rp = run.players[p.id];
    if (rp && rp.health <= 0) {
      endRun(ctx, p, 'died', false);
      resetToSpawn(ctx, p);
      return;
    }
  }
}
