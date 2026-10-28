// Ground height in the isometric view, from the map's optional elevation layer (Devlin,
// 2026-10-12: cliffs and hills you can see; the sim stays flat). Each tile corner takes the
// average height of the tiles around it that are within one level of each other, so a step of
// one level is a slope and a bigger step leaves a gap that is drawn as a cliff face.
// Raised tiles are drawn in depth strips that sort with the horse and cars, like the boulders.
// Ground cut off by cliffs all round is a plateau: the ground runs on under it and iso/mesa.ts
// draws it as a rounded mesa on top (PR #25 playtest, 2026-10-13).
import type { Container } from 'pixi.js';
import { CHUNK_TILES, decodeElevation, type MapDef, type Zone } from '@train-robber/config';
import { facesViewer, isoPoly, mix, shade, oval } from './draw';
import { GROUND, hash, mudPuddle, MUD_COLOUR, sandSpot, SPOT_COLOURS, spotPoly, ZONE_COLOURS } from './terrain';
import { cullSorted, LazyChunks, regionUnits, SortedCells, type BuildBudget, type Chunk, type TileBox } from './cells';
import { FOREST_FLOOR } from './scenery';
import { mapTiles, type MapTiles, type TileBoxLike } from '../tiles';
import { isoX, isoY } from '../projection';

/** Height of one elevation level, in tiles of z. */
export const LEVEL_TILES = 0.6;
const CLIFF_COLOUR = 0x8c7a62;
const SCREE_COLOUR = 0x9c8462, SCREE_TILES = 3;
// Water keeps its colour on a hill too, so a lake or river doesn't vanish under raised ground (Devlin, PR #25).
const SURFACE: Partial<Record<Zone, number>> = { ...ZONE_COLOURS, open: GROUND };

export interface HeightField {
  /** False when the map has no raised ground: everything else is then a no-op. */
  raised: boolean;
  /** Ground height in tiles of z under a world point. Under a mesa this is the ground its cliffs stand on. */
  groundZ(x: number, y: number): number;
  /** Height of whatever is drawn at a world point: a mesa's top, or the ground. */
  surfaceZ(x: number, y: number): number;
  /** Corner heights of tile (x, y) on the ground: top-left, top-right, bottom-right, bottom-left. */
  corners(x: number, y: number): [number, number, number, number];
  /** Raised ground cut off by cliffs all round, drawn as mesas (iso/mesa.ts); lowest first. Empty on a streamed map, which finds them as it goes (`plateausIn`). */
  plateaus: Plateau[];
  /** Which plateau tile (x, y) belongs to, or -1 for the ground. */
  plateauOf(x: number, y: number): number;
  /** Plateau `k` (as plateauOf gives it). */
  plateau(k: number): Plateau;
  /** Every plateau with a tile in a box of tiles [x0, x1) x [y0, y1). */
  plateausIn(box: TileBoxLike): number[];
}

/** One mesa: tiles joined by steps of at most one level, rising by a cliff from everything around them. */
export interface Plateau {
  /** Seeds its colour and outline: its index on a whole map, its first tile on a streamed one. */
  id: number;
  tiles: number[];
  /** Height of its top at a world point, from its own tiles (the nearest one outside them). */
  topZ(x: number, y: number): number;
}

const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Corner heights of every tile, each the average of the tiles round the corner that `joins` the tile. */
function cornerHeights(cols: number, rows: number, level: ArrayLike<number>, joins: (i: number, j: number) => boolean): Float32Array {
  const corner = new Float32Array(cols * rows * 4);
  for (let i = 0; i < cols * rows; i++) tileCorners(cols, rows, level, joins, i, corner, i * 4);
  return corner;
}

