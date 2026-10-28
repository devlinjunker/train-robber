// The run lifecycle (idle, approach, boarding, aboard, extracting, ended) and tick system 4, boarding.
// Phase 1 has one player per run, so the run's phase is that player's phase.
import { nextInt, runSeed, seedRng } from './rng';
import { applyOutcome } from './rules/outcome';
import { countdownExpired, HEAT_SOURCES, lineClock, lineClockSec, raiseHeat, raiseHeatFor, runCountdownSec } from './rules/heat';
import type { Command, FallCause, GameState, HeatSource, HorseState, PlayerId, PlayerState, RejectReason, ResumeRun, RunOutcome, RunPhase, RunState, SimConfig, SimEvent, TrainState } from './types';
import { advanceMeter, boardingCheck, commitCheck, doorsClosed, commitTarget, distanceToTrain, meterResult, rollMeterZones, sideOf, switchCheck, switchTarget } from './world/boarding';
import { HORSE_RADIUS, type Impact } from './world/riding';
import { Space, toTrain, trainGrid } from './world/guards';
import { isSolid, Terrain, terrainAt } from './world/map';
import { carCatalog, carTemplate, type Side } from './world/cars';
import { generateLoot, repickFreeTrains } from './world/generate';
import { generateGuards } from './world/guards';
import { carriedValue } from './world/loot';
import type { WorldMap } from './world/map';
import { WORLD_FRAME, parseCarFrame, playerSpace, trainCars, walkerFits, type WorldModel } from './world/separate';
import { atLineEnd, carPosesOf, onMapRange, pinTrain, routeOf, trainLengthOf, trainSpeed, unpinTrain } from './world/trains';
import { carToWorld } from './world/separate';
import { trackAt } from './world/track';
import { freshRoofState } from './world/roof';

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

export function reject(ctx: RunCtx, player: PlayerId, command: Command['type'], reason: RejectReason): void {
  ctx.emit({ type: 'CommandRejected', tick: ctx.state.tick, player, command, reason });
}

export function setPhase(ctx: RunCtx, player: PlayerId, to: RunPhase): void {
  const from = runPhase(ctx.state);
  if (from === to) return;
  if (ctx.state.run && to !== 'idle') ctx.state.run.phase = to;
  ctx.emit({ type: 'RunPhaseChanged', tick: ctx.state.tick, player, from, to });
}

/**
 * The commit prompt. While a free train is in `commit.rangeTiles` of an idle rider the client asks
 * "commit?" and E commits. On top of that the rider commits with no key once they stay in range of
 * the same train for `commit.timerSec` (null: never; 0: at once, the old auto-commit), or ride
 * within `commit.closeRangeTiles` of it (null: off).
 *
 * With `commit.promptSwitch` the same prompt asks "switch?" when a committed rider who can still
 * switch (approach, or stunned after a failed jump) comes within `commit.rangeTiles` of another
 * free train that is closer than the committed one: Tab switches, and `commit.switchTimerSec` and the close range switch with no key.
 */
export function autoCommitSystem(ctx: RunCtx): void {
  const { state, map, config } = ctx;
  const { timerSec, switchTimerSec, closeRangeTiles, rangeTiles, promptSwitch } = config.values.commit;
  for (const p of state.players) {
    // The train left by an in-place cancel only commits again on E until the rider leaves its range.
    if (p.commitHold && (state.run || !state.world.trains.some((t) => t.id === p.commitHold)
      || distanceToTrain(state, map, config, p.commitHold, horseOf(state, p).x, horseOf(state, p).y) > rangeTiles)) p.commitHold = null;
    const run = state.run;
    const canSwitch = !!run && !!promptSwitch && !!run.players[p.id] && (run.phase === 'approach' || run.phase === 'boarding');
    if (run && !canSwitch) { p.commitTimer = null; continue; }
    const h = horseOf(state, p);
    const target = run ? switchTarget(state, map, config, h) : commitTarget(state, map, config, h);
    const d = target ? distanceToTrain(state, map, config, target, h.x, h.y) : Infinity;
    // A switch also needs the other train closer than the committed one, so the prompt never
    // offers to switch straight back to the train just left.
    const closer = !run || d < distanceToTrain(state, map, config, run.trainId, h.x, h.y);
    if (!target || d > rangeTiles || !closer) { p.commitTimer = null; continue; }
    p.commitTimer = p.commitTimer?.trainId === target ? { trainId: target, ticks: p.commitTimer.ticks + 1 } : { trainId: target, ticks: 1 };
    if (!run && p.commitHold === target) continue;
    const sec = run ? switchTimerSec : timerSec;
    const timerUp = sec != null && p.commitTimer.ticks >= Math.max(1, Math.round(sec * config.values.sim.tickRateHz));
    const close = closeRangeTiles != null && d <= closeRangeTiles;
    if (!timerUp && !close) continue;
    p.commitTimer = null;
    if (run) switchTrain(ctx, p, target);
    else startRun(ctx, p, target, 'startRun');
  }
}

