// Coarse-grid pathing for the riderless horse (U4): it paths around blocked and water tiles on a
// grid of `extraction.pathCellTiles` square cells, and steers cell to cell. Cars are not on the
// grid; the horse collides with them as it rides.
import { Terrain, terrainAt, type WorldMap } from './map';

/** Terrain the horse paths around: anything but open and slow ground. */
export const avoids = (t: Terrain): boolean => t !== Terrain.Open && t !== Terrain.Slow;

export interface PathGrid { cell: number; cols: number; rows: number; open: Uint8Array }

const grids = new WeakMap<WorldMap, Map<number, PathGrid>>();

/** The coarse grid for a map: a cell is open when every tile in it is open or slow ground. Built once per map and cell size. */
export function pathGrid(map: WorldMap, cell: number): PathGrid {
  let byCell = grids.get(map);
  if (!byCell) grids.set(map, (byCell = new Map()));
  const have = byCell.get(cell);
  if (have) return have;
  const cols = Math.ceil(map.cols / cell), rows = Math.ceil(map.rows / cell);
  const open = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let ok = 1;
      for (let y = r * cell; ok && y < Math.min(map.rows, (r + 1) * cell); y++) {
        for (let x = c * cell; x < Math.min(map.cols, (c + 1) * cell); x++) if (avoids(map.terrain[y * map.cols + x] as Terrain)) { ok = 0; break; }
      }
      open[r * cols + c] = ok;
    }
  }
  const g = { cell, cols, rows, open };
  byCell.set(cell, g);
  return g;
}

export const cellOf = (g: PathGrid, x: number, y: number): number =>
  Math.max(0, Math.min(g.rows - 1, Math.floor(y / g.cell))) * g.cols + Math.max(0, Math.min(g.cols - 1, Math.floor(x / g.cell)));

export const cellCentre = (g: PathGrid, i: number): { x: number; y: number } =>
  ({ x: ((i % g.cols) + 0.5) * g.cell, y: (Math.floor(i / g.cols) + 0.5) * g.cell });

/** True when the straight line between two points crosses no tile the horse paths around, sampled every half tile. */
export function lineClear(map: WorldMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.ceil(Math.sqrt(dx * dx + dy * dy) * 2);
  for (let i = 1; i <= n; i++) if (avoids(terrainAt(map, x0 + (dx * i) / n, y0 + (dy * i) / n))) return false;
  return true;
}

/**
 * A* over the coarse grid, 8 neighbours (no corner cutting), octile costs, ties broken by the order
 * cells were found so it is deterministic. The start and goal cells count as open. Returns the cells
 * after the start up to the goal, or null when no path exists.
 */
export function findPath(g: PathGrid, start: number, goal: number): number[] | null {
  if (start === goal) return [];
  const n = g.cols * g.rows;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gx = goal % g.cols, gy = Math.floor(goal / g.cols);
  const h = (i: number) => {
    const dx = Math.abs((i % g.cols) - gx), dy = Math.abs(Math.floor(i / g.cols) - gy);
    return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
  };
  const open = (i: number) => i === goal || i === start || g.open[i] === 1;
  // Binary heap of [f, seq, cell].
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
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    const cx = cur % g.cols, cy = Math.floor(cur / g.cols);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
        const ni = y * g.cols + x;
        if (closed[ni] || !open(ni)) continue;
        if (dx && dy && (!open(cy * g.cols + x) || !open(y * g.cols + cx))) continue;
        const c = cost[cur]! + (dx && dy ? 14 : 10);
        if (c < cost[ni]!) { cost[ni] = c; from[ni] = cur; push([c + h(ni), seq++, ni]); }
      }
    }
  }
  if (from[goal] === -1) return null;
  const out: number[] = [];
  for (let i = goal; i !== start; i = from[i]!) out.push(i);
  return out.reverse();
}
