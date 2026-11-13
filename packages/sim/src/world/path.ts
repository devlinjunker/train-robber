// Pathing for the riderless horse (U4, issue #82): A* over whole tiles round blocked and water
// tiles and the cars where they are now, in a window round the horse and its target.
import { Terrain, terrainAt, type WorldMap } from './map';

/** Terrain the horse paths around: anything but open and slow ground. */
export const avoids = (t: Terrain): boolean => t !== Terrain.Open && t !== Terrain.Slow;

/** True when the straight line between two points crosses no tile the horse paths around, sampled every half tile. */
export function lineClear(map: WorldMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.ceil(Math.sqrt(dx * dx + dy * dy) * 2);
  for (let i = 1; i <= n; i++) if (avoids(terrainAt(map, x0 + (dx * i) / n, y0 + (dy * i) / n))) return false;
  return true;
}

/** Extra cost of a tile next to one the horse paths round, so paths keep a little clear of rocks (per 10 for a step). */
const NEAR_COST = 6;
/** Extra cost of slow ground (mud) per step, so paths go round it when that is not much longer. */
const SLOW_COST = 3;

/**
 * A* over whole tiles for the riderless horse (issue #82), inside a window `margin` tiles round
 * the start and goal (at most `maxSide` tiles a side, so it stays cheap on a long line). A tile is
 * open when its terrain is open or slow and `shut` (the cars where they are now) does not close
 * it; a tile beside one that is not costs a little more, and mud more again. 8 neighbours with no
 * corner cutting, ties broken by the order tiles were found, so it is deterministic. Returns the
 * tile indices (row * map.cols + column) after the start up to the goal, or null when there is no
 * way within the window.
 */
export function findTilePath(map: WorldMap, sx: number, sy: number, gx: number, gy: number, shut?: (x: number, y: number) => boolean, margin = 16, maxSide = 96): number[] | null {
  const cx0 = Math.floor(sx), cy0 = Math.floor(sy), cx1 = Math.floor(gx), cy1 = Math.floor(gy);
  const half = maxSide >> 1;
  const mx = (cx0 + cx1) >> 1, my = (cy0 + cy1) >> 1;
  const x0 = Math.max(0, Math.min(cx0, cx1) - margin, mx - half), x1 = Math.min(map.cols - 1, Math.max(cx0, cx1) + margin, mx + half);
  const y0 = Math.max(0, Math.min(cy0, cy1) - margin, my - half), y1 = Math.min(map.rows - 1, Math.max(cy0, cy1) + margin, my + half);
  const inWin = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (!inWin(cx0, cy0) || !inWin(cx1, cy1)) return null;
  const w = x1 - x0 + 1, hgt = y1 - y0 + 1, n = w * hgt;
  // 0 unknown, 1 open, 2 open next to a closed tile, 3 closed.
  const kind = new Uint8Array(n);
  const closedAt = (x: number, y: number) => !inWin(x, y) || avoids(terrainAt(map, x + 0.5, y + 0.5)) || !!shut?.(x + 0.5, y + 0.5);
  const kindOf = (i: number): number => {
    let k = kind[i]!;
    if (k) return k;
    const x = x0 + (i % w), y = y0 + Math.floor(i / w);
    if (closedAt(x, y)) k = 3;
    else {
      k = 1;
      for (let dy = -1; dy <= 1 && k === 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && closedAt(x + dx, y + dy)) { k = 2; break; }
    }
    kind[i] = k;
    return k;
  };
  const start = (cy0 - y0) * w + (cx0 - x0), goal = (cy1 - y0) * w + (cx1 - x0);
  const toMap = (i: number) => (y0 + Math.floor(i / w)) * map.cols + x0 + (i % w);
  if (start === goal) return [];
  const open = (i: number) => i === goal || i === start || kindOf(i) !== 3;
  const stepCost = (i: number) => {
    let c = kindOf(i) === 2 ? NEAR_COST : 0;
    if (terrainAt(map, x0 + (i % w) + 0.5, y0 + Math.floor(i / w) + 0.5) === Terrain.Slow) c += SLOW_COST;
    return c;
  };
  const gxw = cx1 - x0, gyw = cy1 - y0;
  const h = (i: number) => {
    const dx = Math.abs((i % w) - gxw), dy = Math.abs(Math.floor(i / w) - gyw);
    return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
  };
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap: [number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number], b: [number, number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (e: [number, number, number]) => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };
  cost[start] = 0;
  push([h(start), seq++, start]);
  while (heap.length) {
    const [, , cur] = pop();
    if (done[cur]) continue;
    if (cur === goal) break;
    done[cur] = 1;
    const cx = cur % w, cy = Math.floor(cur / w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= hgt) continue;
        const ni = y * w + x;
        if (done[ni] || !open(ni)) continue;
        if (dx && dy && (!open(cy * w + x) || !open(y * w + cx))) continue;
        const c = cost[cur]! + (dx && dy ? 14 : 10) + stepCost(ni);
        if (c < cost[ni]!) { cost[ni] = c; from[ni] = cur; push([c + h(ni), seq++, ni]); }
      }
    }
  }
  if (from[goal] === -1) return null;
  const out: number[] = [];
  for (let i = goal; i !== start; i = from[i]!) out.push(toMap(i));
  return out.reverse();
}