const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
const AROUND = [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const;

/** One tile's corner heights into `out` at `o`: each corner is the average of the tiles round it that `joins` the tile. */
function tileCorners(cols: number, rows: number, level: ArrayLike<number>, joins: (i: number, j: number) => boolean, i: number, out: Float32Array, o: number): void {
  const x = i % cols, y = (i - x) / cols;
  // Corners in order TL, TR, BR, BL; each is shared by the 2 x 2 tiles around it.
  for (let k = 0; k < 4; k++) {
    const [cx, cy] = CORNERS[k]!;
    let sum = 0, n = 0;
    for (const [dx, dy] of AROUND) {
      const nx = x + cx + dx, ny = y + cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      if (j !== i && !joins(i, j)) continue;
      sum += level[j]!; n++;
    }
    out[o + k] = (sum / n) * LEVEL_TILES;
  }
}

const bilinear = (c: ArrayLike<number>, o: number, fx: number, fy: number) =>
  (c[o]! * (1 - fx) + c[o + 1]! * fx) * (1 - fy) + (c[o + 3]! * (1 - fx) + c[o + 2]! * fx) * fy;

/**
 * The height field of a map: from its tiles (`tiles`), worked out chunk by chunk as it is needed on
 * a streamed map (see streamedHeightField), else for the whole map at once.
 */
export function createHeightField(map: Pick<MapDef, 'size' | 'elevation' | 'zones'>, tiles?: MapTiles): HeightField {
  if (tiles?.streamed) return streamedHeightField(tiles);
  const { cols, rows } = map.size;
  const level = decodeElevation(map);
  const raised = level.some((l) => l > 0);
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;
  const owner = new Int32Array(raised ? cols * rows : 0).fill(-1);
  const plateaus: Plateau[] = [];
  // The ground's levels: a plateau's own tiles are filled in from the ground round it, so the
  // ground runs on under each mesa and its cliffs stand on that.
  const ground = Float32Array.from(raised ? level : []);
  let corner: Float32Array = new Float32Array(0);
  if (raised) {
    // Regions joined by steps of at most one level. The biggest is the ground; any other that
    // sits higher than the lowest ground beside it is a plateau.
    const region = new Int32Array(cols * rows).fill(-1), sizes: number[] = [];
    for (let s = 0; s < cols * rows; s++) {
      if (region[s] !== -1) continue;
      const id = sizes.length, stack = [s];
      region[s] = id;
      let n = 0;
      while (stack.length) {
        const i = stack.pop()!, x = i % cols, y = (i - x) / cols;
        n++;
        for (const [dx, dy] of SIDES4) {
          if (!inMap(x + dx, y + dy)) continue;
          const j = i + dy * cols + dx;
          if (region[j] === -1 && Math.abs(level[j]! - level[i]!) <= 1) { region[j] = id; stack.push(j); }
        }
      }
      sizes.push(n);
    }
    const groundId = sizes.indexOf(Math.max(...sizes));
    const members: number[][] = sizes.map(() => []);
    for (let i = 0; i < cols * rows; i++) members[region[i]!]!.push(i);
    const found: { tiles: number[]; low: number }[] = [];
    members.forEach((tiles, id) => {
      if (id === groundId) return;
      let low = Infinity, outside = Infinity;
      for (const i of tiles) {
        low = Math.min(low, level[i]!);
        const x = i % cols, y = (i - x) / cols;
        for (const [dx, dy] of SIDES4) {
          if (inMap(x + dx, y + dy) && region[i + dy * cols + dx] !== id) outside = Math.min(outside, level[i + dy * cols + dx]!);
        }
      }
      if (low > outside) found.push({ tiles, low });
    });
    found.sort((a, b) => a.low - b.low);
    found.forEach(({ tiles }, k) => { for (const i of tiles) owner[i] = k; });
    // Fill plateau tiles from the nearest ground, then relax them toward their neighbours' average
    // so the hidden ground under a mesa is smooth.
    const queue: number[] = [];
    const filled = new Uint8Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) if (owner[i] === -1) { filled[i] = 1; queue.push(i); }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!, x = i % cols, y = (i - x) / cols;
      for (const [dx, dy] of SIDES4) {
        const j = i + dy * cols + dx;
        if (!inMap(x + dx, y + dy) || filled[j]) continue;
        filled[j] = 1; ground[j] = ground[i]!; queue.push(j);
      }
    }
    const inner = queue.filter((i) => owner[i] !== -1);
    for (let pass = 0; pass < 30; pass++) {
      for (const i of inner) {
        const x = i % cols, y = (i - x) / cols;
        let sum = 0, n = 0;
        for (const [dx, dy] of SIDES4) if (inMap(x + dx, y + dy)) { sum += ground[i + dy * cols + dx]!; n++; }
        ground[i] = sum / n;
      }
    }
    corner = cornerHeights(cols, rows, ground, (i, j) => Math.abs(ground[j]! - ground[i]!) <= 1);
    smoothCorners(cols, rows, ground, corner);
    for (const { tiles } of found) {
      const k = plateaus.length;
      // Only this plateau's own tiles: a whole-map pass per plateau grew with the square of the map's area.
      const joins = (i: number, j: number) => owner[i] === k && owner[j] === k && Math.abs(level[j]! - level[i]!) <= 1;
      const top = new Float32Array(tiles.length * 4), index = new Map<number, number>();
      tiles.forEach((i, n) => { index.set(i, n); tileCorners(cols, rows, level, joins, i, top, n * 4); });
      plateaus.push({
        id: k,
        tiles,
        topZ(x, y) {
          let tx = Math.floor(x), ty = Math.floor(y);
          let n = index.get(ty * cols + tx);
          if (n === undefined) {
            // Just outside its tiles (a rounded outline can bulge a little): use the nearest one.
            let best = Infinity;
            for (const i of tiles) {
              const ix = i % cols, iy = (i - ix) / cols, d = Math.max(Math.abs(ix + 0.5 - x), Math.abs(iy + 0.5 - y));
              if (d < best) { best = d; tx = ix; ty = iy; }
            }
            n = index.get(ty * cols + tx)!;
          }
          return bilinear(top, n * 4, Math.min(1, Math.max(0, x - tx)), Math.min(1, Math.max(0, y - ty)));
        },
      });
    }
  }
  const corners = (x: number, y: number): [number, number, number, number] => {
    if (!raised || !inMap(x, y)) return [0, 0, 0, 0];
    const o = (y * cols + x) * 4;
    return [corner[o]!, corner[o + 1]!, corner[o + 2]!, corner[o + 3]!];
  };
  const groundZ = (x: number, y: number) => {
    if (!raised) return 0;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!inMap(tx, ty)) return 0;
    return bilinear(corner, (ty * cols + tx) * 4, x - tx, y - ty);
  };
  const plateauOf = (x: number, y: number) => (raised && inMap(x, y) ? owner[y * cols + x]! : -1);
  return {
    raised,
    corners,
    groundZ,
    plateaus,
    plateauOf,
    plateau: (k) => plateaus[k]!,
    plateausIn(box) {
      const out = new Set<number>();
      for (let y = Math.max(0, box.y0); y < Math.min(rows, box.y1); y++) for (let x = Math.max(0, box.x0); x < Math.min(cols, box.x1); x++) { const k = plateauOf(x, y); if (k >= 0) out.add(k); }
      return [...out].sort((a, b) => a - b);
    },
    surfaceZ(x, y) {
      const k = plateauOf(Math.floor(x), Math.floor(y));
      return k < 0 ? groundZ(x, y) : plateaus[k]!.topZ(x, y);
    },
  };
}