/** The run's horse before boarding: ridden, so no call state yet. */
export function freshHorseCall(): RunState['horse'] {
  return { state: 'away', side: 'left', ticks: 0, cooldownTicks: 0, whistles: 0, whistleTick: 0, delaySec: 0, blocked: null, bestDistance: 1e9, stuckTicks: 0, path: [], replanTicks: 0, mountAttempts: 0 };
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
  const rp = {
    meter: { phase: 0, zoneCentre: 0 }, boardingAttempts: 0, stumbleTicks: 0,
    carried: [], search: null, searchLatched: false, crouched: false, ...freshRoofState(),
  };
  // A health bar per run refills at every commit; a day's bar carries on (Devlin, 2026-10-28).
  if (config.values.health.scope === 'run') p.health = config.values.health.max;
  rollMeterZones(state, rp.meter, config.values.boarding.meter.zoneWidths);
  // The countdown is copied into the run at commit (U1); with `startsAt: boarding` it waits there.
  const train = state.world.trains.find((t) => t.id === id)!;
  const cd = config.values.countdown;
  // On an open line the clock runs to the next town instead (countdown.lineClock).
  const towards = lineClock(map, config, train);
  const countdownSec = towards ? towards.sec : runCountdownSec(config, train.type);
  // Run generation: the train's layouts were picked for this run number; fill its loot slots,
  // then place its guards on the layouts' guard spawns.
  const loot = generateLoot(state, config, train);
  const guards = generateGuards(state, config, train);
  state.run = {
    runNumber: state.runCount, startedTick: state.tick, trainId: id, phase: 'approach',
    countdownSec, countdownTotalSec: countdownSec, clockRunning: cd.enabled && cd.startsAt === 'commit', ...(towards ? { clockTo: towards.to } : {}), graceTicks: 0,
    heat: 0, pendingHeat: 0, players: { [p.id]: rp }, loot, nextLootId: loot.length, guards, horse: freshHorseCall(),
  };
  // Back on a train left by an in-place cancel: the clock, heat, health and meter carry on.
  const resume = p.resumeRuns.find((r) => r.trainId === id);
  if (resume) {
    p.resumeRuns = p.resumeRuns.filter((r) => r !== resume);
    const { startedTick, countdownSec: sec, countdownTotalSec, clockRunning, graceTicks, heat, pendingHeat } = resume;
    Object.assign(state.run, { startedTick, countdownSec: sec, countdownTotalSec, clockRunning, graceTicks, heat, pendingHeat });
    // The train kept going while you were off it: the line clock is where it is now.
    if (resume.clockTo !== undefined) Object.assign(state.run, { clockTo: resume.clockTo, countdownSec: lineClockSec(map, config, train, resume.clockTo) });
    Object.assign(rp, { meter: { ...resume.meter }, boardingAttempts: resume.boardingAttempts });
    if (config.values.health.scope === 'run') p.health = resume.health;
  }
  ctx.emit({
    type: 'RunStarted', tick: state.tick, player: p.id, runNumber: state.runCount, trainId: id,
    countdownSec: cd.enabled ? state.run.countdownSec : null, wantedLevel: state.persistent.wantedLevel, ...(resume ? { resumed: true as const } : {}),
  });
  ctx.emit({ type: 'RunPhaseChanged', tick: state.tick, player: p.id, from: 'idle', to: 'approach' });
}

/**
 * Tab, `switchTrain`: move the run's commitment to another free train. Only the train changes:
 * the run number, start tick (so any run timer), health, jump count and meter zones carry on.
 * The old train is unpinned and the new one pinned on the same tick.
 */
