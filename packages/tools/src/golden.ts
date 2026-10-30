// Scripted golden run. `npm run golden:update` rewrites the checked-in replay
// after a deliberate sim change; the replay test then guards it.
import {
  boardingCheck, carCatalog, carEntryPoints, carPosesOf, commandLogWriter, commitTarget, createSim, mapHash, nearestLoot, parseCarFrame, restoreSim, routeOf, trackAt, trainSpeed,
  type BoardingResult, type Command, type GameState, type InputFrame, type RunHeader, type Sim, type SimConfig, type SimMap,
} from '@train-robber/sim';
import { DEFAULT_MAP, loadConfig, loadMapDef } from './content';

/** Pinned so a version bump at each milestone does not re-record the fixture. */
export const GOLDEN_GAME_VERSION = '0.0.0';

const TICKS = 4200;

const q = (v: number) => Math.max(-127, Math.min(127, Math.round(v)));

/** Distance along the route of the sample nearest (x, y). Brute force; tools only. */
function routeDistance(route: Parameters<typeof trackAt>[0], x: number, y: number): number {
  const { x: xs, y: ys, s } = route.samples;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = (xs[i]! - x) ** 2 + (ys[i]! - y) ** 2;
    if (d < bestD) { bestD = d; best = s[i]!; }
  }
  return best;
}

/**
 * A rider bot for the default variants (heading-relative steering, coast throttle): it rides
 * a line 4 tiles out from the track centre toward the nearest door on its side, closes the gap,
 * then holds the train's speed. Being a function of state is fine for a golden: the log records
 * the commands it chose, and a replay only reads those.
 */
export function riderCommands(sim: Sim, config: SimConfig, trainId: string, side: 'left' | 'right'): { x: number; y: number } {
  const s = sim.state as GameState;
  const h = s.world.horses[0]!;
  const train = s.world.trains.find((t) => t.id === trainId)!;
  const { route } = routeOf(sim.map, config, train);
  const horseD = routeDistance(route, h.x, h.y);
  const catalog = carCatalog(config);
  const wrap = (g: number) => (g < -route.length / 2 ? g + route.length : g > route.length / 2 ? g - route.length : g);
  // Only some cars have a door on each side: aim for the nearest one there.
  let gap = Infinity, halfWidth = 3;
  for (const car of carPosesOf(s, sim.map, config, trainId)) {
    halfWidth = car.halfWidth;
    for (const ep of carEntryPoints(car, catalog)) {
      if (ep.side !== side) continue;
      const g = wrap(routeDistance(route, ep.x, ep.y) - horseD);
      if (Math.abs(g) < Math.abs(gap)) gap = g;
    }
  }
  if (gap === Infinity) gap = 0;
  // Steer toward a point a few tiles ahead on the riding line, a tile out from the car side.
  const aim = trackAt(route, horseD + 6);
  const off = (halfWidth + 1) * (side === 'left' ? 1 : -1);
  const ax = aim.x + aim.ty * off - h.x, ay = aim.y - aim.tx * off - h.y;
  const n = Math.hypot(ax, ay) || 1;
  const cross = (h.hx * ay - h.hy * ax) / n;
  const want = trainSpeed(config, train.type) + Math.max(-3, Math.min(5, gap * 0.6));
  const dv = want - h.speed;
  return { x: q(Math.round((cross * 600) / 32) * 32), y: Math.abs(dv) < 0.3 ? 0 : dv > 0 ? -127 : 127 };
}

/** The result a jump on the next tick would get, from a copy of the sim. */
function previewJump(sim: Sim, config: SimConfig, map: SimMap): BoardingResult | null {
  const copy = restoreSim(sim.snapshot(), config, map);
  const r = copy.step([{ player: 1, commands: [{ type: 'jump' }] }]);
  const e = r.events.find((q) => q.type === 'BoardingAttempt');
  return e?.type === 'BoardingAttempt' ? e.result : null;
}