/**
 * Soften slopes: where no cliff meets a vertex, its height is the average of the vertices around
 * it (two passes), so hills read as rounded rather than stepped.
 */
function smoothCorners(cols: number, rows: number, level: ArrayLike<number>, corner: Float32Array): void {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? -1 : level[y * cols + x]!);
  const VC = cols + 1, VR = rows + 1;
  let v = new Float32Array(VC * VR);
  const smooth = new Uint8Array(VC * VR);
  for (let vy = 0; vy < VR; vy++) {
    for (let vx = 0; vx < VC; vx++) {
      let lo = Infinity, hi = -Infinity;
      for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
        const l = at(vx + dx, vy + dy);
        if (l < 0) continue;
        lo = Math.min(lo, l); hi = Math.max(hi, l);
      }
      smooth[vy * VC + vx] = hi - lo <= 1 ? 1 : 0;
      // Any tile's own corner value will do here: they agree wherever the vertex is smooth.
      const tx = Math.min(vx, cols - 1), ty = Math.min(vy, rows - 1);
      v[vy * VC + vx] = corner[(ty * cols + tx) * 4 + (vx > tx ? (vy > ty ? 2 : 1) : vy > ty ? 3 : 0)]!;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = v.slice();
    for (let vy = 1; vy < VR - 1; vy++) {
      for (let vx = 1; vx < VC - 1; vx++) {
        const i = vy * VC + vx;
        if (!smooth[i]) continue;
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy * VC + dx;
          if (smooth[j]) { sum += v[j]!; n++; }
        }
        next[i] = sum / n;
      }
    }
    v = next;
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([cx, cy], k) => {
        const i = (y + cy!) * VC + x + cx!;
        if (smooth[i]) corner[(y * cols + x) * 4 + k] = v[i]!;
      });
    }
  }
}

