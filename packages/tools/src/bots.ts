// Headless bot sweep: many seeds, every steering and throttle variant, three kinds of rider,
// and a set of invariants checked after every tick. `npm run bots` runs it in CI.
import {
  boardingCheck, carCatalog, carTemplate, carriedWeight, commitTarget, createSim, distanceToTrain, gridWalkable, onRoof, mountCheck, nearestLoot, nextInt, parseCarFrame, pointInBox, seedRng, toTrain, trainGrid, trainLadders, WORLD_FRAME,
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
// The carry flags, train mixes, guard catch and handling models alternate with the combos, so every
// option of those groups is swept without doubling the runs.
export const VARIANT_COMBOS = ['screen', 'heading'].flatMap((steering) => ['hold', 'coast', 'cruise'].map((throttleModel) => ({ steering, throttleModel })))
  .map((v, i) => ({
    ...v, lootCarry: i % 2 ? 'unlimited' : 'limit-and-slowdown', trainMix: Math.floor(i / 2) % 2 ? 'mixed' : 'map',
    guardCatch: i % 2 ? 'thrown-off' : 'heat-only', handlingModel: i % 3 === 2 ? 'arcade' : 'arcade-boost',
  }));

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
    const top = v.horse.maxSpeed * (v.horse.boost.enabled ? v.horse.boost.topSpeedScale : 1);
    if (h.speed < -EPS || h.speed > top + EPS) return `horse ${h.id} speed ${h.speed} over ${top}`;
    if (h.boostTicks < 0 || h.boostCooldownTicks < 0 || (!v.horse.boost.enabled && h.boostTicks > 0)) return `horse ${h.id} boost ${h.boostTicks}/${h.boostCooldownTicks}`;
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
      if (run?.phase === 'aboard' || run?.phase === 'extracting') return `player ${p.id} in the world while ${run.phase}`;
    } else {
      const f = parseCarFrame(p.placement.frame);
      if (!f || f.trainId !== run?.trainId || (run.phase !== 'aboard' && run.phase !== 'extracting')) return `player ${p.id} in ${p.placement.frame} in phase ${run?.phase ?? 'idle'}`;
      // Mid-jump you are over open air between roofs: only the landing has to be somewhere.
      if (!rp?.air && !sim.world.walkable(s, p.placement)) return `player ${p.id} on an unwalkable cell (${p.placement.x}, ${p.placement.y}) of ${p.placement.frame}`;
      // Aboard, the horse is in the world only while it runs off or comes when whistled (U4).
      if (h.mode === 'physical' && run.horse.state === 'away') return `player ${p.id} aboard with the horse physical but not called`;
      if (h.mode !== 'physical' && run.horse.state !== 'away') return `player ${p.id} aboard with the horse ${run.horse.state} but ${h.mode}`;
    }
    if (rp) {
      for (const id of rp.carried) if (!v.items[id]) return `player ${p.id} carries unknown item ${id}`;
      if (v.carry.limitEnabled) {
        const w = carriedWeight(config, rp.carried);
        if (w > v.carry.maxWeight + EPS) return `player ${p.id} carries ${w} over the weight limit`;
        if (rp.carried.length > v.carry.maxItems) return `player ${p.id} carries ${rp.carried.length} items, over the limit`;
      }
      if ((rp.air || rp.slip) && p.placement.layer !== 'roof') return `player ${p.id} ${rp.air ? 'in the air' : 'slipping'} off the roof`;
      if (rp.search) {
        const l = run!.loot.find((q) => q.id === rp.search!.loot);
        if (!l || l.taken) return `player ${p.id} searching loot ${rp.search.loot}, which is gone`;
        if (run!.phase !== 'aboard' && run!.phase !== 'extracting') return `player ${p.id} searching in phase ${run!.phase}`;
      }
    }
  }
  if (run) {
    if (run.phase === 'extracting' && run.horse.state !== 'approaching' && run.horse.state !== 'alongside') return `extracting with the horse ${run.horse.state}`;
    if (run.horse.state === 'alongside' && run.phase !== 'extracting') return `horse alongside in phase ${run.phase}`;
    const ids = new Set(run.loot.map((l) => l.id));
    if (ids.size !== run.loot.length) return 'duplicate loot ids';
    for (const l of run.loot) if (!v.items[l.item]) return `loot ${l.id} is unknown item ${l.item}`;
    // Guards stay on walkable cells of the committed train, facing a unit direction.
    const train = s.world.trains.find((t) => t.id === run.trainId)!;
    const grid = trainGrid(config, train.cars);
    for (const g of run.guards) {
      if (g.car < 0 || g.car >= train.cars.length) return `guard ${g.id} in car ${g.car} of a ${train.cars.length}-car train`;
      for (const k of ['x', 'y', 'fx', 'fy'] as const) if (!Number.isFinite(g[k])) return `guard ${g.id} ${k} is ${g[k]}`;
      if (!g.jump && (g.roof ? !onRoof(grid, g.car, g.x, g.y) : !gridWalkable(grid, toTrain(grid, g.car, g.x), g.y))) return `guard ${g.id} on an unwalkable ${g.roof ? 'roof spot' : 'cell'} (${g.x}, ${g.y}) of car ${g.car}`;
      if (Math.abs(Math.hypot(g.fx, g.fy) - 1) > 1e-3) return `guard ${g.id} facing length ${Math.hypot(g.fx, g.fy)}`;
    }
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
    else if (roll < 26) c.push({ type: 'whistle' });
    else if (roll < 27) c.push({ type: 'drop', slot: nextInt(rng, 'misc', 4) - 1 });
    // Heat from the debug keys, so the heat range and the faster drain see play.
    else if (roll < 30) c.push(roll < 29 ? { type: 'debugHeat' } : { type: 'debugHeat', source: 'alarmRaised' });
    else if (roll < 34) c.push({ type: 'boost' });
    // Ladders: refused unless at one, so the roofs get climbed now and then.
    else if (roll < 44) c.push({ type: 'climb' });
    // Keep it in sight of the track: the stadium sits between y 30 and 170 on alpha-flats.
    const h = (sim.state as GameState).world.horses[0]!;
    if (h.y > sim.map.rows - 20 || h.y < 20 || h.x < 20 || h.x > sim.map.cols - 20) c.push({ type: 'quickRetry' });
    return c;
  };
}