export function switchTrain(ctx: RunCtx, p: PlayerState, trainId: string | undefined): void {
  const { state, map, config } = ctx;
  const run = state.run;
  if (!run) return reject(ctx, p.id, 'switchTrain', 'no run');
  const h = horseOf(state, p);
  const id = trainId ?? switchTarget(state, map, config, h);
  if (!id) return reject(ctx, p.id, 'switchTrain', run.phase === 'aboard' || run.phase === 'extracting' || run.phase === 'ended' ? 'aboard' : 'no train in range');
  const why = switchCheck(state, map, config, h, id);
  if (why) return reject(ctx, p.id, 'switchTrain', why);
  const from = run.trainId;
  unpinTrain(state, from);
  pinTrain(state, id, p.id);
  run.trainId = id;
  // Loot and guards come from the train's own layouts, so the new train gets its own; what the
  // player already carries (after being thrown off another train) stays with them.
  const train = state.world.trains.find((t) => t.id === id)!;
  run.loot = generateLoot(state, config, train);
  run.nextLootId = run.loot.length;
  run.guards = generateGuards(state, config, train);
  ctx.emit({ type: 'TrainSwitched', tick: state.tick, player: p.id, from, to: id });
}

/**
 * With `commit.autoSwitch` on (trainSwitch variant `auto`), a run that can switch moves to the
 * nearest other free train once it is within `commit.rangeTiles` and `autoSwitchMarginTiles`
 * closer than the committed train, as auto-commit does for an idle rider.
 */
export function autoSwitchSystem(ctx: RunCtx): void {
  const { state, map, config } = ctx;
  const c = config.values.commit;
  const run = state.run;
  if (!c.autoSwitch || !run || (run.phase !== 'approach' && run.phase !== 'boarding')) return;
  for (const p of state.players) {
    if (!run.players[p.id]) continue;
    const h = horseOf(state, p);
    const id = switchTarget(state, map, config, h);
    if (!id) continue;
    const d = distanceToTrain(state, map, config, id, h.x, h.y);
    if (d <= c.rangeTiles && d + c.autoSwitchMarginTiles <= distanceToTrain(state, map, config, run.trainId, h.x, h.y)) {
      switchTrain(ctx, p, id);
      return;
    }
  }
}

/** Put the player back on the horse in the world frame, stopped, at (x, y) facing (hx, hy). */
export function remount(state: GameState, p: PlayerState, x: number, y: number, hx: number, hy: number): void {
  const h = horseOf(state, p);
  Object.assign(h, { x, y, hx, hy, speed: 0, cruiseTarget: 0, stunTicks: 0, boostTicks: 0, boostCooldownTicks: 0, mode: 'physical' as const });
  p.placement = { frame: WORLD_FRAME, x, y, layer: 'ground' };
}

/**
 * Health ran out: the day ends and the next starts at full health (the rider is already back at
 * the spawn). With `health.scope: run` the next commit would refill it anyway; the day still counts.
 * Saved runs from in-place cancels belong to the day that ended.
 */
function newDay(ctx: RunCtx, p: PlayerState, onRun: boolean): void {
  const tick = ctx.state.tick;
  ctx.emit({ type: 'DayEnded', tick, player: p.id, day: p.day, cause: 'died', onRun });
  p.day += 1;
  p.health = ctx.config.values.health.max;
  p.hitCooldownTicks = 0;
  p.lastHitDamage = 0;
  p.resumeRuns = [];
  p.commitHold = null;
  p.commitTimer = null;
  ctx.emit({ type: 'DayStarted', tick, player: p.id, day: p.day, health: p.health });
}

/** Cancel's reset: mounted and stopped at playerSpawn, facing up the screen toward the track. */
function resetToSpawn(ctx: RunCtx, p: PlayerState): void {
  const s = ctx.map.playerSpawn;
  remount(ctx.state, p, s.x, s.y, 0, -1);
}

/**
 * End the run: `ended`, apply the outcome to persistent state, unpin the train, then `idle`.
 * `cashOut` is the loot value the run would bank (an extraction: the carried value after any spill);
 * it goes into the bank and lifetime earned when the outcome's policy has `bankRunLoot`.
 */
