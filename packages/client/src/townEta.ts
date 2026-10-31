// The next-town ETA line under the clock on an open line (G6). On a train (or committed to one):
// when that train reaches the next town ahead of it, unless the next-town clock already counts down
// to that town. Off a train: when the next train is due at the next town ahead of the rider, from
// the town's seeded timetable.
import { townTimetable, trainSpeed, type SimConfig, type WorldMap } from '@train-robber/sim';
import { clockText } from './clock';

/** A town as the client knows it (MapDef.towns): `end` marks the towns off the ends of the line. */
export interface EtaTown { id: string; name: string; d: number; radiusTiles: number; end?: 'start' | 'end' }

export interface EtaInput {
  map: Pick<WorldMap, 'openLine' | 'towns'>;
  config: SimConfig;
  seed: string;
  tick: number;
  /** Towns in order along the line. */
  towns: readonly EtaTown[];
  /** The run's train, while there is a run. */
  train: { d: number; type: string } | null;
  /** The town the run's clock counts down to (trainClock `next-town`), if any. */
  clockTo?: string | undefined;
  /** How far along the line the rider is, off a train. */
  riderAlong: number | null;
  /** The next train's type name, when train names are shown (hud.showTrainNames, ?trainNames=). */
  typeName?: (type: string) => string | null;
}

/** How far ahead a town's timetable is searched for the next train. */
const LOOK_AHEAD_SEC = 30 * 60;

export function townEta(i: EtaInput): string | null {
  if (!i.map.openLine || !i.towns.length) return null;
  const hz = i.config.values.sim.tickRateHz;
  if (i.train) {
    const next = i.towns.find((t) => t.d > i.train!.d);
    if (!next || next.id === i.clockTo) return null;
    return `${next.name}: your train in ${clockText((next.d - i.train.d) / trainSpeed(i.config, i.train.type))}`;
  }
  if (i.riderAlong === null) return null;
  // The first town whose clearing is not yet behind the rider; trains only set out from the start town.
  const next = i.towns.find((t) => t.end !== 'start' && t.d + t.radiusTiles > i.riderAlong!);
  if (!next) return null;
  const due = townTimetable(i.map, i.config, i.seed, next.id, i.tick, i.tick + LOOK_AHEAD_SEC * hz)[0];
  if (!due) return null;
  const name = i.typeName?.(due.type);
  return `${next.name}: next train${name ? ` (${name})` : ''} in ${clockText((due.arriveTick - i.tick) / hz)}`;
}

/** The next few trains due at a town, for the debug panel: `in 0:35 mail-express, in 1:42 blank, ...`. */
export function timetableText(map: Pick<WorldMap, 'openLine' | 'towns'>, config: SimConfig, seed: string, tick: number, town: EtaTown, count = 4): string {
  const hz = config.values.sim.tickRateHz;
  const due = townTimetable(map, config, seed, town.id, tick, tick + LOOK_AHEAD_SEC * hz).slice(0, count);
  return `timetable ${town.name}: ${due.length ? due.map((e) => `${clockText((e.arriveTick - tick) / hz)} ${e.type} #${e.k}`).join(', ') : 'none due'}`;
}