function chaserBot(rng: RngState, config: SimConfig): Brain {
  let eligibleFor = 0, waitTicks = 0, aboardFor = 0, stuckFor = 0;
  // Some boardings go up on the roofs instead of looting: out of the front door to the ladder, up,
  // then run about jumping now and then, and climb down at a ladder if one comes up.
  let roofer = false, roofFor = 0;
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
      if (aboardFor === 1) {
        // Only from a car with a ladder at its front end (outside.roof.ladderCarShare leaves some without).
        const f = parseCarFrame(p.placement.frame);
        const train = f && s.world.trains.find((tr) => tr.id === f.trainId);
        const ladder = !!f && !!train && trainLadders(config, train.cars).some((q) => q.car === f.car && q.end === 'front');
        roofer = config.values.outside.roof.enabled && ladder && nextInt(rng, 'misc', 3) === 0; roofFor = 0;
      }
      if (roofer && aboardFor < 60 * 12) {
        const pl = p.placement;
        if (pl.layer === 'roof') {
          roofFor++;
          if (roofFor % 30 === 1) move(axis(rng), axis(rng));
          if (nextInt(rng, 'misc', 90) === 0) c.push({ type: 'jump' });
          if (roofFor > 60 * 4 && nextInt(rng, 'misc', 20) === 0) c.push({ type: 'climb' });
        } else if (!rp.climb) {
          // Waypoints in the car's frame: the front end door's row, out onto the platform, then the ladder's row.
          const wp = pl.x > 0.6 ? { x: 0.5, y: 2.9 } : pl.x > -0.2 ? { x: -0.3, y: 2.9 } : { x: -0.35, y: 1.5 };
          const dx = wp.x - pl.x, dy = wp.y - pl.y;
          if (pl.x <= -0.2 && Math.abs(dy) < 0.1) { move(0, 0); c.push({ type: 'climb' }); }
          else if (aboardFor % 60 < 10) { if (aboardFor % 10 === 1) move(axis(rng), axis(rng)); }
          else move(Math.abs(dx) > 0.05 ? (dx > 0 ? -127 : 127) : 0, Math.abs(dy) > 0.05 ? (dy > 0 ? 64 : -64) : 0);
        }
        return c;
      }
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
      // After looting a while, whistle for the horse and get off.
      if (aboardFor === 60 * 8) { move(0, 0); c.push({ type: 'interact', held: false }, { type: 'whistle' }); }
      return c;
    }
    if (s.run?.phase === 'extracting') {
      // Walk to the nearest door on the horse's side and jump when the mount meter sweeps.
      aboardFor++;
      const p = s.players[0]!;
      const f = parseCarFrame(p.placement.frame)!;
      const train = s.world.trains.find((q) => q.id === f.trainId)!;
      const doors = carTemplate(carCatalog(config), train.cars[f.car]!).sideEntries.filter((e) => e.side === s.run!.horse.side);
      const d = doors.map((e) => ({ dx: e.cell[0] + 0.5 - p.placement.x, dy: e.cell[1] + 0.5 - p.placement.y })).sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy))[0];
      if (d && Math.hypot(d.dx, d.dy) > 0.6) move(Math.abs(d.dx) > 0.15 ? (d.dx > 0 ? -127 : 127) : 0, Math.abs(d.dy) > 0.15 ? (d.dy > 0 ? 127 : -127) : 0);
      else move(0, 0);
      if (mountCheck(s, sim.map, config, p).state === 'eligible') {
        if (eligibleFor++ === 0) waitTicks = 1 + nextInt(rng, 'misc', 90);
        if (eligibleFor >= waitTicks) { c.push({ type: 'jump' }); eligibleFor = 0; }
      } else eligibleFor = 0;
      if (aboardFor > 60 * 40) { aboardFor = 0; move(0, 0); c.push({ type: 'quickRetry' }); }
      return c;
    }
    aboardFor = 0;
    if (!s.run) {
      if (commitTarget(s, sim.map, config, h)) c.push({ type: 'interact', held: true });
      else if (t % 1800 === 0) c.push({ type: 'quickRetry' });
    }
    // On an open line the rider steers straight at the doors and can wedge itself on rocks for good
    // (a loop's train comes back round): after 4 s stuck, line up again.
    if (sim.map.openLine) {
      stuckFor = h.speed < 1 && s.run?.phase !== 'boarding' ? stuckFor + 1 : 0;
      if (stuckFor > 240) { stuckFor = 0; c.push({ type: 'quickRetry' }); }
    }
    // Ride for a train with loot (mixed trains put blank decoys first), else the first; on an open line the nearest.
    const trainId = s.run?.trainId ?? (sim.map.openLine ? lineTarget(sim, config, h) : (s.world.trains.find((q) => config.values.trains[q.type]?.loot) ?? s.world.trains[0]!).id);
    if (s.run?.phase === 'boarding') return c;
    const check = boardingCheck(s, sim.map, config, trainId, h);
    if (t % 10 === 0) { const r = riderCommands(sim, config, trainId, check.side); move(r.x, r.y); }
    // Boost now and then while catching up (rejected while cooling down or under handlingModel arcade).
    if (t % 240 === 120 && check.state === 'too far') c.push({ type: 'boost' });
    if (s.run && check.state === 'eligible') {
      if (eligibleFor++ === 0) waitTicks = 1 + nextInt(rng, 'misc', 90);
      if (eligibleFor >= waitTicks) { c.push({ type: 'jump' }); eligibleFor = 0; }
    } else eligibleFor = 0;
    return c;
  };
}

/** On an open line: the train with loot nearest the rider (trains leave the map, so the first one listed may be gone soon), else the nearest. */
function lineTarget(sim: Sim, config: SimConfig, h: { x: number; y: number }): string {
  const s = sim.state as GameState;
  let best: string | null = null, bestD = Infinity, any = s.world.trains[0]!.id, anyD = Infinity;
  for (const t of s.world.trains) {
    const d = distanceToTrain(s, sim.map, config, t.id, h.x, h.y);
    if (d < anyD) { anyD = d; any = t.id; }
    if (config.values.trains[t.type]?.loot && d < bestD) { bestD = d; best = t.id; }
  }
  return best ?? any;
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
    const variants = ['steering', 'throttleModel', 'lootCarry', 'trainMix', 'guardCatch', 'handlingModel'].map((g) => config.variants[g]).join('+');
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
 * It runs the default preset, whose thrown-off guard catch is the costlier one: alert guards path after the player.
 */
export function benchTicks(opts: { seeds?: number; seconds?: number } = {}): BenchResult {
  const map = loadMapDef();
  const config = loadConfig({ preset: 'alpha-default' });
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
