// Distractions (core loop PR, Devlin 2026-11-10: a single-player way to get at a guarded prize).
// G aboard throws a rock the way you are moving; guards near where it lands go to look there.
import type { GameState, PlayerState, SimConfig, SimEvent } from '../types';
import { parseCarFrame } from './frames';
import { fromTrain, gridCell, hearDistraction, toTrain, trainGrid, type TrainGrid } from './guards';

/** What throwing needs from the tick; `RunCtx` satisfies it. */
export interface ThrowCtx {
  state: GameState;
  config: SimConfig;
  emit(ev: SimEvent): void;
}

export type ThrowRejection = 'not aboard' | 'disabled' | 'no rocks left' | 'on the roof' | 'busy' | 'standing still';

const axis = (v: number) => (v < -127 ? -127 : v > 127 ? 127 : v | 0) / 127;
/** Steps along the throw, in tiles: well under a cell, so a one-cell wall stops it. */
const STEP = 0.2;

/**
 * Where a rock thrown from train point (lx, y) along unit (ux, uy) lands: up to `range` tiles away,
 * stopped just short of the first cell that blocks movement (a wall, a window, a crate) or the
 * edge of the train. Returns the landing point in train coordinates.
 */
export function throwLanding(g: TrainGrid, lx: number, y: number, ux: number, uy: number, range: number): { lx: number; y: number } {
  let best = { lx, y };
  for (let d = STEP; d <= range + 1e-9; d += STEP) {
    const px = lx + ux * d, py = y + uy * d;
    const i = gridCell(g, px, py);
    if (i < 0 || g.blocksMove[i]) break;
    best = { lx: px, y: py };
  }
  return best;
}

/** How many rocks a player has left this run. */
export function rocksLeft(config: SimConfig, used: number): number {
  return Math.max(0, config.values.verbs.throw.perRun - used);
}

/**
 * G, `throw`: throw a rock the way the player is moving (car frame, like walking). Refused off a
 * run or the train, on a roof, mid-climb or jump, standing still, or with no rocks left.
 */
export function throwRock(ctx: ThrowCtx, p: PlayerState, reject: (why: ThrowRejection) => void): void {
  const { state, config } = ctx;
  const run = state.run;
  const rp = run?.players[p.id];
  const f = parseCarFrame(p.placement.frame);
  const t = config.values.verbs.throw;
  if (t.perRun <= 0) return reject('disabled');
  if (!run || !rp || !f || f.trainId !== run.trainId || (run.phase !== 'aboard' && run.phase !== 'extracting')) return reject('not aboard');
  if (p.placement.layer === 'roof') return reject('on the roof');
  if (rp.climb || rp.air) return reject('busy');
  if (rocksLeft(config, rp.throwsUsed) <= 0) return reject('no rocks left');
  const mx = -axis(p.move.x), my = axis(p.move.y);
  const n = Math.sqrt(mx * mx + my * my);
  if (n === 0) return reject('standing still');
  const train = state.world.trains.find((q) => q.id === f.trainId)!;
  const g = trainGrid(config, train.cars);
  const land = throwLanding(g, toTrain(g, f.car, p.placement.x), p.placement.y, mx / n, my / n, t.rangeTiles);
  rp.throwsUsed += 1;
  const heard = hearDistraction(ctx, g, land.lx, land.y, t.noiseRadiusTiles, t.checkTicks);
  const at = fromTrain(g, land.lx);
  ctx.emit({ type: 'DistractionThrown', tick: state.tick, player: p.id, car: at.car, x: at.x, y: land.y, heard, left: rocksLeft(config, rp.throwsUsed) });
}
