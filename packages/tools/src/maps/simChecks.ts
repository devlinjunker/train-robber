// Checks that run the sim on a map: its trains start, a full lap runs, and no two trains touch;
// on an open line, trains enter and leave and a whole run plays through.
// Shared by the hand-made maps test and the generated maps test.
import type { MapDef } from '@train-robber/config';
import { boardingCheck, carCatalog, routeOf, Terrain, terrainAt, trackAt, carTemplate, cellOpen, commitTarget, mountCheck, createSim, distanceToTrain, meterResult, parseCarFrame, type Command, type GameState, type Sim, type SimConfig } from '@train-robber/sim';
import { loadConfig } from '../content';
import { checkInvariants } from '../bots';
import { riderCommands } from '../golden';

/** The map's own trains (trainMix `map`), not the default mixed trains. */
const mapTrainsConfig = () => loadConfig({ preset: 'map-trains' });
type Config = ReturnType<typeof mapTrainsConfig>;
/** The slowest train speed in tiles per tick, so a lap at it covers every train's route. */
const slowest = (config: Config) => Math.min(...Object.values(config.values.trains).map((t) => t.speedTilesPerTick));
const lapTicks = (map: MapDef, config: Config) => Math.ceil(Math.max(...map.routes.map((r) => r.length)) / slowest(config));

/** Spawn mounted at playerSpawn, start the map's trains, and run a full lap of the longest route. */
export function lapProblems(map: MapDef, seed: string, config = mapTrainsConfig()): string[] {
  const out: string[] = [];
  const sim = createSim({ config, map, seed, playerIds: [1] });
  const h = sim.state.world.horses[0];
  if (!h || h.x !== map.markers.playerSpawn.x || h.y !== map.markers.playerSpawn.y || h.speed !== 0) out.push('rider does not start still at playerSpawn');
  const trains = map.trains?.length ?? 1;
  if (sim.state.world.trains.length !== trains) out.push(`${sim.state.world.trains.length} trains, expected ${trains}`);
  for (let t = 0, n = lapTicks(map, config); t < n; t++) sim.step([{ player: 1, commands: [] }]);
  // Engine, its cars and the caboose, if any, for each train.
  const carsOf = (type: string) => { const d = config.values.trains[type]!; return 1 + d.carCount + (d.caboose ? 1 : 0); };
  const want = sim.state.world.trains.reduce((n, t) => n + carsOf(t.type), 0);
  if (sim.cars().length !== want) out.push(`${sim.cars().length} cars after a lap, expected ${want}`);
  return out;
}

/** Over a lap, every car of each train stays more than 12 tiles from every car of the others. */
export function trainGapProblems(map: MapDef, seed: string, config = mapTrainsConfig()): string[] {
  const out: string[] = [];
  const sim = createSim({ config, map, seed, playerIds: [1] });
  for (let t = 0, n = lapTicks(map, config); t < n && out.length < 10; t += 30) {
    const cars = sim.cars();
    for (const a of cars) for (const b of cars) {
      if (a.trainId < b.trainId && !(Math.hypot(a.x - b.x, a.y - b.y) > 12)) out.push(`${a.trainId} and ${b.trainId} touch at tick ${t}`);
    }
    for (let k = 0; k < 30; k++) sim.step([{ player: 1, commands: [] }]);
  }
  return out;
}

/**
 * An open line's traffic over the time a train takes to run the whole line: trains enter at the
 * start a headway apart and leave past the end, the number running stays steady, and no two touch.
 */
export function lineTrafficProblems(map: MapDef, seed: string, config = mapTrainsConfig()): string[] {
  const out: string[] = [];
  if (!map.openLine) return ['not an open line'];
  const sim = createSim({ config, map, seed, playerIds: [1] });
  const start = sim.state.world.trains.length;
  if (start < 2) out.push(`${start} trains at the start`);
  const seen = new Set(sim.state.world.trains.map((t) => t.id));
  let left = 0;
  for (let t = 0, n = lapTicks(map, config); t < n && out.length < 10; t++) {
    const before = new Set(sim.state.world.trains.map((q) => q.id));
    sim.step([{ player: 1, commands: [] }]);
    const now = sim.state.world.trains;
    for (const id of before) if (!now.some((q) => q.id === id)) left++;
    for (const q of now) seen.add(q.id);
    if (Math.abs(now.length - start) > 1) out.push(`${now.length} trains at tick ${t}, started with ${start}`);
    if (t % 30 === 0) {
      const cars = sim.cars();
      for (const a of cars) for (const b of cars) {
        if (a.trainId < b.trainId && !(Math.hypot(a.x - b.x, a.y - b.y) > 12)) out.push(`${a.trainId} and ${b.trainId} touch at tick ${t}`);
      }
    }
  }
  if (left < start - 1) out.push(`only ${left} trains left the line`);
  if (seen.size < start * 2 - 1) out.push(`only ${seen.size - start} trains entered`);
  return out;
}