export function recordGolden(): string {
  const config = loadConfig({ preset: 'alpha-default', variants: { boardingFailure: 'time-only', trainMix: 'map', guardCatch: 'heat-only' },
    // Pinned to the first three layouts so new mail-car layouts don't change the golden story.
    // Doors only (issue #60 added platforms and side ladders), so the jump story stays the same.
    overrides: { trains: { 'mail-express': { layouts: ['mail-car-a', 'mail-car-b', 'mail-car-c'] } }, boarding: { targets: { doors: true, platforms: false, sideLadders: false } } } });
  const map = loadMapDef(DEFAULT_MAP);
  const lines: string[] = [];
  const header: RunHeader = {
    gameVersion: GOLDEN_GAME_VERSION, configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed: 'golden-1', mapId: map.id, mapHash: mapHash(map), tickRateHz: config.values.sim.tickRateHz, playerIds: [1],
    persistentAtStart: { wantedLevel: 1, bank: 120, lifetimeEarned: 450 }, startedAt: '2026-10-09T00:00:00Z',
  };
  const sim = createSim({ config, map, seed: header.seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
  const log = commandLogWriter(header, (l) => lines.push(l), { hashEveryTicks: config.values.logging.hashEveryTicks });
  const s = sim.state as GameState;
  const h = s.world.horses[0]!;
  let last = { x: 0, y: 0 };
  let eligibleFor = 0, aboardFor = 0, side: 'left' | 'right' = 'left';
  let looted = false, hunt = 0, whistledAt = 0;
  // A guard can stand in the way aboard: when the walk stalls, sidestep for a moment.
  let prevX = 0, prevY = 0, stuckFor = 0, sidestep = 0;
  // Ride, boost, steer and brake a little from the spawn, try to commit out of range, cancel nothing,
  // then quick retry behind the train, catch it, commit, fail two jumps and land the third as
  // good; raise heat with the debug key, walk to the nearest loot, search it, creep crouched then walk
  // until a guard raises the alarm, whistle for the horse and watch it ride up, then cancel.
  for (let t = 0; t < TICKS; t++) {
    const commands: Command[] = [];
    const move = (x: number, y: number) => { if (x !== last.x || y !== last.y) { commands.push({ type: 'move', x, y }); last = { x, y }; } };
    if (t === 5) { commands.push({ type: 'startRun' }, { type: 'cancelRun' }); move(0, -127); }
    else if (t === 30) commands.push({ type: 'boost' });
    else if (t === 60) { commands.push({ type: 'steer', x: -127, y: 0 }); move(127, -127); }
    else if (t === 90) move(0, 127);
    else if (t === 120) commands.push({ type: 'quickRetry' });
    else if (t > 120) {
      const trainId = s.run?.trainId ?? s.world.trains[0]!.id;
      if (!s.run && aboardFor === 0) {
        if (commitTarget(s, sim.map, config, h)) commands.push({ type: 'interact', held: true });
      }
      if (s.run?.phase === 'aboard' || s.run?.phase === 'extracting' || aboardFor > 0) {
        aboardFor++;
        const p = s.players[0]!;
        const rp = s.run?.players[1];
        if (aboardFor === 20) commands.push({ type: 'debugHeat' });
        if (rp && !looted && rp.carried.length > 0) { looted = true; commands.push({ type: 'interact', held: false }); }
        if (!looted && aboardFor < 900) {
          // Walk to the nearest loot in this car (in the car's frame: +x toward the front, which
          // is lower cell x), then hold E on it until it is picked up.
          const l = nearestLoot(s, p, 99);
          const pl = p.placement;
          if (l && parseCarFrame(pl.frame)) {
            const dx = l.x - pl.x, dy = l.y - pl.y;
            stuckFor = Math.hypot(pl.x - prevX, pl.y - prevY) < 0.005 ? stuckFor + 1 : 0;
            prevX = pl.x; prevY = pl.y;
            if (stuckFor > 10) { sidestep = 30; stuckFor = 0; }
            const car = parseCarFrame(pl.frame)!.car;
            const g = s.run?.guards.find((q) => q.car === car && Math.hypot(q.x - pl.x, q.y - pl.y) < 1.5);
            if (sidestep > 0 && g) { sidestep--; move(Math.abs(dx) > 0.15 ? (dx > 0 ? -127 : 127) : 0, pl.y >= g.y ? 127 : -127); }
            else if (Math.hypot(dx, dy) > 0.8) move(Math.abs(dx) > 0.15 ? (dx > 0 ? -127 : 127) : 0, Math.abs(dy) > 0.15 ? (dy > 0 ? 127 : -127) : 0);
            else { move(0, 0); if (!p.interactHeld) commands.push({ type: 'interact', held: true }); }
          }
        } else if (looted && hunt >= 0 && parseCarFrame(p.placement.frame)) {
          // Creep toward the front crouched for a while, then stand and walk along row 4 into the
          // guarded cars until a guard raises the alarm; then whistle for the horse.
          hunt++;
          if (hunt === 1) commands.push({ type: 'crouch', on: true });
          if (hunt === 120) commands.push({ type: 'crouch', on: false });
          const dy = 4.5 - p.placement.y;
          move(127, Math.abs(dy) > 0.15 ? (dy > 0 ? 127 : -127) : 0);
          if (s.run?.guards.some((g) => g.state === 'alert') || hunt > 1500) { hunt = -1; whistledAt = aboardFor; move(0, 0); commands.push({ type: 'whistle' }); }
        } else if (aboardFor === (whistledAt ? whistledAt + 900 : looted ? -1 : 920)) { move(0, 0); commands.push({ type: 'cancelRun' }); }
      } else if (s.run?.phase !== 'boarding') {
        if (t === 121) side = boardingCheck(s, sim.map, config, trainId, h).side;
        // Like a person, the bot adjusts the keys a few times a second, not every tick.
        if (t % 10 === 0) { const c = riderCommands(sim, config, trainId, side); move(c.x, c.y); }
        if (s.run && boardingCheck(s, sim.map, config, trainId, h).state === 'eligible') eligibleFor++;
        else eligibleFor = 0;
        // Wait out a little of the sweep, then press Space on a tick that gives the result the
        // script wants: two fails, then a good landing. A throwaway copy of the sim previews it.
        if (eligibleFor >= 15 && previewJump(sim, config, map) === (s.run!.players[1]!.boardingAttempts < 2 ? 'fail' : 'good')) {
          commands.push({ type: 'jump' }); eligibleFor = 0;
        }
      }
    }
    const inputs: InputFrame[] = [{ player: 1, commands }];
    log.step(t, inputs);
    sim.step(inputs);
    log.checkpoint(t + 1, () => sim.hash());
  }
  log.end(TICKS, sim.hash());
  return lines.join('\n') + '\n';
}