export interface HeightLayer {
  /** The sortable pieces built so far. */
  readonly chunks: readonly Chunk[];
  /** Build what has come near a box of world tiles, and put the pieces that overlap it into the sorted container; true while some still wait for budget. */
  cull(view: TileBox, budget?: BuildBudget): boolean;
}

/**
 * Draw every tile with any raised corner: its surface, lit by which way it slopes, then the
 * cliff faces toward the viewer where the next tile's edge is lower. A tile sorts by its back
 * corner (x + y), so it covers what stands behind it and is covered by what stands on or in front of it.
 * Pieces go into `objects` (the depth-sorted container) only while on screen. `forest` tiles
 * (scenery.ts forestTiles) take the forest floor colour, as they do on flat ground. Built per
 * region of `region` tiles as they come near the view (all at once with one region).
 */
export function createHeightLayer(map: MapDef, field: HeightField, objects: Container, forest: (x: number, y: number) => boolean = () => false, region = Math.max(map.size.cols, map.size.rows), hooks: { onBuild?(c: Chunk[]): void; onDrop?(c: Chunk[]): void } = {}, tiles: MapTiles = mapTiles(map, null)): HeightLayer {
  if (!field.raised) return { chunks: [], cull: () => false };
  const { cols, rows } = map.size;
  // Scree: ground near a mesa turns from grass to broken rock toward the cliff foot.
  const scree = (x: number, y: number) => {
    if (field.plateauOf(x, y) >= 0) return 1;
    let d = Infinity;
    for (let dy = -SCREE_TILES; dy <= SCREE_TILES; dy++) for (let dx = -SCREE_TILES; dx <= SCREE_TILES; dx++) {
      if (field.plateauOf(x + dx, y + dy) >= 0) d = Math.min(d, Math.hypot(dx, dy));
    }
    return Math.max(0, 1 - (d - 1) / SCREE_TILES);
  };
  const hidden = (x: number, y: number) => {
    const k = field.plateauOf(x, y);
    if (k < 0) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (field.plateauOf(x + dx, y + dy) !== k) return false;
    return true;
  };
  const build = (r: TileBox): Chunk[] => {
    const cells = new SortedCells('ground', 32);
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const [tl, tr, br, bl] = field.corners(x, y);
        if (tl + tr + br + bl === 0 || hidden(x, y)) continue;
        const g = cells.at(x + y - 0.01, x + 0.5, y + 0.5, Math.max(tl, tr, br, bl));
        const zone = map.zoneLegend[tiles.zone(x, y)]!;
        const t = scree(x, y) * (0.75 + 0.25 * hash(x * 3, y * 5));
        const woods = forest(x, y);
        const base = woods ? FOREST_FLOOR : mix(SURFACE[zone] ?? GROUND, SCREE_COLOUR, zone === 'open' || zone === 'blocked' ? t : 0);
        // Slopes rising toward +x or +y face the light (from up the screen) and are brighter.
        const sx = (tr + br - tl - bl) / 2, sy = (bl + br - tl - tr) / 2;
        const wet = zone === 'water' || zone === 'deep';
        const k = wet ? 1 : Math.min(1.3, Math.max(0.65, 1 + 0.6 * (sx + sy))) * (1 + 0.025 * Math.max(tl, tr, br, bl));
        g.poly([...isoPoly([[x, y]], tl), ...isoPoly([[x + 1, y]], tr), ...isoPoly([[x + 1, y + 1]], br), ...isoPoly([[x, y + 1]], bl)]).fill(shade(base, k));
        // Sand spots and mud puddles, as on flat ground, at the height of the slope under them.
        const spot = zone === 'open' ? sandSpot(x, y) : null;
        if (spot) g.poly(spotPoly(spot, field.groundZ(spot.x, spot.y))).fill(mix(SPOT_COLOURS[spot.k]!, SCREE_COLOUR, t * 0.6));
        const puddle = zone === 'slow' ? mudPuddle(x, y) : null;
        if (puddle) {
          const z = field.groundZ(puddle.x, puddle.y);
          g.poly(spotPoly({ x: puddle.x, y: puddle.y, r: puddle.s * 1.4 }, z)).fill(shade(MUD_COLOUR, 0.8 * k));
          if (puddle.glint) oval(g, isoX(puddle.x, puddle.y) - puddle.s * 8, isoY(puddle.x, puddle.y, z) - puddle.s * 3, puddle.s * 9, puddle.s * 2.5).fill({ color: 0xffffff, alpha: 0.18 });
        }
        // Cliff faces on the +x edge (TR to BR) and the +y edge (BR to BL), down to the neighbour's edge.
        const faces: [number, number, number, number, number, number, number, number, number, number][] = [];
        const [ntl, , , nbl] = field.corners(x + 1, y);
        faces.push([x + 1, y, x + 1, y + 1, tr, br, x + 1 < cols ? ntl : 0, x + 1 < cols ? nbl : 0, 1, 0]);
        const [ntl2, ntr2] = field.corners(x, y + 1);
        faces.push([x + 1, y + 1, x, y + 1, br, bl, y + 1 < rows ? ntr2 : 0, y + 1 < rows ? ntl2 : 0, 0, 1]);
        for (const [ax, ay, ex, ey, za, ze, la, le, nx, ny] of faces) {
          if (za - la < 0.05 && ze - le < 0.05) continue;
          if (!facesViewer(nx, ny)) continue;
          const kf = 0.72 + 0.16 * (ny - nx);
          g.poly([...isoPoly([[ax, ay]], la), ...isoPoly([[ex, ey]], le), ...isoPoly([[ex, ey]], ze), ...isoPoly([[ax, ay]], za)]).fill(shade(CLIFF_COLOUR, kf));
          // Strata: a darker line across the face every level.
          for (let z = LEVEL_TILES; z < Math.max(za, ze) - 0.05; z += LEVEL_TILES) {
            if (z <= Math.min(la, le)) continue;
            g.moveTo(...(isoPoly([[ax, ay]], Math.min(z, za)) as [number, number])).lineTo(...(isoPoly([[ex, ey]], Math.min(z, ze)) as [number, number]));
          }
          g.stroke({ width: 1.5, color: shade(CLIFF_COLOUR, kf * 0.75) });
        }
      }
    }
    return cells.chunks();
  };
  // Raised ground stands at most a few levels high, which reaches that far up the screen.
  const lazy = new LazyChunks(regionUnits(map, region, 12, build), hooks);
  if (region >= Math.max(cols, rows)) lazy.buildAll();
  return {
    get chunks() { return lazy.chunks; },
    cull(view, budget) {
      const waiting = lazy.update(view, budget);
      cullSorted(lazy.chunks, view, objects);
      return waiting;
    },
  };
}

