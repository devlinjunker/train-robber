// Headless bot sweep: many seeds, every steering and throttle variant, three kinds of rider,
// and a set of invariants checked after every tick. `npm run bots` runs it in CI.
import {
  boardingCheck, carriedWeight, commitTarget, createSim, nearestLoot, nextInt, parseCarFrame, pointInBox, seedRng, WORLD_FRAME,
  type Command, type GameState, type RngState, type Sim, type SimConfig,
} from '@train-robber/sim';
import type { MapDef } from '@train-robber/config';
import { loadConfig, loadMapDef } from './content';
import { riderCommands } from './golden';
import { ReportBuilder, type BoardingReport } from './report';

/**
 * `idle` sends nothing. `random` mashes every key at random (switching trains and the debug heat keys too), now and then quick retrying so it
 * meets the train. `chaser` quick retries, rides up to a door, commits, jumps after a random wait
 * so the meter results vary, loots aboard (walks to loot, holds E, sometimes drops something,
 * sometimes lets go early), and goes again.
 */
export type BotKind = 'idle' | 'random' | 'chaser';
export const BOT_KINDS: readonly BotKind[] = ['idle', 'random', 'chaser'];
// The carry flags and train mixes alternate with the combos, so both lootCarry variants and the map's
// own trains and mixed trains are swept without doubling the runs.
export const VARIANT_COMBOS = ['screen', 'heading'].flatMap((steering) => ['hold', 'coast', 'cruise'].map((throttleModel) => ({ steering, throttleModel })))
  .map((v, i) => ({ ...v, lootCarry: i % 2 ? 'unlimited' : 'limit-and-slowdown', trainMix: Math.floor(i / 2) % 2 ? 'mixed' : 'map' }));

export interface BotSweepOptions { seeds: number; seconds: number; kinds?: readonly BotKind[]; map?: MapDef }
export interface Violation { seed: string; bot: BotKind; variants: string; tick: number; message: string }
export interface BotSweepResult { runs: number; ticks: number; violations: Violation[]; reports: Record<BotKind, BoardingReport> }

const EPS = 1e-6;

/** Everything that must hold after any tick, whatever the input; the first broken rule, or null. */
export function checkInvariants(sim: Sim, config: SimConfig): string | null {
  const s = sim.state as GameState;
  const v = config.values;
  const cars = sim.cars();
  for (const h of s.world.horses) {
    for (const k of ['x', 'y', 'hx', 'hy', 'speed'] as const) if (!Number.isFinite(h[k])) return `horse ${h.id} ${k} is ${h[k]}`;
    if (Math.abs(Math.hypot(h.hx, h.hy) - 1) > 1e-3) return `horse ${h.id} heading length ${Math.hypot(h.hx, h.hy)}`;
    if (h.speed < -EPS || h.speed > v.horse.maxSpeed + EPS) return `horse ${h.id} speed ${h.speed}`;
    if (h.x < 0 || h.y < 0 || h.x > sim.map.cols || h.y > sim.map.rows) return `horse ${h.id} off the map at (${h.x}, ${h.y})`;
    if (h.mode === 'physical') {
      for (const car of cars) if (pointInBox(h.x, h.y, car)) return `horse ${h.id} inside car ${car.trainId}:${car.index} at (${h.x}, ${h.y})`;
    }
  }
  const run = s.run;
  if (run && !s.world.trains.some((t) => t.id === run.trainId && t.pinnedBy !== null)) return `committed train ${run.trainId} is not pinned`;
  if (!run && s.world.trains.some((t) => t.pinnedBy !== null)) return 'a train is pinned with no run';
  if (s.world.trains.filter((t) => t.pinnedBy !== null).length > 1) return 'more than one train is pinned';
  if (run?.phase === 'ended') return 'a run was left in ended';
  if (run) {
    if (!(run.heat >= 0 && run.heat <= v.heat.maxHeat)) return `heat ${run.heat} outside 0 to ${v.heat.maxHeat}`;
    if (!(run.countdownSec >= 0 && run.countdownSec <= run.countdownTotalSec)) return `countdown ${run.countdownSec} outside 0 to ${run.countdownTotalSec}`;
    if (run.countdownSec === 0 && run.clockRunning) return 'a run is still live with no time left';
  }
  for (const p of s.players) {
    const h = s.world.horses.find((q) => q.id === p.horseId)!;
    const rp = run?.players[p.id];
    if (rp) {
      if (!(rp.health > 0 && rp.health <= v.health.max)) return `player ${p.id} health ${rp.health} in a live run`;
      if (rp.meter.phase < 0 || rp.meter.phase >= 1 || rp.meter.zoneCentre < 0 || rp.meter.zoneCentre > 1) return `player ${p.id} meter ${JSON.stringify(rp.meter)}`;
    }
    if (p.placement.frame === WORLD_FRAME) {
      if (h.mode !== 'physical') return `player ${p.id} in the world on an ${h.mode} horse`;
      if (run?.phase === 'aboard') return `player ${p.id} in the world while aboard`;
    } else {
      const f = parseCarFrame(p.placement.frame);
      if (!f || f.trainId !== run?.trainId || run.phase !== 'aboard') return `player ${p.id} in ${p.placement.frame} in phase ${run?.phase ?? 'idle'}`;
      if (!sim.world.walkable(s, p.placement)) return `player ${p.id} on an unwalkable cell (${p.placement.x}, ${p.placement.y}) of ${p.placement.frame}`;
      if (h.mode === 'physical') return `player ${p.id} aboard with the horse still physical`;
    }
    if (rp) {
      for (const id of rp.carried) if (!v.items[id]) return `player ${p.id} carries unknown item ${id}`;
      if (v.carry.limitEnabled) {
        const w = carriedWeight(config, rp.carried);
        if (w > v.carry.maxWeight + EPS) return `player ${p.id} carries ${w} over the weight limit`;
        if (rp.carried.length > v.carry.maxItems) return `player ${p.id} carries ${rp.carried.length} items, over the limit`;
      }
      if (rp.search) {
        const l = run!.loot.find((q) => q.id === rp.search!.loot);
        if (!l || l.taken) return `player ${p.id} searching loot ${rp.search.loot}, which is gone`;
        if (run!.phase !== 'aboard') return `player ${p.id} searching in phase ${run!.phase}`;
      }
    }
  }
  if (run) {
    const ids = new Set(run.loot.map((l) => l.id));
    if (ids.size !== run.loot.length) return 'duplicate loot ids';
    for (const l of run.loot) if (!v.items[l.item]) return `loot ${l.id} is unknown item ${l.item}`;
  }
  return null;
}