/**
 * A whole run on an open line, scripted like the golden run: line up behind the nearest train
 * (quick retry), ride up, commit, jump on a tick the meter lands, walk to the nearest loot and
 * search it, whistle, walk to a door on the horse's side and mount: the run ends extracted. The default preset with every train a mail train and guards that only raise heat, so the
 * script is not thrown off; the bot sweep's invariants hold on every tick. A run that ends any
 * other way (the script crashed into the train, or lost the horse) is retried, up to `maxRuns`.
 */
export function lineRunProblems(map: MapDef, seed: string, seconds = 600, log?: (line: string) => void, maxRuns = 3): string[] {
  const config = loadConfig({ preset: 'alpha-default', variants: { trainMix: 'map', guardCatch: 'heat-only' } });
  const sim = createSim({ config, map, seed, playerIds: [1] });
  const s = sim.state as GameState;
  const h = s.world.horses[0]!;
  const seen = new Set<string>();
  // Loot given up on: a guard who only raises heat can stand in the one way to it for good.
  const skipped = new Set<number>();
  let runs = 0, retry = false;
  let whistledAt = -1, lootId = -1, walkStuck = 0, sidestep = 0, sidesteps = 0, sideDir = 127, prev = { x: 0, y: 0 };
  let guards = 0, last = { x: 0, y: 0 }, stuckFor = 0, eligibleFor = 0, side: 'left' | 'right' = 'left', target: string | null = null;
  for (let t = 0, n = seconds * config.values.sim.tickRateHz; t < n; t++) {
    const commands: Command[] = [];
    const move = (x: number, y: number) => { if (x !== last.x || y !== last.y) { commands.push({ type: 'move', x, y }); last = { x, y }; } };
    // A guard or a corner can block a step, so a walk that stalls sidesteps for a moment.
    const trackStall = (pl: { x: number; y: number }) => {
      const walking = last.x !== 0 || last.y !== 0;
      walkStuck = walking && sidestep === 0 && Math.hypot(pl.x - prev.x, pl.y - prev.y) < 0.005 ? walkStuck + 1 : 0;
      prev = { x: pl.x, y: pl.y };
      if (walkStuck > 10) { sidestep = 20; walkStuck = 0; sideDir = -sideDir; sidesteps++; }
    };
    // Walk cell by cell along a shortest path through the car (in its frame, x is mirrored on the stick).
    const walkTo = (pl: { frame: string; x: number; y: number }, to: { x: number; y: number }) => {
      const step = nextCell(sim, config, pl, to);
      const sx = step.x - pl.x, sy = step.y - pl.y;
      const mx = Math.abs(sx) > 0.1 ? (sx > 0 ? -127 : 127) : 0, my = Math.abs(sy) > 0.1 ? (sy > 0 ? 127 : -127) : 0;
      if (sidestep > 0) { sidestep--; move(mx ? 0 : sideDir, mx ? sideDir : 0); } else move(mx, my);
    };
    const p = s.players[0]!;
    if (seen.has('extracted') || runs >= maxRuns) break;
    if (t === 0 || retry || (!s.run && stuckFor > 240)) {
      commands.push({ type: 'quickRetry' }); stuckFor = 0; target = null; retry = false;
      whistledAt = -1; lootId = -1; skipped.clear();
    } else if (s.run?.phase === 'aboard') {
      const rp = s.run.players[1]!;
      // Keep to one piece of loot until it is taken, and stand still while searching it.
      const f = parseCarFrame(p.placement.frame);
      let l = rp.carried.length ? null : s.run.loot.find((q) => q.id === lootId && !q.taken && q.car === f?.car) ?? null;
      if (l && sidesteps > 4) { skipped.add(l.id); l = null; }
      if (!l && !rp.carried.length) {
        l = s.run.loot.filter((q) => !q.taken && q.car === f?.car && !skipped.has(q.id))
          .sort((a, b) => Math.hypot(a.x - p.placement.x, a.y - p.placement.y) - Math.hypot(b.x - p.placement.x, b.y - p.placement.y))[0] ?? null;
        if (l?.id !== lootId) sidesteps = 0;
        lootId = l?.id ?? -1;
      }
      const pl = p.placement;
      trackStall(pl);
      if (l) {
        if (rp.search) move(0, 0);
        else if (Math.hypot(l.x - pl.x, l.y - pl.y) > Math.min(0.8, config.values.verbs.search.reachTiles - 0.05)) walkTo(pl, l);
        else { move(0, 0); if (!p.interactHeld) commands.push({ type: 'interact', held: true }); }
        // A hidden stash is revealed by one search and taken by the next: let go, then hold again.
        if (p.interactHeld && !rp.search && rp.searchLatched) commands.push({ type: 'interact', held: false });
      } else if (!rp.carried.length) {
        // Nothing left in this car: walk through the train one way, then the other, to find more.
        move((Math.floor(t / 300) % 2 ? 127 : -127), sidestep-- > 0 ? sideDir : 0);
        if (p.interactHeld) commands.push({ type: 'interact', held: false });
      } else {
        // Loot in hand: let go of E and whistle for the horse.
        move(0, 0);
        if (p.interactHeld) commands.push({ type: 'interact', held: false });
        else if (whistledAt < 0 || t - whistledAt > 600) { commands.push({ type: 'whistle' }); whistledAt = t; }
      }
    } else if (s.run?.phase === 'extracting') {
      // Walk to the nearest door on the horse's side (through the train if this car has none) and
      // jump on a tick the mount meter lands; whistle again if the horse leaves.
      const pl = p.placement, f = parseCarFrame(pl.frame);
      const train = f && s.world.trains.find((q) => q.id === f.trainId);
      const doors = f && train ? carTemplate(carCatalog(config), train.cars[f.car]!).sideEntries.filter((e) => e.side === s.run!.horse.side) : [];
      const door = doors.map((e) => ({ x: e.cell[0] + 0.5, y: e.cell[1] + 0.5 })).sort((a, b) => Math.hypot(a.x - pl.x, a.y - pl.y) - Math.hypot(b.x - pl.x, b.y - pl.y))[0];
      trackStall(pl);
      if (door && Math.hypot(door.x - pl.x, door.y - pl.y) > 0.6) walkTo(pl, door);
      else if (!door && f && train) {
        // No door on that side here: walk through the train toward the nearest car with one (lower car numbers are toward the front, lower x).
        const sideOf = (c: number) => carTemplate(carCatalog(config), train.cars[c]!).sideEntries.some((e) => e.side === s.run!.horse.side);
        const cars = train.cars.map((_, c) => c).filter(sideOf).sort((a, b) => Math.abs(a - f.car) - Math.abs(b - f.car));
        const end = carTemplate(carCatalog(config), train.cars[f.car]!).entryPoints.find((e) => e.side === (cars[0] !== undefined && cars[0] > f.car ? 'rear' : 'front'));
        // Head for that end door by the shortest walk, then on through it.
        if (end) {
          const at = { x: end.cell[0] + 0.5, y: end.cell[1] + 0.5 };
          if (Math.hypot(at.x - pl.x, at.y - pl.y) > 0.6) walkTo(pl, at);
          else move(end.side === 'rear' ? -127 : 127, 0);
        }
      }
      else move(0, 0);
      const rp = s.run.players[1]!;
      if (mountCheck(s, sim.map, config, p).state === 'eligible' && meterResult(rp.meter, config.values.extraction.meter.zoneWidths).result !== 'fail') commands.push({ type: 'jump' });
      if (s.run.horse.state === 'away' && t - whistledAt > 600) { commands.push({ type: 'whistle' }); whistledAt = t; }
    } else if (s.run?.phase !== 'boarding') {
      target ??= s.run?.trainId ?? nearestTrain(sim, config);
      if (!s.world.trains.some((q) => q.id === target)) target = nearestTrain(sim, config);
      if (!s.run && commitTarget(s, sim.map, config, h) === target) commands.push({ type: 'interact', held: true });
      if (t % 30 === 1) side = openSide(sim, config, target, h, side);
      if (t % 10 === 0) { const c = riderCommands(sim, config, target, side); move(c.x, c.y); }
      stuckFor = h.speed < 1 ? stuckFor + 1 : 0;
      if (s.run && boardingCheck(s, sim.map, config, target, h).state === 'eligible') eligibleFor++;
      else eligibleFor = 0;
      if (eligibleFor >= 10 && jumpLands(sim, config)) { commands.push({ type: 'jump' }); eligibleFor = 0; }
      if (s.run && stuckFor > 240) { commands.push({ type: 'cancelRun' }); stuckFor = 0; }
    }
    let r;
    try { r = sim.step([{ player: 1, commands }]); } catch (e) { return [`threw at tick ${t}: ${(e as Error).message}`]; }
    for (const e of r.events) {
      if (log && e.type !== 'HeatChanged') log(JSON.stringify(e));
      seen.add(e.type);
      if (e.type === 'BoardingAttempt' && e.result !== 'fail') seen.add('boarded');
      // A cancel (stuck on the approach) lines up again; any other end counts as a run, and all but extracted try again.
      if (e.type === 'RunEnded' && e.outcome !== 'cancelled') { runs++; retry = true; }
      if (e.type === 'RunEnded' && e.outcome === 'extracted') seen.add('extracted');
    }
    guards = Math.max(guards, s.run?.guards.length ?? 0);
    const broken = checkInvariants(sim, config);
    if (broken) return [`tick ${t}: ${broken}`];
  }
  const out: string[] = [];
  for (const want of ['RunStarted', 'boarded', 'LootPickedUp', 'HorseWhistled', 'extracted']) if (!seen.has(want)) out.push(`no ${want} in ${runs} run(s), ${seconds} s`);
  if (!guards) out.push('no guards aboard');
  return out;
}

