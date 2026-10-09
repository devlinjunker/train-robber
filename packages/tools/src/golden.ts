// Scripted golden run. `npm run golden:update` rewrites the checked-in replay
// after a deliberate sim change; the replay test then guards it.
import {
  boardingCheck, carPosesOf, commandLogWriter, commitTarget, createSim, mapHash, trackAt, trainSpeed,
  type Command, type GameState, type InputFrame, type RunHeader, type Sim, type SimConfig,
} from '@train-robber/sim';
import { DEFAULT_MAP, gameVersion, loadConfig, loadMapDef } from './content';

const TICKS = 2100;

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
 * a line 4 tiles out from the track centre toward the first car's door, closes the gap, then
 * holds the train's speed. Being a function of state is fine for a golden: the log records
 * the commands it chose, and a replay only reads those.
 */
function riderCommands(sim: Sim, config: SimConfig, trainId: string, side: 'left' | 'right'): { x: number; y: number } {
  const s = sim.state as GameState;
  const h = s.world.horses[0]!;
  const train = s.world.trains.find((t) => t.id === trainId)!;
  const route = sim.map.routes.get(config.values.trains[train.type]!.route)!;
  const door = carPosesOf(s, sim.map, config, trainId)[1]!;
  const doorD = routeDistance(route, door.x, door.y);
  const horseD = routeDistance(route, h.x, h.y);
  let gap = doorD - horseD;
  if (gap < -route.length / 2) gap += route.length;
  if (gap > route.length / 2) gap -= route.length;
  // Steer toward a point a few tiles ahead on the riding line.
  const aim = trackAt(route, horseD + 6);
  const off = side === 'left' ? 4 : -4;
  const ax = aim.x + aim.ty * off - h.x, ay = aim.y - aim.tx * off - h.y;
  const n = Math.hypot(ax, ay) || 1;
  const cross = (h.hx * ay - h.hy * ax) / n;
  const want = trainSpeed(config, train.type) + Math.max(-3, Math.min(5, gap * 0.6));
  const dv = want - h.speed;
  return { x: q(Math.round((cross * 600) / 32) * 32), y: Math.abs(dv) < 0.3 ? 0 : dv > 0 ? -127 : 127 };
}

export function recordGolden(): string {
  const config = loadConfig({ preset: 'alpha-default', variants: { boardingFailure: 'time-only' } });
  const map = loadMapDef(DEFAULT_MAP);
  const lines: string[] = [];
  const header: RunHeader = {
    gameVersion: gameVersion(), configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed: 'golden-1', mapId: map.id, mapHash: mapHash(map), tickRateHz: config.values.sim.tickRateHz, playerIds: [1],
    persistentAtStart: { wantedLevel: 1, bank: 120, lifetimeEarned: 450 }, startedAt: '2026-10-09T00:00:00Z',
  };
  const sim = createSim({ config, map, seed: header.seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
  const log = commandLogWriter(header, (l) => lines.push(l), { hashEveryTicks: config.values.logging.hashEveryTicks });
  const s = sim.state as GameState;
  const h = s.world.horses[0]!;
  let last = { x: 0, y: 0 };
  let eligibleFor = 0, aboardFor = 0, side: 'left' | 'right' = 'left';
  // Ride, steer and brake a little from the spawn, try to commit out of range, cancel nothing,
  // then quick retry behind the train, catch it, commit, and jump until aboard; walk, then cancel.
  for (let t = 0; t < TICKS; t++) {
    const commands: Command[] = [];
    const move = (x: number, y: number) => { if (x !== last.x || y !== last.y) { commands.push({ type: 'move', x, y }); last = { x, y }; } };
    if (t === 5) { commands.push({ type: 'startRun' }, { type: 'cancelRun' }); move(0, -127); }
    else if (t === 60) { commands.push({ type: 'steer', x: -127, y: 0 }); move(127, -127); }
    else if (t === 90) move(0, 127);
    else if (t === 120) commands.push({ type: 'quickRetry' });
    else if (t > 120) {
      const trainId = s.run?.trainId ?? s.world.trains[0]!.id;
      if (!s.run && aboardFor === 0) {
        if (commitTarget(s, sim.map, config, h)) commands.push({ type: 'interact', held: false });
      }
      if (s.run?.phase === 'aboard' || aboardFor > 0) {
        aboardFor++;
        if (aboardFor === 1) move(127, 127);
        else if (aboardFor === 40) move(-127, 0);
        else if (aboardFor === 90) { move(0, 0); commands.push({ type: 'cancelRun' }); }
      } else if (s.run?.phase !== 'boarding') {
        if (t === 121) side = boardingCheck(s, sim.map, config, trainId, h).side;
        // Like a person, the bot adjusts the keys a few times a second, not every tick.
        if (t % 10 === 0) { const c = riderCommands(sim, config, trainId, side); move(c.x, c.y); }
        if (s.run && boardingCheck(s, sim.map, config, trainId, h).state === 'eligible') eligibleFor++;
        else eligibleFor = 0;
        // Wait out a little of the sweep, then press Space.
        if (eligibleFor === 25) { commands.push({ type: 'jump' }); eligibleFor = 0; }
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