const AXIS = [-127, 0, 127];
const axis = (rng: RngState) => AXIS[nextInt(rng, 'misc', 3)]!;

type Brain = (sim: Sim, t: number) => Command[];

function randomBot(rng: RngState): Brain {
  return (sim, t) => {
    const c: Command[] = [];
    if (t === 0 || nextInt(rng, 'misc', 20 * 60) === 0) c.push({ type: 'quickRetry' });
    if (t % 15 === 0) c.push({ type: 'move', x: axis(rng), y: nextInt(rng, 'misc', 3) === 0 ? axis(rng) : -127 }, { type: 'steer', x: axis(rng), y: axis(rng) });
    const roll = nextInt(rng, 'misc', 1000);
    if (roll < 15) c.push({ type: 'jump' });
    else if (roll < 18) c.push({ type: 'interact', held: true });
    else if (roll < 20) c.push({ type: 'interact', held: false });
    else if (roll < 22) c.push({ type: 'startRun' });
    else if (roll < 23) c.push({ type: 'cancelRun' });
    else if (roll < 25) c.push({ type: 'switchTrain' });
    else if (roll < 27) c.push({ type: 'drop', slot: nextInt(rng, 'misc', 4) - 1 });
    // Heat from the debug keys, so the heat range and the faster drain see play.
    else if (roll < 30) c.push(roll < 29 ? { type: 'debugHeat' } : { type: 'debugHeat', source: 'alarmRaised' });
    // Keep it in sight of the track: the stadium sits between y 30 and 170 on alpha-flats.
    const h = (sim.state as GameState).world.horses[0]!;
    if (h.y > sim.map.rows - 20 || h.y < 20 || h.x < 20 || h.x > sim.map.cols - 20) c.push({ type: 'quickRetry' });
    return c;
  };
}

