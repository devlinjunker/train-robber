// What the views need from the sim's roof state (sneaking PR 3): where the player is on a ladder,
// and where a roof jump now would come down.
import { carriedWeight, carrySpeedScale, gridWalkable, roofCarAt, toTrain, trainGrid, trainLadders, type GameState, type PlayerState, type SimConfig } from '@train-robber/sim';

/** A point in one car's frame of the run's train. */
export interface CarPoint { car: number; x: number; y: number }

/** Climbing: the ladder's foot in its car's frame, and how far up you are (0 at the foot, 1 at the top). */
export function climbPose(state: Readonly<GameState>, config: SimConfig, p: PlayerState): (CarPoint & { progress: number }) | null {
  const rp = state.run?.players[p.id];
  const train = state.run && state.world.trains.find((t) => t.id === state.run!.trainId);
  if (!rp?.climb || !train) return null;
  const c = rp.climb;
  const done = 1 - c.ticks / Math.max(1, config.values.outside.roof.climbTicks);
  // A side ladder (boarded from the horse, issue #60): you hang where you landed, outside the long wall.
  if (c.side) return { car: c.car, x: p.placement.x, y: p.placement.y, progress: done };
  const l = trainLadders(config, train.cars).find((q) => q.car === c.car && q.end === c.end);
  if (!l) return null;
  const g = trainGrid(config, train.cars);
  return { car: l.car, x: l.deckLx - g.offsets[l.car]!, y: l.y, progress: c.to === 'roof' ? done : 1 - done };
}

/**
 * Where a roof jump comes down: in the air, where this one lands; running on a roof, where one now
 * would. `roof` lands on a roof, `drop` falls short onto a platform, the coupling or a ledge, `fall`
 * goes off the train. Null standing still, off the roof or mid-climb or slip. Mirrors the sim's
 * `roofJump` and `comeDown`.
 */
export function jumpLanding(state: Readonly<GameState>, config: SimConfig, p: PlayerState, car: number): (CarPoint & { kind: 'roof' | 'drop' | 'fall' }) | null {
  const rp = state.run?.players[p.id];
  const train = state.run && state.world.trains.find((t) => t.id === state.run!.trainId);
  if (!rp || !train || p.placement.layer !== 'roof' || rp.climb || rp.slip) return null;
  let dx: number, dy: number;
  if (rp.air) { dx = rp.air.vx * rp.air.ticks; dy = rp.air.vy * rp.air.ticks; }
  else {
    let mx = -p.move.x / 127, my = p.move.y / 127;
    const n = Math.hypot(mx, my);
    if (n < 0.05) return null;
    if (n > 1) { mx /= n; my /= n; }
    const rc = config.values.outside.roof;
    const base = rc.speedTilesPerTick * carrySpeedScale(config, carriedWeight(config, rp.carried));
    const speed = rp.crouched ? base * config.values.player.crouch.speedScale : base * Math.min(1, n);
    const air = Math.max(1, rc.jump.airTicks);
    const step = (speed + rc.jump.pushTiles / air) * air;
    const m = Math.hypot(mx, my);
    dx = (mx / m) * step; dy = (my / m) * step;
  }
  const g = trainGrid(config, train.cars);
  const x = p.placement.x + dx, y = p.placement.y + dy;
  const lx = toTrain(g, car, x);
  const k = roofCarAt(g, lx);
  const kind = k >= 0 && y >= 0 && y < g.carRows[k]! ? 'roof' : gridWalkable(g, lx, y) ? 'drop' : 'fall';
  return { car, x, y, kind };
}