function nearestTrain(sim: Sim, config: SimConfig): string {
  const s = sim.state as GameState, h = s.world.horses[0]!;
  let best = s.world.trains[0]!.id, bestD = Infinity;
  for (const t of s.world.trains) {
    const d = distanceToTrain(s, sim.map, config, t.id, h.x, h.y);
    if (d < bestD) { bestD = d; best = t.id; }
  }
  return best;
}

/** True when a jump on the next tick would land (good or perfect): the jump samples the meter as it stands. */
function jumpLands(sim: Sim, config: SimConfig): boolean {
  const rp = sim.state.run?.players[1];
  return !!rp && meterResult(rp.meter, config.values.boarding.meter.zoneWidths).result !== 'fail';
}

/** The centre of the next cell on a shortest walk through the player's car to `to` (both in its frame), or `to` itself. */
function nextCell(sim: Sim, config: SimConfig, from: { frame: string; x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  const f = parseCarFrame(from.frame);
  const train = f && sim.state.world.trains.find((t) => t.id === f.trainId);
  if (!f || !train) return to;
  const tpl = carTemplate(carCatalog(config), train.cars[f.car]!);
  const { cols, rows } = tpl.size;
  const goal = Math.floor(to.y) * cols + Math.floor(to.x), start = Math.floor(from.y) * cols + Math.floor(from.x);
  // Go round the cells guards in this car stand in when there is a way round; else straight on.
  const guarded = new Set((sim.state.run?.guards ?? []).filter((g) => g.car === f.car).map((g) => Math.floor(g.y) * cols + Math.floor(g.x)));
  return pathStep(tpl, cols, rows, start, goal, guarded) ?? pathStep(tpl, cols, rows, start, goal, new Set()) ?? to;
}

function pathStep(tpl: ReturnType<typeof carTemplate>, cols: number, rows: number, start: number, goal: number, avoid: Set<number>): { x: number; y: number } | null {
  const back = new Int32Array(cols * rows).fill(-1);
  back[goal] = goal;
  const queue = [goal];
  // Search from the goal, so each cell knows its next step toward it.
  for (let q = 0; q < queue.length && back[start] === -1; q++) {
    const i = queue[q]!, x = i % cols, y = (i - x) / cols;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      if (back[j] !== -1 || ((!cellOpen(tpl, nx, ny) || avoid.has(j)) && j !== start)) continue;
      back[j] = i; queue.push(j);
    }
  }
  const next = back[start]!;
  // No way through, or already next to the goal (the caller then heads straight for it).
  if (next < 0 || next === goal) return null;
  return { x: (next % cols) + 0.5, y: Math.floor(next / cols) + 0.5 };
}

