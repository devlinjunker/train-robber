// Junctions: services built from shared segments, and trains that pick a branch at each split.
// A train always runs on one baked service route. Just before a junction where services part,
// with its whole length still on the segment they share, it may move onto another service that
// shares that segment: the track under its cars is identical, so nothing jumps. The pick is a
// seeded draw, so replays stay exact, and it skips any branch that would bring it too close to
// another train where that branch rejoins shared track.
import { nextInt } from '../rng';
import type { GameState, SimConfig, TrainState } from '../types';
import { expandCars, trainLength } from './cars';
import type { RouteLeg, SimRoute, WorldMap } from './map';
import { wrapDistance } from './track';

/** A train picks its branch this far before the junction, with every car still on the shared segment. */
export const DECIDE_BEFORE_TILES = 1;
/** Gap a train keeps behind or ahead of another where their tracks join. */
export const JUNCTION_GAP_TILES = 12;

export interface Network {
  /** Junctions where services part: a train picks a branch there. */
  splits: ReadonlySet<string>;
  /** Junctions where services join: trains from two branches can meet there. */
  merges: ReadonlySet<string>;
  /** Every service leg on a segment, by segment id. */
  bySegment: ReadonlyMap<string, readonly { route: string; leg: number }[]>;
}

/** Junction topology from the services' legs; null when no route has legs. */
export function buildNetwork(routes: readonly SimRoute[]): Network | null {
  const out = new Map<string, Set<string>>(), into = new Map<string, Set<string>>();
  const bySegment = new Map<string, { route: string; leg: number }[]>();
  for (const r of routes) {
    r.legs?.forEach((l, i) => {
      (out.get(l.from) ?? out.set(l.from, new Set()).get(l.from)!).add(l.segment);
      (into.get(l.to) ?? into.set(l.to, new Set()).get(l.to)!).add(l.segment);
      (bySegment.get(l.segment) ?? bySegment.set(l.segment, []).get(l.segment)!).push({ route: r.id, leg: i });
    });
  }
  if (!bySegment.size) return null;
  const many = (m: Map<string, Set<string>>) => new Set([...m].filter(([, s]) => s.size > 1).map(([j]) => j));
  return { splits: many(out), merges: many(into), bySegment };
}

const legEnd = (l: RouteLeg) => l.start + l.length;

/** Distance ahead of `d` to the next point where a train on `route` picks a branch, or the route's length. */
function nextDecision(net: Network, route: SimRoute, d: number): number {
  let best = route.length;
  for (const l of route.legs ?? []) {
    if (!net.splits.has(l.to)) continue;
    const ahead = wrapDistance(route, legEnd(l) - DECIDE_BEFORE_TILES - d);
    if (ahead > 0 && ahead < best) best = ahead;
  }
  return best;
}

/** Distance from `d` along `route` to the next merge junction, and which one; null when there is none. */
function nextMerge(net: Network, route: SimRoute, d: number): { junction: string; ahead: number } | null {
  let best: { junction: string; ahead: number } | null = null;
  for (const l of route.legs ?? []) {
    if (!net.merges.has(l.to)) continue;
    const ahead = wrapDistance(route, legEnd(l) - d);
    if (!best || ahead < best.ahead) best = { junction: l.to, ahead };
  }
  return best;
}

/**
 * Ticks until another train's engine reaches `junction` along the path it is committed to,
 * negative when it passed it on its current leg, or null when it won't get there before its own next pick.
 */
function arrivalTicks(net: Network, route: SimRoute, d: number, speed: number, junction: string): number | null {
  const horizon = nextDecision(net, route, d) + DECIDE_BEFORE_TILES;
  let best: number | null = null;
  for (const l of route.legs ?? []) {
    if (l.from === junction) {
      const back = wrapDistance(route, d - l.start);
      if (back < l.length) return -back / speed;
    }
    if (l.to === junction) {
      const ahead = wrapDistance(route, legEnd(l) - d);
      if (ahead <= horizon && (best === null || ahead < best)) best = ahead;
    }
  }
  return best === null ? null : best / speed;
}

interface Option { route: SimRoute; d: number; clearance: number }

/**
 * Tick system 2, after trains move: a train that just reached its pick point before a split
 * moves onto a service through one of the branches, drawn from `schedule`.
 */
export function junctionSystem(state: GameState, map: WorldMap, config: SimConfig, prevD: ReadonlyMap<string, number>): void {
  const net = map.network;
  if (!net) return;
  const lengthOf = (t: TrainState) => trainLength(expandCars(config.values.trains[t.type]!.cars));
  const speedOf = (t: TrainState) => config.values.trains[t.type]!.speedTilesPerTick;
  for (const t of state.world.trains) {
    const route = t.route ? map.routes.get(t.route) : undefined;
    if (!route?.legs) continue;
    const before = prevD.get(t.id);
    if (before === undefined) continue;
    const step = wrapDistance(route, t.d - before);
    const leg = route.legs.find((l) => {
      if (!net.splits.has(l.to)) return false;
      const ahead = wrapDistance(route, legEnd(l) - DECIDE_BEFORE_TILES - before);
      return ahead > 0 && ahead <= step;
    });
    // The whole train must be on the shared segment, or its cars would jump onto other track.
    if (!leg || wrapDistance(route, t.d - leg.start) < lengthOf(t)) continue;

    // One option per branch: stay on this service if it takes that branch, else the first service that does.
    const options: Option[] = [];
    const seen = new Set<string>();
    const sharing = [...net.bySegment.get(leg.segment)!].sort((a, b) => (a.route === route.id ? -1 : b.route === route.id ? 1 : a.route < b.route ? -1 : 1));
    for (const { route: id, leg: i } of sharing) {
      const r = map.routes.get(id)!;
      const legs = r.legs!;
      const branch = legs[(i + 1) % legs.length]!.segment;
      if (seen.has(branch)) continue;
      seen.add(branch);
      const d = wrapDistance(r, t.d - leg.start + legs[i]!.start);
      options.push({ route: r, d, clearance: clearance(state, map, net, t, r, d, lengthOf, speedOf) });
    }
    if (options.length < 2) continue;
    const clear = options.filter((o) => o.clearance >= 0);
    const pick = clear.length ? clear[clear.length === 1 ? 0 : nextInt(state.rng, 'schedule', clear.length)]!
      : options.reduce((a, b) => (b.clearance > a.clearance ? b : a));
    if (pick.route.id !== route.id) { t.route = pick.route.id; t.d = pick.d; }
  }
}

/**
 * How many ticks to spare, at the next merge on `route`, between train `t` (front at `d`) and
 * every other train committed to reach it: negative means they would come within the gap.
 */
function clearance(
  state: GameState, map: WorldMap, net: Network, t: TrainState, route: SimRoute, d: number,
  lengthOf: (t: TrainState) => number, speedOf: (t: TrainState) => number,
): number {
  const m = nextMerge(net, route, d);
  if (!m) return Infinity;
  const vT = speedOf(t), at = m.ahead / vT;
  let worst = Infinity;
  for (const u of state.world.trains) {
    if (u === t || !u.route) continue;
    const ur = map.routes.get(u.route);
    if (!ur?.legs) continue;
    const vU = speedOf(u);
    const au = arrivalTicks(net, ur, u.d, vU, m.junction);
    if (au === null) continue;
    // Whoever reaches the junction second waits for the first one's whole length plus the gap.
    const spare = au >= at ? au - at - (lengthOf(t) + JUNCTION_GAP_TILES) / vT : at - au - (lengthOf(u) + JUNCTION_GAP_TILES) / vU;
    worst = Math.min(worst, spare);
  }
  return worst;
}
