// Committing to a train and the boarding rule: who can commit, who may jump, and the meter.
// The client only reads these; the decisions are the sim's.
import { nextU32 } from '../rng';
import type { BoardingResult, CommitRejection, GameState, HorseState, MeterState, SimConfig } from '../types';
import { CAR_TEMPLATES, entryPointWorld, type CarPose, type Side } from './cars';
import { distanceToBox } from './collide';
import type { WorldMap } from './map';
import { carPosesOf, trainSpeed } from './trains';

/** The boarding rule's verdict; anything but `eligible` is also the jump's rejection reason. */
export type BoardingState = 'eligible' | 'too far' | 'too fast' | 'too slow';

export interface BoardingCheck {
  state: BoardingState;
  /** Side of the train the horse is on, relative to the direction of travel. */
  side: Side;
  /** Nearest entry point on that side, or null when the train has none there. */
  car: number | null;
  entry: string | null;
  /** World position of that entry point. */
  at: { x: number; y: number } | null;
  /** Distance from the horse to it, in tiles. */
  distance: number;
  /** Horse speed along that car's direction of travel minus the train's speed, tiles/s. */
  speedDelta: number;
}

/** Which side of a car the point is on: left of travel is (uy, -ux), as in `entryPointWorld`. */
export function sideOf(car: CarPose, x: number, y: number): Side {
  return (x - car.x) * car.uy - (y - car.y) * car.ux >= 0 ? 'left' : 'right';
}

const scratch = { x: 0, y: 0 };

/**
 * The boarding rule: within `boarding.rangeTiles` of an entry point on the side the horse
 * is riding, and within `boarding.speedToleranceTilesPerSec` of the train's speed, measured
 * along that car's direction of travel. Too far wins over a speed mismatch.
 */
export function boardingCheck(state: GameState, map: WorldMap, config: SimConfig, trainId: string, h: HorseState): BoardingCheck {
  const b = config.values.boarding;
  const train = state.world.trains.find((t) => t.id === trainId);
  const cars = carPosesOf(state, map, config, trainId);
  const out: BoardingCheck = { state: 'too far', side: 'left', car: null, entry: null, at: null, distance: Infinity, speedDelta: 0 };
  if (!train || cars.length === 0) return out;
  // The side comes from the nearest car body, so a horse beside the engine still has one.
  let nearest = Infinity;
  for (const car of cars) {
    const d = distanceToBox(h.x, h.y, car);
    if (d < nearest) { nearest = d; out.side = sideOf(car, h.x, h.y); }
  }
  let best: CarPose | null = null;
  for (const car of cars) {
    for (const ep of CAR_TEMPLATES[car.template]!.entryPoints) {
      if (ep.side !== out.side) continue;
      entryPointWorld(car, ep, scratch);
      const dx = h.x - scratch.x, dy = h.y - scratch.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < out.distance) {
        out.distance = d; out.car = car.index; out.entry = ep.id; out.at = { x: scratch.x, y: scratch.y };
        best = car;
      }
    }
  }
  if (!best) return out;
  out.speedDelta = (h.hx * best.ux + h.hy * best.uy) * h.speed - trainSpeed(config, train.type);
  if (out.distance > b.rangeTiles) return out;
  const tol = b.speedToleranceTilesPerSec;
  out.state = out.speedDelta < -tol ? 'too slow' : out.speedDelta > tol ? 'too fast' : 'eligible';
  return out;
}

/** Distance from the horse to the nearest car of a train, in tiles. */
export function distanceToTrain(state: GameState, map: WorldMap, config: SimConfig, trainId: string, x: number, y: number): number {
  let best = Infinity;
  for (const car of carPosesOf(state, map, config, trainId)) best = Math.min(best, distanceToBox(x, y, car));
  return best;
}

/** Whether a mounted, idle player may commit to this train, or why not. */
export function commitCheck(state: GameState, map: WorldMap, config: SimConfig, h: HorseState, trainId: string): CommitRejection | null {
  if (state.run) return 'run active';
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) return 'no such train';
  if (t.pinnedBy !== null) return 'train taken';
  if (distanceToTrain(state, map, config, trainId, h.x, h.y) > config.values.commit.rangeTiles) return 'out of range';
  return null;
}

/** The commit query: the nearest free train in `commit.rangeTiles`, or null. The client's prompt reads this. */
export function commitTarget(state: GameState, map: WorldMap, config: SimConfig, h: HorseState): string | null {
  if (state.run || h.mode !== 'physical') return null;
  let best: string | null = null, bestD = Infinity;
  for (const t of state.world.trains) {
    if (commitCheck(state, map, config, h, t.id)) continue;
    const d = distanceToTrain(state, map, config, t.id, h.x, h.y);
    if (d < bestD) { bestD = d; best = t.id; }
  }
  return best;
}

/** Marker position after `sweep` ticks: 0 to 1 and back over one `period`. */
export function meterPosition(sweep: number, period: number): number {
  const u = (sweep % period) / period;
  return u < 0.5 ? u * 2 : 2 - u * 2;
}

/** The good zone and the perfect zone centred in it, as [start, end] fractions of the track. */
export function meterZones(meter: MeterState, widths: readonly [number, number]): { perfect: [number, number]; good: [number, number] } {
  const [p, g] = widths, c = meter.zoneCentre;
  return { perfect: [c - p / 2, c + p / 2], good: [c - g / 2, c + g / 2] };
}

export function meterResult(meter: MeterState, period: number, widths: readonly [number, number]): { result: BoardingResult; position: number } {
  const position = meterPosition(meter.sweep, period);
  const z = meterZones(meter, widths);
  const result = position >= z.perfect[0] && position <= z.perfect[1] ? 'perfect' : position >= z.good[0] && position <= z.good[1] ? 'good' : 'fail';
  return { result, position };
}

/** Place the zones at random on the track, wholly inside it, from the misc stream. */
export function rollMeterZones(state: GameState, meter: MeterState, widths: readonly [number, number]): void {
  const g = widths[1];
  meter.zoneCentre = g / 2 + (nextU32(state.rng, 'misc') / 4294967296) * (1 - g);
}
