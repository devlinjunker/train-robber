// Committing to a train and the boarding rule: who can commit, who may jump, and the meter.
// The client only reads these; the decisions are the sim's.
import { nextU32 } from '../rng';
import type { BoardingResult, BoardingTargetKind, CommitRejection, GameState, HorseState, MeterState, SimConfig, SwitchRejection, TrainState } from '../types';
import { carCatalog, carTemplate, entryPointWorld, type CarPose, type Side } from './cars';
import { distanceToBox } from './collide';
import { trainSideLadders } from './guards';
import { carPlatformTargets, type BoardingTarget } from './platforms';
import type { WorldMap } from './map';

export { carPlatformTargets, type BoardingTarget } from './platforms';
import { carPosesOf, trainSpeed } from './trains';

/**
 * The boarding rule's verdict. `too far` refuses a jump; `too fast` and `too slow` allow it on
 * the fast meter, and `eligible` (in range and speed matched) gets the slow one.
 */
export type BoardingState = 'eligible' | 'too far' | 'too fast' | 'too slow';

export interface BoardingCheck {
  state: BoardingState;
  /** Side of the train the horse is on, relative to the direction of travel. */
  side: Side;
  /** Nearest boarding target on that side, or null when the train has none there. */
  car: number | null;
  /** Its id: the entry point's id for a door, `platform-front` / `platform-rear`, or `ladder-left` / `ladder-right`. */
  entry: string | null;
  /** What it is: a side door, an end platform or a side ladder (issue #60). */
  target: BoardingTargetKind | null;
  /** World position of that target. */
  at: { x: number; y: number } | null;
  /** Where a landing there puts you, in the car's frame. */
  land: { x: number; y: number } | null;
  /** Distance from the horse to it, in tiles. */
  distance: number;
  /** Horse speed along that car's direction of travel minus the train's speed, tiles/s. */
  speedDelta: number;
}

/** Which side of a car the point is on: left of travel is (uy, -ux), as in `entryPointWorld`. */
export function sideOf(car: CarPose, x: number, y: number): Side {
  return (x - car.x) * car.uy - (y - car.y) * car.ux >= 0 ? 'left' : 'right';
}

/** How far outside the long wall a rider on a side ladder hangs, in tiles: beyond the ladder's rails, so the view sorts them in front of it on the near side and behind it on the far side. */
export const SIDE_LADDER_OUT = 0.3;

/** The meter zone widths a jump at this target uses: a side ladder takes only the perfect zone with `boarding.ladderPerfectOnly` (Devlin, PR #65). */
export function targetZoneWidths(config: SimConfig, target: BoardingTargetKind | null): readonly [number, number] {
  const b = config.values.boarding, w = b.meter.zoneWidths;
  return target === 'ladder' && b.ladderPerfectOnly ? [w[0], w[0]] : w;
}

/**
 * Every boarding target of a placed car, under `boarding.targets`: its side doors (unless `doorsShut`),
 * its end platforms on each side (`caboose`: only a caboose's rear; `train-end`: only the last car's rear; `all`: every end but the
 * engine's front, car 0), and its side ladders. `trainCars` is the train's car template list, which
 * says which car is last and which have ladders.
 */
export function carBoardingTargets(config: SimConfig, car: CarPose, trainCars: readonly string[], doorsShut = false): BoardingTarget[] {
  const t = config.values.boarding.targets;
  const tmpl = carTemplate(carCatalog(config), car.template);
  const rows = tmpl.size.rows, hl = car.halfLength;
  const out: BoardingTarget[] = [];
  const add = (kind: BoardingTargetKind, id: string, side: Side, along: number, land: { x: number; y: number }) => {
    const w = entryPointWorld(car, { side, along });
    out.push({ kind, id, side, x: w.x, y: w.y, land });
  };
  if (t.doors && !doorsShut) {
    for (const ep of tmpl.sideEntries) add('door', ep.id, ep.side, ep.along, { x: ep.cell[0] + 0.5, y: ep.cell[1] + 0.5 });
  }
  out.push(...carPlatformTargets(config, car, trainCars));
  for (const l of trainSideLadders(config, trainCars)) {
    if (l.car !== car.index) continue;
    add('ladder', `ladder-${l.side}`, l.side, hl - l.x, { x: l.x, y: l.side === 'left' ? -SIDE_LADDER_OUT : rows + SIDE_LADDER_OUT });
  }
  return out;
}

/**
 * The boarding rule: a jump needs `boarding.rangeTiles` of a boarding target (`carBoardingTargets`)
 * on the side the horse is riding. Being within `boarding.speedToleranceTilesPerSec` of the train's
 * speed, measured along that car's direction of travel, slows the meter. Too far wins over a speed
 * mismatch. A train whose doors are shut (`doorsClosed`) can still be boarded at its platforms and ladders.
 */
