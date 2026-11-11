// The engine crew (G10 boarding plan): on the approach, the engine sees a rider inside a cone ahead
// of it and to its sides, out to `boarding.engineSight.rangeTiles` (less when riding slow), unless
// blocked ground stands between. Behind the engine is blind, so the quiet way in is from behind.
// Seen long enough, the crew spots the rider once per run: guards go to the ledge on the rider's
// side and watch, and the train speeds up for a while.
import type { HorseState, PlayerState, TrainSide } from '../types';
import type { RunCtx } from '../run';
import { sideOf } from './boarding';
import { Terrain, terrainAt, type WorldMap } from './map';
import { carPosesOf } from './trains';
import { alertGuardsToSide } from './guards';

/** Step along a sight line, in tiles. */
const SIGHT_STEP = 0.5;

/** True when nothing blocked lies on the straight line from (x0, y0) to (x1, y1). */
export function clearSight(map: WorldMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
  const n = Math.floor(len / SIGHT_STEP);
  for (let i = 1; i < n; i++) {
    const f = (i * SIGHT_STEP) / len;
    if (terrainAt(map, x0 + dx * f, y0 + dy * f) === Terrain.Blocked) return false;
  }
  return true;
}

/** Whether the engine of train `trainId` can see the horse now, and from which side of the train. */
export function engineSees(ctx: Pick<RunCtx, 'state' | 'map' | 'config'>, trainId: string, h: HorseState): { seen: boolean; side: TrainSide } {
  const es = ctx.config.values.boarding.engineSight;
  const engine = carPosesOf(ctx.state, ctx.map, ctx.config, trainId)[0];
  if (!engine || h.mode !== 'physical') return { seen: false, side: 'left' };
  const side = sideOf(engine, h.x, h.y);
  const dx = h.x - engine.x, dy = h.y - engine.y, d = Math.sqrt(dx * dx + dy * dy);
  const range = h.speed <= es.slowSpeedTilesPerTick * ctx.config.values.sim.tickRateHz ? es.slowRangeTiles : es.rangeTiles;
  if (d > range) return { seen: false, side };
  // Inside the cone: the angle from straight ahead is within the half angle (dot >= its cosine).
  if (d > 0 && (dx * engine.ux + dy * engine.uy) / d < es.coneCos) return { seen: false, side };
  return { seen: clearSight(ctx.map, engine.x, engine.y, h.x, h.y), side };
}

/**
 * Tick system 4a, after boarding: the engine crew's watch over the committed train's approach.
 * Counts the ticks in a row the rider is seen; at `seenAfterTicks` the crew spots them, once per run.
 */
export function engineSightSystem(ctx: RunCtx): void {
  const { state, config } = ctx;
  const es = config.values.boarding.engineSight;
  const run = state.run;
  if (!es.enabled || !run || run.phase !== 'approach' || run.engineSeen?.saw) return;
  let p: PlayerState | undefined, h: HorseState | undefined;
  for (const q of state.players) {
    if (!run.players[q.id]) continue;
    p = q; h = state.world.horses.find((x) => x.id === q.horseId);
    break;
  }
  if (!p || !h) return;
  const look = engineSees(ctx, run.trainId, h);
  const seen = run.engineSeen ?? { ticks: 0, saw: false };
  seen.ticks = look.seen ? seen.ticks + 1 : 0;
  if (look.seen || run.engineSeen) run.engineSeen = seen;
  if (seen.ticks < es.seenAfterTicks) return;
  seen.saw = true;
  ctx.emit({ type: 'EngineSaw', tick: state.tick, player: p.id, trainId: run.trainId, side: look.side });
  alertGuardsToSide(ctx, look.side, es.watchTicks);
  const train = state.world.trains.find((t) => t.id === run.trainId);
  if (train && es.speedUpScale > 1 && es.speedUpTicks > 0) train.speedUpTicks = es.speedUpTicks;
}