/**
 * The side of the track to ride: the one whose riding lane (4 to 5 tiles out) is open for the next
 * 30 tiles from the rider, keeping `current` when both are. Generated corridors keep one side open.
 */
function openSide(sim: Sim, config: SimConfig, trainId: string, h: { x: number; y: number }, current: 'left' | 'right'): 'left' | 'right' {
  const train = sim.state.world.trains.find((t) => t.id === trainId);
  if (!train) return current;
  const { route } = routeOf(sim.map, config, train);
  const { x: xs, y: ys } = route.samples;
  let i0 = 0, best = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = (xs[i]! - h.x) ** 2 + (ys[i]! - h.y) ** 2;
    if (d < best) { best = d; i0 = i; }
  }
  const open = (side: 'left' | 'right') => {
    const sign = side === 'left' ? 1 : -1;
    for (let k = 0; k * route.spacing <= 30; k += 2) {
      const at = trackAt(route, (i0 + k) * route.spacing);
      for (const off of [4, 4.5, 5]) if (terrainAt(sim.map, at.x + at.ty * off * sign, at.y - at.tx * off * sign) !== Terrain.Open) return false;
    }
    return true;
  };
  if (open(current)) return current;
  const other = current === 'left' ? 'right' : 'left';
  return open(other) ? other : current;
}
