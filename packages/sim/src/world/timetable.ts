// Seeded timetables (G6). On an open line, trains set out from the start of the mail route one
// after another. Train k's gap behind the train ahead of it is `headwayTiles` plus or minus up to
// `headwaySpreadTiles`, from a hash of the seed and k, and its type comes from another hash of the
// seed and k. Nothing is drawn from an rng stream and nothing is kept in state: where any train is
// at any tick follows from the seed, the map and the config alone. So a town's timetable is worked
// out on demand, and the scheduler (trains.ts) puts each train on the line when the timetable says.
//
// Train numbers: train 0 is the one half a headway in when the line starts; higher numbers set out
// earlier and are further along, lower (negative) ones set out later. Times are in ticks from the
// start of the session (the sim's `tick`), where tick n is the state after n train moves.
//
// Trains do not stop yet, so a train arrives at and leaves a town on the same tick; a stop at each
// town would change only `departTick`.
import { hashState } from '../hash';
import type { SimConfig } from '../types';
import type { WorldMap } from './map';

/** What the timetable reads from a map: its open line (a MapDef or a prepared WorldMap). */
export interface LineMap { readonly openLine?: WorldMap['openLine'] | undefined }

/** One train calling at a town. */
export interface TimetableEntry {
  /** The train's number along the line (see the file comment). */
  k: number;
  type: string;
  town: string;
  /** When the engine reaches the town, and when it leaves (the same until trains stop). */
  arriveTick: number;
  departTick: number;
}

/** The gap in tiles behind train `k` (to train k - 1): headwayTiles plus or minus up to headwaySpreadTiles, from a hash of the seed and k. */
export function lineGapBehind(map: LineMap, seed: string, k: number): number {
  const line = map.openLine!;
  const spread = line.headwaySpreadTiles ?? 0;
  if (spread <= 0) return line.headwayTiles;
  const u = parseInt(hashState(`${seed}/headway/${k}`), 16) / 0x100000000;
  return line.headwayTiles + spread * (2 * u - 1);
}

/**
 * Train k's type under `trainMix`: mail with modes `map` and `all-mail`, else blank when a hash of
 * the seed and k falls under `blankShare`.
 */
export function lineTrainType(config: SimConfig, seed: string, k: number): string {
  const mix = config.values.trainMix;
  if (mix.mode === 'map' || mix.mode === 'all-mail' || !(mix.blankShare > 0)) return mix.mailTrain;
  const u = parseInt(hashState(`${seed}/train-type/${k}`), 16) / 0x100000000;
  return u < mix.blankShare ? mix.blankTrain : mix.mailTrain;
}

/** Where each train would be at tick 0 at the mail train's speed, built outward from train 0 and kept per map and seed. */
interface Series { up: number[]; down: number[] }
const cache = new WeakMap<object, Map<string, Series>>();

function series(map: LineMap, seed: string): Series {
  let bySeed = cache.get(map);
  if (!bySeed) cache.set(map, bySeed = new Map());
  let s = bySeed.get(seed);
  if (!s) bySeed.set(seed, s = { up: [map.openLine!.headwayTiles / 2], down: [] });
  return s;
}

/** Train k's distance along the line at tick 0 at the mail train's speed (negative: not yet set out). */
export function lineStartOffset(map: LineMap, seed: string, k: number): number {
  const s = series(map, seed);
  if (k >= 0) {
    while (s.up.length <= k) { const i = s.up.length; s.up.push(s.up[i - 1]! + lineGapBehind(map, seed, i)); }
    return s.up[k]!;
  }
  // down[j] is train -(j + 1).
  while (s.down.length < -k) {
    const j = s.down.length;
    const ahead = j === 0 ? s.up[0]! : s.down[j - 1]!;
    s.down.push(ahead - lineGapBehind(map, seed, -j));
  }
  return s.down[-k - 1]!;
}

const mailSpeed = (config: SimConfig) => config.values.trains[config.values.trainMix.mailTrain]!.speedTilesPerTick;
const speedOf = (config: SimConfig, type: string) => config.values.trains[type]!.speedTilesPerTick;

/** The tick train k sets out from the start of the line (distance 0); before 0 for trains already on it. */
export function lineDepartTick(map: LineMap, config: SimConfig, seed: string, k: number): number {
  return -lineStartOffset(map, seed, k) / mailSpeed(config);
}