export function boardingCheck(state: GameState, map: WorldMap, config: SimConfig, trainId: string, h: HorseState): BoardingCheck {
  const b = config.values.boarding;
  const train = state.world.trains.find((t) => t.id === trainId);
  const cars = carPosesOf(state, map, config, trainId);
  const out: BoardingCheck = { state: 'too far', side: 'left', car: null, entry: null, target: null, at: null, land: null, distance: Infinity, speedDelta: 0 };
  if (!train || cars.length === 0) return out;
  // The side comes from the nearest car body, so a horse beside the engine still has one.
  let nearest = Infinity;
  for (const car of cars) {
    const d = distanceToBox(h.x, h.y, car);
    if (d < nearest) { nearest = d; out.side = sideOf(car, h.x, h.y); }
  }
  let best: CarPose | null = null;
  const shut = doorsClosed(state, train);
  for (const car of cars) {
    for (const tg of carBoardingTargets(config, car, train.cars, shut)) {
      if (tg.side !== out.side) continue;
      const dx = h.x - tg.x, dy = h.y - tg.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < out.distance) {
        out.distance = d; out.car = car.index; out.entry = tg.id; out.target = tg.kind; out.at = { x: tg.x, y: tg.y }; out.land = tg.land;
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
  if (doorsClosed(state, t)) return 'doors closed';
  if (distanceToTrain(state, map, config, trainId, h.x, h.y) > config.values.commit.rangeTiles) return 'out of range';
  return null;
}

/** Whether a cash-out shut this train's doors and they have not reopened yet. */
export function doorsClosed(state: GameState, t: TrainState): boolean {
  return !!t.doorsClosed && (t.doorsClosed.untilTick === null || state.tick < t.doorsClosed.untilTick);
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

/**
 * Whether the run may move to this train, or why not: only while approaching or stunned after a
 * failed jump, to another free train within `commit.switchRangeTiles`.
 */
export function switchCheck(state: GameState, map: WorldMap, config: SimConfig, h: HorseState, trainId: string): SwitchRejection | null {
  const run = state.run;
  if (!run) return 'no run';
  if (run.phase === 'aboard' || run.phase === 'extracting' || run.phase === 'ended') return 'aboard';
  if (run.trainId === trainId) return 'already committed';
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) return 'no such train';
  if (t.pinnedBy !== null) return 'train taken';
  if (doorsClosed(state, t)) return 'doors closed';
  if (distanceToTrain(state, map, config, trainId, h.x, h.y) > config.values.commit.switchRangeTiles) return 'out of range';
  return null;
}

/** The switch query: the nearest other free train the run could move to, or null. The client's prompt reads this. */
export function switchTarget(state: GameState, map: WorldMap, config: SimConfig, h: HorseState): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const t of state.world.trains) {
    if (switchCheck(state, map, config, h, t.id)) continue;
    const d = distanceToTrain(state, map, config, t.id, h.x, h.y);
    if (d < bestD) { bestD = d; best = t.id; }
  }
  return best;
}

/** Marker position for a phase through one back-and-forth: 0 to 1 and back. */
export function meterPosition(phase: number): number {
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

/**
 * Advance the marker one tick. In boarding range it sweeps, slowly when speed matched and at
 * the fast period otherwise, so a mismatched jump is possible but harder; out of range it parks
 * at 0. The phase carries over when the speed changes, so the marker never jumps.
 */
export function advanceMeter(meter: MeterState, state: BoardingState, periods: { sweepPeriodTicks: number; matchedSweepPeriodTicks: number }): void {
  if (state === 'too far') { meter.phase = 0; return; }
  meter.phase += 1 / (state === 'eligible' ? periods.matchedSweepPeriodTicks : periods.sweepPeriodTicks);
  if (meter.phase >= 1) meter.phase -= 1;
}

/** The mount meter (U4): sweep at one period while a mount is possible, else park at 0. */
export function advanceMeterBy(meter: MeterState, sweeping: boolean, periodTicks: number): void {
  if (!sweeping) { meter.phase = 0; return; }
  meter.phase += 1 / periodTicks;
  if (meter.phase >= 1) meter.phase -= 1;
}

/** The good zone and the perfect zone centred in it, as [start, end] fractions of the track. */
export function meterZones(meter: MeterState, widths: readonly [number, number]): { perfect: [number, number]; good: [number, number] } {
  const [p, g] = widths, c = meter.zoneCentre;
  return { perfect: [c - p / 2, c + p / 2], good: [c - g / 2, c + g / 2] };
}

export function meterResult(meter: MeterState, widths: readonly [number, number]): { result: BoardingResult; position: number } {
  const position = meterPosition(meter.phase);
  const z = meterZones(meter, widths);
  const result = position >= z.perfect[0] && position <= z.perfect[1] ? 'perfect' : position >= z.good[0] && position <= z.good[1] ? 'good' : 'fail';
  return { result, position };
}

/** Place the zones at random on the track, wholly inside it, from the misc stream. */
export function rollMeterZones(state: GameState, meter: MeterState, widths: readonly [number, number]): void {
  const g = widths[1];
  meter.zoneCentre = g / 2 + (nextU32(state.rng, 'misc') / 4294967296) * (1 - g);
}