export function endRun(ctx: RunCtx, p: PlayerState, outcome: RunOutcome, retry: boolean, cashOut = 0, endOfLine = false): void {
  const { state } = ctx;
  const run = state.run;
  if (!run) return;
  setPhase(ctx, p.id, 'ended');
  const banked = ctx.config.values.outcomePolicy[outcome].bankRunLoot ? cashOut : 0;
  // What the robbery left behind: every item still in the train, searched or not.
  const left = run.loot.filter((l) => !l.taken);
  const lootLeftValue = left.reduce((n, l) => n + (ctx.config.values.items[l.item]?.value ?? 0), 0);
  ctx.emit({
    type: 'RunEnded', tick: state.tick, player: p.id, outcome, durationTicks: state.tick - run.startedTick,
    boardingAttempts: run.players[p.id]?.boardingAttempts ?? 0, retry,
    countdownLeftSec: ctx.config.values.countdown.enabled ? Math.round(run.countdownSec * 1000) / 1000 : null, heat: run.heat, cashOut: banked,
    lootLeftValue, lootLeftItems: left.length,
    ...(endOfLine ? { endOfLine: true as const } : {}),
  });
  const before = state.persistent;
  const after = applyOutcome(before, outcome, ctx.config.values.outcomePolicy, banked);
  if (after.wantedLevel !== before.wantedLevel || after.bank !== before.bank || after.lifetimeEarned !== before.lifetimeEarned) {
    state.persistent = after;
    ctx.emit({ type: 'PersistentChanged', tick: state.tick, before, after });
  }
  unpinTrain(state, run.trainId);
  // Saved runs only survive an in-place cancel, which puts them back after this.
  for (const q of state.players) q.resumeRuns = [];
  setPhase(ctx, p.id, 'idle');
  state.run = null;
  // Every free train gets the layouts of the next run's seed.
  repickFreeTrains(state, ctx.config);
}

/**
 * Esc: accepted in every phase but `ended`. Aboard it goes back to playerSpawn while the train keeps
 * looping. Still on the horse (approach, or stunned after a failed jump) with `commit.cancelInPlace`
 * the rider keeps riding where they are, and the train just left only commits again on E until
 * they ride out of its commit range (`PlayerState.commitHold`).
 */
export function cancelRun(ctx: RunCtx, p: PlayerState): void {
  const phase = runPhase(ctx.state);
  if (phase === 'idle' || phase === 'ended') return reject(ctx, p.id, 'cancelRun', 'no run');
  const run = ctx.state.run!;
  const left = run.trainId;
  const inPlace = phase !== 'aboard' && phase !== 'extracting' && ctx.config.values.commit.cancelInPlace;
  const rp = run.players[p.id];
  const resume: ResumeRun | null = inPlace && rp ? {
    trainId: left, startedTick: run.startedTick, countdownSec: run.countdownSec, countdownTotalSec: run.countdownTotalSec,
    clockRunning: run.clockRunning, ...(run.clockTo !== undefined ? { clockTo: run.clockTo } : {}), graceTicks: run.graceTicks, heat: run.heat, pendingHeat: run.pendingHeat,
    health: p.health, meter: { ...rp.meter }, boardingAttempts: rp.boardingAttempts,
  } : null;
  const saved = p.resumeRuns;
  endRun(ctx, p, 'cancelled', false);
  if (inPlace) {
    p.commitHold = left;
    p.commitTimer = null;
    p.resumeRuns = [...saved.filter((r) => r.trainId !== left), ...(resume ? [resume] : [])];
  } else resetToSpawn(ctx, p);
}

/**
 * F, on the horse during a run (Devlin, 2026-10-19): get away with what you carry. The run ends
 * `cashedOut`, banking the carried value, and the rider keeps riding where they are. With
 * `cashOut.closeDoors` the train shuts its doors: no commit or switch to it for
 * `cashOut.doorsReopenSec` (0: for the rest of the session).
 */
export function cashOut(ctx: RunCtx, p: PlayerState): void {
  const { state, config } = ctx;
  const cfg = config.values.cashOut;
  if (!cfg.enabled) return reject(ctx, p.id, 'cashOut', 'disabled');
  const run = state.run;
  const rp = run?.players[p.id];
  if (!run || !rp || run.phase === 'ended') return reject(ctx, p.id, 'cashOut', 'no run');
  if (p.placement.frame !== WORLD_FRAME) return reject(ctx, p.id, 'cashOut', 'not mounted');
  if (rp.carried.length === 0) return reject(ctx, p.id, 'cashOut', 'nothing to cash out');
  const train = state.world.trains.find((t) => t.id === run.trainId);
  endRun(ctx, p, 'cashedOut', false, carriedValue(config, rp.carried));
  if (train && cfg.closeDoors) shutDoors(ctx, train);
}

/** Shut a train's doors for `cashOut.doorsReopenSec` (0: for good); a later shut restarts the wait. */
function shutDoors(ctx: RunCtx, train: TrainState): void {
  const ticks = ctx.config.values.cashOut.doorsReopenTicks;
  train.doorsClosed = { untilTick: ticks > 0 ? ctx.state.tick + ticks : null };
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
  const train = ctx.state.world.trains.find((t) => t.id === f?.trainId);
  if (f && train) return p.placement.y < carTemplate(carCatalog(ctx.config), train.cars[f.car]!).size.rows / 2 ? 'left' : 'right';
  let side: Side = 'left', best = Infinity;
  for (const car of carPosesOf(ctx.state, ctx.map, ctx.config, trainId)) {
    const dx = h.x - car.x, dy = h.y - car.y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; side = sideOf(car, h.x, h.y); }
  }
  return side;
}