/** Train k's distance along the line at tick `tick` (negative before it sets out). */
export function lineTrainAt(map: LineMap, config: SimConfig, seed: string, k: number, tick: number): number {
  const v = speedOf(config, lineTrainType(config, seed, k));
  return v * (tick - lineDepartTick(map, config, seed, k));
}

/** The highest train number that sets out at or after `tick` (trains set out in falling number order). */
export function lineTrainDepartingFrom(map: LineMap, config: SimConfig, seed: string, tick: number): number {
  const h = map.openLine!.headwayTiles;
  // Departure ticks fall as k rises: start from a guess on the even spacing and walk.
  let k = Math.floor((-tick * mailSpeed(config) - h / 2) / h);
  while (lineDepartTick(map, config, seed, k) < tick) k--;
  while (lineDepartTick(map, config, seed, k + 1) >= tick) k++;
  return k;
}

/**
 * The trains whose engine reaches distance 0 on the move to tick `tick` (their departure is in
 * (tick - 1, tick]), in the order they set out: the scheduler puts these on the line on that tick.
 */
export function lineTrainsSettingOut(map: LineMap, config: SimConfig, seed: string, tick: number): number[] {
  const out: number[] = [];
  let k = lineTrainDepartingFrom(map, config, seed, tick);
  if (lineDepartTick(map, config, seed, k) > tick) k++;
  for (; lineDepartTick(map, config, seed, k) > tick - 1; k++) out.push(k);
  return out.reverse();
}

/** Every train already set out at tick 0 whose engine is not yet past `length`: the line's trains when it starts. */
export function lineTrainsAtStart(map: LineMap, config: SimConfig, seed: string, length: number): number[] {
  const out: number[] = [];
  let k = lineTrainDepartingFrom(map, config, seed, 0);
  if (lineDepartTick(map, config, seed, k) > 0) k++;
  for (; lineTrainAt(map, config, seed, k, 0) < length; k++) out.push(k);
  return out;
}

/**
 * Town `townId`'s timetable between ticks `from` and `to`: each train reaching it in that time, in
 * the order they arrive. A town at distance D sees train k at its departure tick plus D over the
 * train's speed. Empty on maps without an open line or without that town.
 */
export function townTimetable(map: LineMap & Pick<WorldMap, 'towns'>, config: SimConfig, seed: string, townId: string, from: number, to: number): TimetableEntry[] {
  const town = map.towns.find((t) => t.id === townId);
  if (!map.openLine || !town || to < from) return [];
  const route = config.values.trains[config.values.trainMix.mailTrain]!.route;
  if (town.route !== route) return [];
  const types = [config.values.trainMix.mailTrain, config.values.trainMix.blankTrain].filter((t) => config.values.trains[t]);
  const speeds = types.map((t) => speedOf(config, t));
  const vMin = Math.min(...speeds), vMax = Math.max(...speeds);
  // Trains that set out between these ticks can reach the town in the window.
  // A tick either side, so rounding never drops a train at the window's edge; the filter below is exact.
  const first = lineTrainDepartingFrom(map, config, seed, from - town.d / vMin - 1);
  const out: TimetableEntry[] = [];
  for (let k = first; lineDepartTick(map, config, seed, k) <= to - town.d / vMax + 1; k--) {
    const type = lineTrainType(config, seed, k);
    const arriveTick = lineDepartTick(map, config, seed, k) + town.d / speedOf(config, type);
    if (arriveTick >= from && arriveTick <= to) out.push({ k, type, town: town.id, arriveTick, departTick: arriveTick });
  }
  return out.sort((a, b) => a.arriveTick - b.arriveTick || b.k - a.k);
}

/** The number of the line train nearest distance `d` at tick `tick` (its own speed counted), for a train already on the line. */
export function lineTrainNumber(map: LineMap, config: SimConfig, seed: string, type: string, d: number, tick: number): number {
  const depart = tick - d / speedOf(config, type);
  let k = lineTrainDepartingFrom(map, config, seed, depart);
  // The nearest departure on either side.
  if (Math.abs(lineDepartTick(map, config, seed, k + 1) - depart) < Math.abs(lineDepartTick(map, config, seed, k) - depart)) k++;
  return k;
}