/** A small least-recently-used cache. */
class Lru<V> {
  private readonly m = new Map<number, V>();
  constructor(private readonly keep: number) {}
  get(k: number): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: number, v: V): void {
    this.m.set(k, v);
    if (this.m.size > this.keep) this.m.delete(this.m.keys().next().value!);
  }
}

/** Plateau floods give up past this many tiles: only the ground is that big. */
const FLOOD_CAP = 200_000;

/**
 * The height field of a streamed map (G5), worked out chunk by chunk from the tiles near each
 * chunk, never the whole map. The same rules as the whole-map field, kept local:
 * - A plateau is a region joined by steps of at most one level that holds no level-0 tile and
 *   rises above the lowest tile beside it. The ground always holds level 0, so a flood that meets
 *   level 0 stops at once; a plateau is flooded whole the first time one of its tiles is asked about.
 * - The ground under a plateau is filled from the tiles round it and smoothed, per plateau, in the
 *   same order as the whole-map pass, so an isolated plateau gets the same ground.
 * - Corner heights, and the smoothing of slopes, only reach a few tiles, so each chunk's corners
 *   come from its tiles and four more round it.
 * Plateau labels and corners are kept for the chunks used most recently, and worked out again
 * (the same) when needed after being dropped.
 */
function streamedHeightField(tiles: MapTiles): HeightField {
  const { cols, rows } = tiles, T = CHUNK_TILES;
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;
  const key = (cx: number, cy: number) => cy * 100_003 + cx;
  /** Per chunk: -2 not known yet, -1 not a plateau, else the plateau's index. */
  const labels = new Lru<Int32Array>(256);
  const plateaus: (Plateau & { ground: Float32Array | null; index: Map<number, number> })[] = [];
  const byFirst = new Map<number, number>();
  const labelsOf = (cx: number, cy: number) => {
    let l = labels.get(key(cx, cy));
    if (!l) labels.set(key(cx, cy), l = new Int32Array(T * T).fill(-2));
    return l;
  };
  const setLabel = (x: number, y: number, v: number) => { const cx = Math.floor(x / T), cy = Math.floor(y / T); labelsOf(cx, cy)[(y - cy * T) * T + (x - cx * T)] = v; };

  const flood = (x0: number, y0: number): number => {
    if (tiles.level(x0, y0) === 0) { setLabel(x0, y0, -1); return -1; }
    const seen = new Set<number>([y0 * cols + x0]);
    const order: number[] = [y0 * cols + x0];
    let zero = false;
    for (let q = 0; q < order.length && !zero && order.length < FLOOD_CAP; q++) {
      const i = order[q]!, x = i % cols, y = (i - x) / cols, l = tiles.level(x, y);
      for (const [dx, dy] of SIDES4) {
        const nx = x + dx, ny = y + dy, j = ny * cols + nx;
        if (!inMap(nx, ny) || seen.has(j)) continue;
        const lj = tiles.level(nx, ny);
        if (Math.abs(lj - l) > 1) continue;
        seen.add(j); order.push(j);
        if (lj === 0) { zero = true; break; }
      }
    }
    const ground = () => { for (const i of order) setLabel(i % cols, Math.floor(i / cols), -1); return -1; };
    if (zero || order.length >= FLOOD_CAP) return ground();
    let low = Infinity, outside = Infinity;
    for (const i of order) {
      const x = i % cols, y = (i - x) / cols;
      low = Math.min(low, tiles.level(x, y));
      for (const [dx, dy] of SIDES4) if (inMap(x + dx, y + dy) && !seen.has(i + dy * cols + dx)) outside = Math.min(outside, tiles.level(x + dx, y + dy));
    }
    if (!(low > outside)) return ground();
    const sorted = [...order].sort((a, b) => a - b);
    let k = byFirst.get(sorted[0]!);
    if (k === undefined) { k = plateaus.length; byFirst.set(sorted[0]!, k); plateaus.push(makePlateau(sorted, seen)); }
    for (const i of sorted) setLabel(i % cols, Math.floor(i / cols), k);
    return k;
  };

  /** A plateau from its tiles (ascending): its top now, the ground under it when first asked for (fillGround). */
  const makePlateau = (own: number[], member: ReadonlySet<number>) => {
    const index = new Map<number, number>();
    own.forEach((i, n) => index.set(i, n));
    // Its top: each corner the average of its own tiles round it within one level.
    const top = new Float32Array(own.length * 4);
    own.forEach((i, n) => {
      const x = i % cols, y = (i - x) / cols, li = tiles.level(x, y);
      for (let c = 0; c < 4; c++) {
        const [cx, cy] = CORNERS[c]!;
        let sum = 0, m = 0;
        for (const [dx, dy] of AROUND) {
          const nx = x + cx + dx, ny = y + cy + dy;
          if (!inMap(nx, ny)) continue;
          const j = ny * cols + nx;
          if (j !== i && !(member.has(j) && Math.abs(tiles.level(nx, ny) - li) <= 1)) continue;
          sum += tiles.level(nx, ny); m++;
        }
        top[n * 4 + c] = (sum / m) * LEVEL_TILES;
      }
    });
    const p = {
      id: own[0]!, tiles: own, ground: null as Float32Array | null, index,
      topZ(x: number, y: number) {
        let tx = Math.floor(x), ty = Math.floor(y);
        let n = index.get(ty * cols + tx);
        if (n === undefined) {
          let best = Infinity;
          for (const i of own) {
            const ix = i % cols, iy = (i - ix) / cols, d = Math.max(Math.abs(ix + 0.5 - x), Math.abs(iy + 0.5 - y));
            if (d < best) { best = d; tx = ix; ty = iy; }
          }
          n = index.get(ty * cols + tx)!;
        }
        return bilinear(top, n * 4, Math.min(1, Math.max(0, x - tx)), Math.min(1, Math.max(0, y - ty)));
      },
    };
    return p;
  };

  const plateauOf = (x: number, y: number): number => {
    if (!inMap(x, y)) return -1;
    const cx = Math.floor(x / T), cy = Math.floor(y / T);
    const v = labelsOf(cx, cy)[(y - cy * T) * T + (x - cx * T)]!;
    return v === -2 ? flood(x, y) : v;
  };
  /**
   * The ground under plateau `k` and every plateau touching it (a mesa on a mesa): filled in from the
   * ground round them all, breadth first from its tiles in map order, then relaxed toward the average
   * of its neighbours, as the whole-map pass does.
   */
  const fillGround = (k: number) => {
    const cluster = [k], ks = new Set([k]), member = new Set(plateaus[k]!.tiles);
    for (let q = 0; q < cluster.length; q++) {
      for (const i of plateaus[cluster[q]!]!.tiles) {
        const x = i % cols, y = (i - x) / cols;
        for (const [dx, dy] of SIDES4) {
          const nx = x + dx, ny = y + dy, j = ny * cols + nx;
          if (!inMap(nx, ny) || member.has(j) || tiles.level(nx, ny) === 0) continue;
          const m = plateauOf(nx, ny);
          if (m < 0 || ks.has(m)) continue;
          ks.add(m); cluster.push(m);
          for (const t of plateaus[m]!.tiles) member.add(t);
        }
      }
    }
    const value = new Map<number, number>();
    const valueOf = (i: number) => value.get(i) ?? tiles.level(i % cols, Math.floor(i / cols));
    const ring = new Set<number>();
    for (const i of member) {
      const x = i % cols, y = (i - x) / cols;
      for (const [dx, dy] of SIDES4) { const j = i + dy * cols + dx; if (inMap(x + dx, y + dy) && !member.has(j)) ring.add(j); }
    }
    const queue = [...ring].sort((a, b) => a - b);
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!, x = i % cols, y = (i - x) / cols;
      for (const [dx, dy] of SIDES4) {
        const j = i + dy * cols + dx;
        if (!inMap(x + dx, y + dy) || !member.has(j) || value.has(j)) continue;
        value.set(j, valueOf(i)); queue.push(j);
      }
    }
    const inner = queue.filter((i) => member.has(i));
    for (let pass = 0; pass < 30; pass++) {
      for (const i of inner) {
        const x = i % cols, y = (i - x) / cols;
        let sum = 0, n = 0;
        for (const [dx, dy] of SIDES4) if (inMap(x + dx, y + dy)) { sum += valueOf(i + dy * cols + dx); n++; }
        // Rounded as the whole-map pass stores it (a Float32Array), so a step right at one level reads the same.
        value.set(i, Math.fround(sum / n));
      }
    }
    for (const m of cluster) {
      const p = plateaus[m]!;
      p.ground = Float32Array.from(p.tiles, (i) => value.get(i)!);
    }
  };

  /** The ground's level at a tile: a plateau's filled ground under it, else its own level. */
  const groundAt = (x: number, y: number) => {
    const k = plateauOf(x, y);
    if (k < 0) return tiles.level(x, y);
    const p = plateaus[k]!;
    if (!p.ground) fillGround(k);
    return p.ground![p.index.get(y * cols + x)!]!;
  };

  // Corner heights per chunk: from the ground of the chunk and four tiles round it.
  const cornerCache = new Lru<Float32Array>(128);
  const M = 4;
  const chunkCorners = (cx: number, cy: number): Float32Array => {
    const have = cornerCache.get(key(cx, cy));
    if (have) return have;
    const x0 = cx * T - M, y0 = cy * T - M, W = T + 2 * M;
    const g = new Float32Array(W * W).fill(NaN);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (inMap(x0 + x, y0 + y)) g[y * W + x] = groundAt(x0 + x, y0 + y);
    const gl = (x: number, y: number) => (inMap(x, y) ? g[(y - y0) * W + (x - x0)]! : -1);
    // Corners of the chunk's tiles and two more round them, as tileCorners does.
    const R = 2, CW = T + 2 * R + 1, cX0 = cx * T - R, cY0 = cy * T - R;
    const corner = new Float32Array(CW * CW * 4);
    for (let ty = 0; ty < CW; ty++) {
      for (let tx = 0; tx < CW; tx++) {
        const x = cX0 + tx, y = cY0 + ty;
        if (!inMap(x, y)) continue;
        const gi = gl(x, y);
        for (let k = 0; k < 4; k++) {
          const [ox, oy] = CORNERS[k]!;
          let sum = 0, n = 0;
          for (const [dx, dy] of AROUND) {
            const nx = x + ox + dx, ny = y + oy + dy;
            if (!inMap(nx, ny)) continue;
            const gj = gl(nx, ny);
            if ((nx !== x || ny !== y) && Math.abs(gj - gi) > 1) continue;
            sum += gj; n++;
          }
          corner[(ty * CW + tx) * 4 + k] = (sum / n) * LEVEL_TILES;
        }
      }
    }
    const cornerAt = (x: number, y: number, k: number) => corner[((y - cY0) * CW + (x - cX0)) * 4 + k]!;
    // Vertices from (cx T - 2, cy T - 2) to two past the chunk's far edge, smoothed as smoothCorners does.
    const VX0 = cx * T - R, VY0 = cy * T - R, VW = T + 2 * R + 1;
    const smooth = new Uint8Array(VW * VW);
    let v = new Float32Array(VW * VW);
    for (let j = 0; j < VW; j++) {
      for (let i = 0; i < VW; i++) {
        const vx = VX0 + i, vy = VY0 + j;
        if (vx < 0 || vy < 0 || vx > cols || vy > rows) continue;
        let lo = Infinity, hi = -Infinity;
        for (const [dx, dy] of AROUND) {
          const l = gl(vx + dx, vy + dy);
          if (l < 0) continue;
          lo = Math.min(lo, l); hi = Math.max(hi, l);
        }
        smooth[j * VW + i] = hi - lo <= 1 ? 1 : 0;
        const tx = Math.min(vx, cols - 1), ty = Math.min(vy, rows - 1);
        v[j * VW + i] = cornerAt(tx, ty, vx > tx ? (vy > ty ? 2 : 1) : vy > ty ? 3 : 0);
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const next = v.slice();
      for (let j = 1; j < VW - 1; j++) {
        for (let i = 1; i < VW - 1; i++) {
          const vx = VX0 + i, vy = VY0 + j;
          if (vx < 1 || vy < 1 || vx > cols - 1 || vy > rows - 1) continue;
          const at = j * VW + i;
          if (!smooth[at]) continue;
          let sum = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const b = at + dy * VW + dx;
            if (smooth[b]) { sum += v[b]!; n++; }
          }
          next[at] = sum / n;
        }
      }
      v = next;
    }
    const out = new Float32Array(T * T * 4);
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const gx = cx * T + x, gy = cy * T + y;
        if (!inMap(gx, gy)) continue;
        for (let k = 0; k < 4; k++) {
          const [ox, oy] = CORNERS[k]!;
          const at = (gy + oy - VY0) * VW + (gx + ox - VX0);
          out[(y * T + x) * 4 + k] = smooth[at] ? v[at]! : cornerAt(gx, gy, k);
        }
      }
    }
    cornerCache.set(key(cx, cy), out);
    return out;
  };
  const cornersAt = (x: number, y: number): [Float32Array, number] => {
    const cx = Math.floor(x / T), cy = Math.floor(y / T);
    return [chunkCorners(cx, cy), ((y - cy * T) * T + (x - cx * T)) * 4];
  };
  const groundZ = (x: number, y: number) => {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!inMap(tx, ty)) return 0;
    const [c, o] = cornersAt(tx, ty);
    return bilinear(c, o, x - tx, y - ty);
  };
  return {
    raised: true,
    plateaus: [],
    corners(x, y) {
      if (!inMap(x, y)) return [0, 0, 0, 0];
      const [c, o] = cornersAt(x, y);
      return [c[o]!, c[o + 1]!, c[o + 2]!, c[o + 3]!];
    },
    groundZ,
    plateauOf,
    plateau: (k) => plateaus[k]!,
    plateausIn(box) {
      const out = new Set<number>();
      for (let y = Math.max(0, box.y0); y < Math.min(rows, box.y1); y++) {
        for (let x = Math.max(0, box.x0); x < Math.min(cols, box.x1); x++) {
          // Only raised tiles can be on a plateau; the rest need no flood.
          if (tiles.level(x, y) === 0) continue;
          const k = plateauOf(x, y);
          if (k >= 0) out.add(k);
        }
      }
      return [...out].sort((a, b) => plateaus[a]!.id - plateaus[b]!.id);
    },
    surfaceZ(x, y) {
      const k = plateauOf(Math.floor(x), Math.floor(y));
      return k < 0 ? groundZ(x, y) : plateaus[k]!.topZ(x, y);
    },
  };
}