/** Track centre to the waiting horse beyond the car's side, so it lines up inside boarding range of the doors. */
const RETRY_SIDE_GAP = 1.5;

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
  // A quick retry is a fresh start: no saved run from an in-place cancel carries into it.
  for (const q of state.players) { q.resumeRuns = []; q.commitHold = null; }
  const train = state.world.trains.find((t) => t.id === trainId)!;
  const { route } = routeOf(map, config, train);
  let d = train.d - trainLengthOf(config, train) - config.values.playtest.quickRetryGapTiles;
  // An open line runs off the map at both ends: wait where the track is still on it.
  if (!route.closed) { const r = onMapRange(map, route); d = Math.max(r.from, Math.min(d, r.to)); }
  const at = trackAt(route, d);
  const last = carTemplate(carCatalog(config), train.cars[train.cars.length - 1]!);
  // Left of travel is (ty, -tx).
  const off = last.size.rows / 2 + RETRY_SIDE_GAP;
  const s = side === 'left' ? off : -off;
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
    // Aboard, Space is the mount jump, which the extraction system samples.
    if (run.phase === 'aboard' || run.phase === 'extracting') continue;
    if (run.phase !== 'approach') { if (jumped) reject(ctx, p.id, 'jump', 'aboard'); continue; }

    // A shut train (thrown off with `cashOut.closeDoorsOnThrownOff`) cannot be boarded: the meter parks.
    if (doorsClosed(state, state.world.trains.find((t) => t.id === run.trainId)!)) {
      if (jumped) reject(ctx, p.id, 'jump', 'doors closed');
      advanceMeter(rp.meter, 'too far', b.meter);
      continue;
    }
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
    // A perfect landing stays in the doorway; a good one staggers in, into the open.
    if (result === 'good') stumbleIn(state, config, p, b.landing.goodStumbleInTiles);
    rp.crouched = false;
    Object.assign(rp, freshRoofState());
    // The riderless horse runs off for `horse.runOffSec`, then leaves the world (U4).
    run.horse = { ...freshHorseCall(), state: 'leaving', ticks: config.values.horse.runOffTicks };
    // The mount meter starts parked with fresh zones at its own widths.
    rollMeterZones(state, rp.meter, config.values.extraction.meter.zoneWidths);
    setPhase(ctx, p.id, 'aboard');
    return;
  }
  // Thrown clear: the horse is stunned at reduced speed while the train pulls ahead.
  h.stunTicks = b.failure.stunTicks;
  h.speed *= b.failure.horseSpeedScale;
  h.cruiseTarget = h.speed;
  const amount = config.values.health.max * b.failure.damageFraction;
  if (amount > 0) {
    p.health = Math.max(0, p.health - amount);
    ctx.emit({ type: 'DamageDealt', tick: state.tick, target: p.id, amount, health: p.health, cause: 'boarding' });
  }
}

/** Steps a player who just landed at a side door up to `tiles` in toward the car's middle row, stopping short of anything in the way. */
function stumbleIn(state: GameState, config: SimConfig, p: PlayerState, tiles: number): void {
  const f = parseCarFrame(p.placement.frame);
  if (!f || tiles <= 0) return;
  const cars = trainCars(state, f.trainId);
  const grid = trainGrid(config, cars);
  const rows = carTemplate(carCatalog(config), cars[f.car]!).size.rows;
  const pl = p.placement, lx = toTrain(grid, f.car, pl.x);
  const dir = Math.sign(rows / 2 - pl.y);
  const STEP = 0.1;
  for (let moved = STEP; moved <= tiles + 1e-9 && dir !== 0; moved += STEP) {
    const y = pl.y + dir * STEP;
    if (!walkerFits(grid, lx, y)) break;
    pl.y = y;
  }
}

/** How far beyond the car's side wall a thrown-off rider lands, in tiles (clear of the car, inside boarding range of its doors). */
const THROWN_SIDE_GAP = 1.5;

/** True when a horse at (x, y) would stand clear of blocked ground. */
function clearOfRocks(map: WorldMap, x: number, y: number): boolean {
  const r = HORSE_RADIUS;
  return [[-r, -r], [r, -r], [-r, r], [r, r], [0, 0]].every(([dx, dy]) => !isSolid(terrainAt(map, x + dx!, y + dy!)));
}

