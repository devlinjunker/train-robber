// Rules every playable map keeps, hand-made or generated: closed routes with no curve tighter
// than the cars allow, rock and water off the cars, one side of every track open to ride beside,
// and a track the rider can reach from the spawn. Each check returns its problems (empty is a pass),
// so the hand-made maps test and the generated maps test share them.
import { decodeZones, ZONES, type MapDef, type SceneryDef } from '@train-robber/config';

/** No rock or water (shallow or deep) this close to the centre line: the cars are 6 tiles wide. */
export const CAR_CLEAR_TILES = 3.5;
/**
 * Distances from the centre line where a rider lines up with a door (boarding range is 2 tiles).
 * Mud and rocks may fill this lane on one side, never on both at once. Across a bridge the river
 * may fill both: bridges are only wide enough for the train, so the rider wades or waits.
 */
export const LANE_TILES = [3.5, 4, 4.5, 5, 5.5];
/** Tightest baked curve allowed; rigid 16-tile cars cut visibly inside anything tighter. */
export const MIN_RADIUS_TILES = 17;

/** Tightest curve over all routes, from the turn between consecutive baked tangents. */
export function minRadius(map: MapDef): number {
  let min = Infinity;
  for (const r of map.routes) {
    const { tx, ty } = r.samples;
    const n = tx.length;
    for (let i = r.closed ? 0 : 1; i < (r.closed ? n : n - 1); i++) {
      const j = (i - 1 + n) % n;
      const angle = Math.acos(Math.min(1, Math.max(-1, tx[j]! * tx[i]! + ty[j]! * ty[i]!)));
      if (angle > 1e-9) min = Math.min(min, r.spacing / angle);
    }
  }
  return min;
}

/** Closed routes for every train, and no curve tighter than MIN_RADIUS_TILES. */
export function routeProblems(map: MapDef, minRadiusTiles = minRadius(map)): string[] {
  const out: string[] = [];
  const main = map.routes.find((r) => r.id === 'main');
  // Without a train list the mail train runs on main; with one, every train names a route.
  if (!map.trains && !main?.closed) out.push('no closed main route');
  for (const t of map.trains ?? []) if (!map.routes.some((r) => r.id === t.route)) out.push(`train ${t.type} names missing route ${t.route}`);
  for (const r of map.routes) if (!r.closed) out.push(`route ${r.id} is not closed`);
  if (!(minRadiusTiles >= MIN_RADIUS_TILES)) out.push(`tightest curve ${minRadiusTiles.toFixed(1)} tiles, under ${MIN_RADIUS_TILES}`);
  return out;
}

/** Rock and water off the cars, and an open lane on one side of every sample (or a wet one at a bridge). */
export function corridorProblems(map: MapDef, scenery: SceneryDef | null, limit = 20): string[] {
  const out: string[] = [];
  const { cols } = map.size;
  const grid = decodeZones(map);
  const zone = (x: number, y: number) => ZONES[grid[y * cols + x]!]!;
  for (const route of map.routes) {
    const { x: xs, y: ys, tx, ty } = route.samples;
    const at = (i: number, side: number, d: number) => zone(Math.floor(xs[i]! - ty[i]! * d * side), Math.floor(ys[i]! + tx[i]! * d * side));
    const onBridge = (i: number) => (scenery?.bridges ?? []).some((b) => xs[i]! >= b.x - 1 && xs[i]! <= b.x + b.w + 1 && ys[i]! >= b.y - 1 && ys[i]! <= b.y + b.h + 1);
    for (let i = 0; i < xs.length && out.length < limit; i++) {
      for (let d = 0; d <= CAR_CLEAR_TILES; d += 0.25) {
        for (const side of [-1, 1]) {
          const z = at(i, side, d);
          if (z !== 'open' && z !== 'slow') out.push(`${route.id}: ${z} ${d} tiles beside sample ${i} (${xs[i]}, ${ys[i]})`);
        }
      }
      const open = (side: number) => LANE_TILES.every((d) => at(i, side, d) === 'open');
      const wet = (side: number) => LANE_TILES.every((d) => at(i, side, d) === 'open' || at(i, side, d) === 'water');
      if (onBridge(i) ? !(wet(-1) || wet(1)) : !(open(-1) || open(1))) out.push(`${route.id}: no ${onBridge(i) ? 'lane beside bridge' : 'open lane beside'} sample ${i} (${xs[i]}, ${ys[i]})`);
    }
  }
  return out;
}

/** Every 50th sample of every route can be reached on rideable ground from the spawn. */
export function reachProblems(map: MapDef): string[] {
  const { cols, rows } = map.size;
  const grid = decodeZones(map);
  const rideable = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    const z = ZONES[grid[y * cols + x]!];
    return z === 'open' || z === 'slow' || z === 'water';
  };
  const start = map.markers.playerSpawn;
  const seen = new Uint8Array(cols * rows);
  const queue = [Math.floor(start.y) * cols + Math.floor(start.x)];
  seen[queue[0]!] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!, x = i % cols, y = (i - x) / cols;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (rideable(nx, ny) && !seen[ny * cols + nx]) { seen[ny * cols + nx] = 1; queue.push(ny * cols + nx); }
    }
  }
  const out: string[] = [];
  for (const route of map.routes) {
    const { x: xs, y: ys } = route.samples;
    for (let i = 0; i < xs.length; i += 50) if (!seen[Math.floor(ys[i]!) * cols + Math.floor(xs[i]!)]) out.push(`${route.id}: sample ${i} unreachable from the spawn`);
  }
  return out;
}

/** All the static checks above. */
export function mapProblems(map: MapDef, scenery: SceneryDef | null, minRadiusTiles?: number): string[] {
  return [...routeProblems(map, minRadiusTiles), ...corridorProblems(map, scenery), ...reachProblems(map)];
}