function chaserBot(rng: RngState, config: SimConfig): Brain {
  let eligibleFor = 0, waitTicks = 0, aboardFor = 0;
  let last = { x: 0, y: 0 };
  return (sim, t) => {
    const s = sim.state as GameState;
    const h = s.world.horses[0]!;
    const c: Command[] = [];
    const move = (x: number, y: number) => { if (x !== last.x || y !== last.y) { c.push({ type: 'move', x, y }); last = { x, y }; } };
    if (t === 0) { c.push({ type: 'quickRetry' }); return c; }
    if (s.run?.phase === 'aboard') {
      aboardFor++;
      const p = s.players[0]!;
      const rp = s.run.players[1]!;
      // Walk to the nearest loot in this car (+x is toward the front, lower cell x) and hold E on it.
      const l = nearestLoot(s, p, 99);
      if (l && aboardFor < 60 * 12) {
        const dx = l.x - p.placement.x, dy = l.y - p.placement.y;
        if (Math.hypot(dx, dy) > 0.8) {
          // Now and then wander instead, to get round props.
          if (aboardFor % 60 < 15) { if (aboardFor % 15 === 1) move(axis(rng), axis(rng)); }
          else move(Math.abs(dx) > 0.15 ? (dx > 0 ? -127 : 127) : 0, Math.abs(dy) > 0.15 ? (dy > 0 ? 127 : -127) : 0);
          if (p.interactHeld) c.push({ type: 'interact', held: false });
        } else {
          move(0, 0);
          // Sometimes let go early, losing the progress.
          if (!p.interactHeld) c.push({ type: 'interact', held: true });
          else if (nextInt(rng, 'misc', 200) === 0) c.push({ type: 'interact', held: false });
        }
      } else if (aboardFor % 20 === 1) move(axis(rng), axis(rng));
      if (p.interactHeld && !rp.search && rp.searchLatched) c.push({ type: 'interact', held: false });
      if (rp.carried.length && nextInt(rng, 'misc', 600) === 0) c.push({ type: 'drop', slot: nextInt(rng, 'misc', rp.carried.length) });
      if (aboardFor > 60 * (14 + nextInt(rng, 'misc', 4))) { aboardFor = 0; move(0, 0); c.push({ type: 'interact', held: false }, { type: 'quickRetry' }); }
      return c;
    }
    if (!s.run) {
      if (commitTarget(s, sim.map, config, h)) c.push({ type: 'interact', held: true });
      else if (t % 1800 === 0) c.push({ type: 'quickRetry' });
    }
    // Ride for a train with loot (mixed trains put blank decoys first), else the first.
    const trainId = s.run?.trainId ?? (s.world.trains.find((q) => config.values.trains[q.type]?.loot) ?? s.world.trains[0]!).id;
    if (s.run?.phase === 'boarding') return c;
    const check = boardingCheck(s, sim.map, config, trainId, h);
    if (t % 10 === 0) { const r = riderCommands(sim, config, trainId, check.side); move(r.x, r.y); }
    if (s.run && check.state === 'eligible') {
      if (eligibleFor++ === 0) waitTicks = 1 + nextInt(rng, 'misc', 90);
      if (eligibleFor >= waitTicks) { c.push({ type: 'jump' }); eligibleFor = 0; }
    } else eligibleFor = 0;
    return c;
  };
}

export function brainFor(kind: BotKind, seed: string, config: SimConfig): Brain {
  const rng = seedRng(`bot-${kind}-${seed}`);
  if (kind === 'random') return randomBot(rng);
  if (kind === 'chaser') return chaserBot(rng, config);
  return () => [];
}

/** Runs every bot kind over `seeds` seeds, cycling the variant combos; stops a run at its first violation. */
export function runBotSweep(opts: BotSweepOptions): BotSweepResult {
  const map = opts.map ?? loadMapDef();
  const kinds = opts.kinds ?? BOT_KINDS;
  const configs = VARIANT_COMBOS.map((variants) => loadConfig({ preset: 'alpha-default', variants }));
  const ticks = Math.round(opts.seconds * configs[0]!.values.sim.tickRateHz);
  const reports = {} as Record<BotKind, ReportBuilder>;
  for (const k of kinds) reports[k] = new ReportBuilder(configs[0]!.values.sim.tickRateHz);
  const violations: Violation[] = [];
  let runs = 0, total = 0;
  for (let i = 0; i < opts.seeds; i++) {
    const config = configs[i % configs.length]!;
    const variants = `${config.variants.steering}+${config.variants.throttleModel}+${config.variants.lootCarry}+${config.variants.trainMix}`;
    const seed = `bots-${i}`;
    for (const bot of kinds) {
      const sim = createSim({ config, map, seed, playerIds: [1] });
      const brain = brainFor(bot, seed, config);
      runs++;
      for (let t = 0; t < ticks; t++) {
        let message: string | null;
        try {
          const r = sim.step([{ player: 1, commands: brain(sim, t) }]);
          for (const e of r.events) reports[bot].add(e);
          message = checkInvariants(sim, config);
        } catch (e) {
          message = `threw: ${(e as Error).stack ?? String(e)}`;
        }
        total++;
        if (message) { violations.push({ seed, bot, variants, tick: sim.state.tick, message }); break; }
      }
    }
  }
  const out = {} as Record<BotKind, BoardingReport>;
  for (const k of kinds) out[k] = reports[k].r;
  return { runs, ticks: total, violations, reports: out };
}

export interface BenchResult { ticks: number; meanUs: number; p99Us: number; maxUs: number }

/**
 * Tick-time benchmark: the chaser bot (riding, commits, jumps and walking aboard all exercised)
 * over a few seeds on the real map, after a warm-up so the JIT has settled. Only `step` is timed.
 */
export function benchTicks(opts: { seeds?: number; seconds?: number } = {}): BenchResult {
  const map = loadMapDef();
  const config = loadConfig();
  const ticks = Math.round((opts.seconds ?? 120) * config.values.sim.tickRateHz);
  const times: number[] = [];
  for (let i = -1; i < (opts.seeds ?? 3); i++) {
    const seed = `bench-${i}`;
    const sim = createSim({ config, map, seed, playerIds: [1] });
    const brain = brainFor('chaser', seed, config);
    for (let t = 0; t < ticks; t++) {
      const inputs = [{ player: 1, commands: brain(sim, t) }];
      const t0 = performance.now();
      sim.step(inputs);
      if (i >= 0) times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return { ticks: times.length, meanUs: (sum / times.length) * 1000, p99Us: times[Math.floor(times.length * 0.99)]! * 1000, maxUs: times[times.length - 1]! * 1000 };
}