/**
 * guardCatch `thrown-off`: an alert guard caught the player, who is thrown off the train like a
 * failed boarding (G4, G5). They land back on the horse beside their car on the side they were
 * nearest, facing along the track at `boarding.failure.horseSpeedScale` of the train's speed, stunned
 * for `boarding.failure.stunSec` and losing `damageFraction` of max health. The run goes back to
 * `boarding` (the failed jump's stun), then `approach`; `ai.thrownOffLootShare` of the loot carried
 * goes over the side (all of it by default, Devlin's PR #36 playtest; `ai.fellLootShare` in a fall). With `guard` null it is a fall (`cause`: a rock knocked them off a ledge, O4, or
 * a bad roof jump or a slip on a curve, sneaking PR 3): the same landing, with `FellOff` instead of
 * `ThrownOff`, and the horse is put down clear of the rocks.
 */
export function throwOff(ctx: RunCtx, p: PlayerState, guard: number | null, fall: FallCause = 'rock'): void {
  const { state, map, config } = ctx;
  const run = state.run;
  const rp = run?.players[p.id];
  const f = parseCarFrame(p.placement.frame);
  if (!run || !rp || !f || (run.phase !== 'aboard' && run.phase !== 'extracting')) return;
  const car = carPosesOf(state, map, config, f.trainId)[f.car]!;
  const rows = car.halfWidth * 2, cols = car.halfLength * 2;
  const left = p.placement.y < rows / 2;
  // Away from the car's ends, so the next car on a bend cannot overlap the landing spot.
  const x = Math.max(2, Math.min(cols - 2, p.placement.x));
  let at = carToWorld(car, x, left ? -THROWN_SIDE_GAP : rows + THROWN_SIDE_GAP);
  if (!clearOfRocks(map, at.x, at.y)) {
    // Toward the car's front first: the rock has already passed there. Then further out.
    search: for (const out of [THROWN_SIDE_GAP, THROWN_SIDE_GAP + 1.5, THROWN_SIDE_GAP + 3]) {
      for (const back of [0, -2, -4, -6, 2, 4]) {
        const q = carToWorld(car, Math.max(2, Math.min(cols - 2, x + back)), left ? -out : rows + out);
        if (clearOfRocks(map, q.x, q.y)) { at = q; break search; }
      }
    }
  }
  const train = state.world.trains.find((t) => t.id === f.trainId)!;
  const b = config.values.boarding;
  // You land back on your horse beside the train (G5): wherever it was (running off, or coming
  // after a whistle), it is placed under you, and any call is over.
  run.horse = freshHorseCall();
  remount(state, p, at.x, at.y, car.ux, car.uy);
  const h = horseOf(state, p);
  h.speed = trainSpeed(config, train.type) * b.failure.horseSpeedScale;
  h.cruiseTarget = h.speed;
  h.stunTicks = b.failure.stunTicks;
  rp.search = null;
  rp.stumbleTicks = 0;
  rp.crouched = false;
  Object.assign(rp, freshRoofState());
  if (guard === null) ctx.emit({ type: 'FellOff', tick: state.tick, player: p.id, car: f.car, cause: fall });
  else ctx.emit({ type: 'ThrownOff', tick: state.tick, player: p.id, guard, car: f.car });
  const cause = guard === null ? 'fell' as const : 'thrownOff' as const;
  // Some of what you carry goes over the side with you: a share, picked at random (the `ai` stream).
  const share = guard === null ? config.values.ai.fellLootShare : config.values.ai.thrownOffLootShare;
  const lose = Math.ceil(rp.carried.length * share - 1e-9);
  for (let k = 0; k < lose; k++) {
    const [item] = rp.carried.splice(nextInt(state.rng, 'ai', rp.carried.length), 1) as [string];
    const def = config.values.items[item]!;
    ctx.emit({ type: 'LootLost', tick: state.tick, player: p.id, item, value: def.value, weight: def.weight, cause });
  }
  setPhase(ctx, p.id, 'boarding');
  // The train shuts its doors behind you: cash out (F) or switch to another train.
  // A fall off a ledge leaves them open unless `outside.scrape.closeDoors` (Devlin, 2026-10-21).
  if (guard === null ? config.values.outside.scrape.closeDoors : config.values.cashOut.closeDoorsOnThrownOff) shutDoors(ctx, train);
  const amount = config.values.health.max * b.failure.damageFraction;
  if (amount > 0) {
    p.health = Math.max(0, p.health - amount);
    ctx.emit({ type: 'DamageDealt', tick: state.tick, target: p.id, amount, health: p.health, cause });
  }
}

/**
 * Tick system 5b, after walking aboard: trackside rocks against a player on a ledge (O4). Blocked
 * ground `outside.scrape.glanceTiles` outward of them scrapes them for the collision scrape damage
 * (once per `collision.cooldownSec`, shared with riding hits); blocked ground right under them knocks
 * them off with `scrape.knockOff` on (else it scrapes too), a fall that lands them on the horse like
 * being thrown off.
 * Returns the player to knock off, or null.
 */
export function ledgeRockSystem(ctx: RunCtx): PlayerState | null {
  const { state, map, config } = ctx;
  const run = state.run;
  if (!run || (run.phase !== 'aboard' && run.phase !== 'extracting')) return null;
  const o = config.values.outside;
  for (const p of state.players) {
    const rp = run.players[p.id];
    const f = parseCarFrame(p.placement.frame);
    if (!rp || !f || f.trainId !== run.trainId || playerSpace(state, config, p) !== Space.Ledge) continue;
    const car = carPosesOf(state, map, config, f.trainId)[f.car];
    if (!car) continue;
    const { x, y } = p.placement;
    const out = y < 0 ? -1 : 1;
    const under = carToWorld(car, x, y);
    const struck = terrainAt(map, under.x, under.y) === Terrain.Blocked;
    if (struck && o.scrape.knockOff) return p;
    const edge = carToWorld(car, x, y + out * o.scrape.glanceTiles);
    // A glancing hit, or a solid one with knock-off turned off, only scrapes.
    if (!struck && terrainAt(map, edge.x, edge.y) !== Terrain.Blocked) continue;
    const c = config.values.collision;
    const amount = c.scrapeDamageFraction > 0 ? Math.max(1, Math.round(config.values.health.max * c.scrapeDamageFraction)) : 0;
    if (amount <= 0 || p.hitCooldownTicks > 0) continue;
    p.health = Math.max(0, p.health - amount);
    p.hitCooldownTicks = c.cooldownTicks;
    p.lastHitDamage = amount;
    ctx.emit({ type: 'DamageDealt', tick: state.tick, target: p.id, amount, health: p.health, cause: 'collision', against: 'obstacle', kind: 'scrape', impact: 0 });
  }
  return null;
}

/** C aboard: crouch or stand up. Refused unless the player is walking the committed train. */
export function crouch(ctx: RunCtx, p: PlayerState, on: boolean): void {
  const rp = ctx.state.run?.players[p.id];
  if (!rp || (ctx.state.run!.phase !== 'aboard' && ctx.state.run!.phase !== 'extracting') || !parseCarFrame(p.placement.frame)) return reject(ctx, p.id, 'crouch', 'not aboard');
  rp.crouched = on;
}

/**
 * C, handlingModel `arcade-boost`: start a boost on a ridden horse that is not stunned and has
 * no boost running or cooling down. The riding system applies it.
 */
export function boost(ctx: RunCtx, p: PlayerState): void {
  const { state, config } = ctx;
  const cfg = config.values.horse.boost;
  if (!cfg.enabled) return reject(ctx, p.id, 'boost', 'disabled');
  const h = horseOf(state, p);
  if (h.mode !== 'physical' || p.placement.frame !== WORLD_FRAME) return reject(ctx, p.id, 'boost', 'not mounted');
  if (h.stunTicks > 0) return reject(ctx, p.id, 'boost', 'stunned');
  if (h.boostTicks > 0 || h.boostCooldownTicks > 0) return reject(ctx, p.id, 'boost', 'cooling down');
  h.boostTicks = cfg.durationTicks;
  ctx.emit({ type: 'HorseBoosted', tick: state.tick, player: p.id });
}

/**
 * Health a contact costs (Devlin, 2026-10-11): scraping a train car below `collision.minImpactTilesPerSec`
 * costs `scrapeDamageFraction` of max health; a harder hit scales from that up to `damageFraction`
 * for a car (`obstacleDamageFraction` for blocked ground) at `fullImpactTilesPerSec` and above (train
 * hits raised to 45%, Devlin's playtest, 2026-10-12). A soft touch of blocked ground is free. Whole health points, at least 1 for any contact that hurts.
 */
export function collisionDamage(c: SimConfig['values']['collision'], maxHealth: number, target: Impact['target'], impact: number): number {
  const scrape = maxHealth * c.scrapeDamageFraction, full = maxHealth * (target === 'train' ? c.damageFraction : c.obstacleDamageFraction);
  if (impact < c.minImpactTilesPerSec) return target === 'train' && scrape > 0 ? Math.max(1, Math.round(scrape)) : 0;
  if (full <= 0) return 0;
  const span = c.fullImpactTilesPerSec - c.minImpactTilesPerSec;
  const t = span > 0 ? Math.min(1, (impact - c.minImpactTilesPerSec) / span) : 1;
  return Math.max(1, Math.round(scrape + (full - scrape) * t));
}

/**
 * After riding: on a run, contact with a train car or blocked ground costs `collisionDamage`. After
 * a hit, contacts for `collision.cooldownTicks` only cost what they exceed the last hit by, so one
 * crash or a long scrape is charged once per cooldown and a crash right after a scrape still hurts
 * in full. Off a run, with `health.scope: day`, only a crash at `offRunMinImpactTilesPerSec` or
 * harder hurts, costing the same as on a run (Devlin, 2026-10-28); with `run` riding about idle is free.
 */
export function collisionSystem(ctx: RunCtx, impacts: readonly Impact[]): void {
  const { state, config } = ctx;
  const run = state.run;
  const c = config.values.collision;
  const offRunHurts = config.values.health.scope === 'day';
  for (const p of state.players) if (p.hitCooldownTicks > 0) p.hitCooldownTicks -= 1;
  for (const i of impacts) {
    const p = state.players.find((q) => q.id === i.player);
    if (!p) continue;
    const onRun = !!run?.players[p.id];
    if (!onRun && (!offRunHurts || i.impact < c.offRunMinImpactTilesPerSec)) continue;
    const full = collisionDamage(c, config.values.health.max, i.target, i.impact);
    const amount = p.hitCooldownTicks > 0 ? full - p.lastHitDamage : full;
    if (amount <= 0) continue;
    p.health = Math.max(0, p.health - amount);
    p.hitCooldownTicks = c.cooldownTicks;
    p.lastHitDamage = full;
    ctx.emit({
      type: 'DamageDealt', tick: state.tick, target: i.player, amount, health: p.health, cause: 'collision', against: i.target,
      kind: i.impact < c.minImpactTilesPerSec ? 'scrape' : 'crash', impact: i.impact,
    });
  }
}

/**
 * H, with `playtest.debugHeatStep` above 0: raise heat by that step, cause `debug`. With a source
 * (Shift+H: `alarmRaised`), raise what that source gives instead, as if the event happened.
 */
export function debugHeat(ctx: RunCtx, p: PlayerState, source: HeatSource | undefined): void {
  const step = ctx.config.values.playtest.debugHeatStep;
  if (!(step > 0)) return reject(ctx, p.id, 'debugHeat', 'disabled');
  if (!ctx.state.run || ctx.state.run.phase === 'ended') return reject(ctx, p.id, 'debugHeat', 'no run');
  // Logged commands are untrusted input, so only a known source counts.
  if (source !== undefined && HEAT_SOURCES.includes(source)) raiseHeatFor(ctx, source);
  else raiseHeat(ctx, step, 'debug');
}

/**
 * Tick system 11, run end: a player at no health dies; otherwise a run whose countdown is at zero
 * expires once the grace window no longer holds it (U3), and on an open line a run whose train
 * reaches the end of the line expires there too (the law gets on in the next town). All of them
 * then reset as cancel does.
 */
export function runEndSystem(ctx: RunCtx): void {
  const run = ctx.state.run;
  for (const p of ctx.state.players) {
    if (p.health > 0) continue;
    const onRun = !!run?.players[p.id];
    if (onRun) endRun(ctx, p, 'died', false);
    resetToSpawn(ctx, p);
    newDay(ctx, p, onRun);
    return;
  }
  if (!run) return;
  for (const p of ctx.state.players) {
    if (run.players[p.id] && countdownExpired(ctx, p)) {
      endRun(ctx, p, 'expired', false);
      resetToSpawn(ctx, p);
      return;
    }
  }
  const train = ctx.map.openLine ? ctx.state.world.trains.find((t) => t.id === run.trainId) : undefined;
  if (train && atLineEnd(ctx.map, ctx.config, train)) {
    for (const p of ctx.state.players) {
      if (!run.players[p.id]) continue;
      endRun(ctx, p, 'expired', false, 0, true);
      resetToSpawn(ctx, p);
      return;
    }
  }
}
