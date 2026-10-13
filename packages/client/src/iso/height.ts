// Ground height in the isometric view, from the map's optional elevation layer (Devlin,
// 2026-10-12: cliffs and hills you can see; the sim stays flat). Each tile corner takes the
// average height of the tiles around it that are within one level of each other, so a step of
// one level is a slope and a bigger step leaves a gap that is drawn as a cliff face.
// Raised tiles are drawn in depth strips that sort with the horse and cars, like the boulders.
// Ground cut off by cliffs all round is a plateau: the ground runs on under it and iso/mesa.ts
// draws it as a rounded mesa on top (PR #25 playtest, 2026-10-13).
import { Graphics } from 'pixi.js';
import { decodeElevation, decodeZones, type MapDef, type Zone } from '@train-robber/config';
import { facesViewer, isoPoly, mix, shade } from './draw';
import { GROUND, hash, MUD_COLOUR } from './terrain';
import { TILE_H, Z_PX } from '../projection';

/** Height of one elevation level, in tiles of z. */
export const LEVEL_TILES = 0.6;
const CLIFF_COLOUR = 0x8c7a62;
const SCREE_COLOUR = 0x9c8462, SCREE_TILES = 3;
const SURFACE: Partial<Record<Zone, number>> = { open: GROUND, slow: MUD_COLOUR, blocked: 0x6a655c };

export interface HeightField {
  /** False when the map has no raised ground: everything else is then a no-op. */
  raised: boolean;
  /** Ground height in tiles of z under a world point. Under a mesa this is the ground its cliffs stand on. */
  groundZ(x: number, y: number): number;
  /** Height of whatever is drawn at a world point: a mesa's top, or the ground. */
  surfaceZ(x: number, y: number): number;
  /** Corner heights of tile (x, y) on the ground: top-left, top-right, bottom-right, bottom-left. */
  corners(x: number, y: number): [number, number, number, number];
  /** Raised ground cut off by cliffs all round, drawn as mesas (iso/mesa.ts); lowest first. */
  plateaus: Plateau[];
  /** Which plateau tile (x, y) belongs to, or -1 for the ground. */
  plateauOf(x: number, y: number): number;
}

/** One mesa: tiles joined by steps of at most one level, rising by a cliff from everything around them. */
export interface Plateau {
  tiles: number[];
  /** Height of its top at a world point, from its own tiles (the nearest one outside them). */
  topZ(x: number, y: number): number;
}

const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Corner heights of every tile, each the average of the tiles round the corner that `joins` the tile. */
function cornerHeights(cols: number, rows: number, level: ArrayLike<number>, joins: (i: number, j: number) => boolean): Float32Array {
  const corner = new Float32Array(cols * rows * 4);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      // Corners in order TL, TR, BR, BL; each is shared by the 2 × 2 tiles around it.
      [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([cx, cy], k) => {
        let sum = 0, n = 0;
        for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
          const nx = x + cx! + dx, ny = y + cy! + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (j !== i && !joins(i, j)) continue;
          sum += level[j]!; n++;
        }
        corner[i * 4 + k] = (sum / n) * LEVEL_TILES;
      });
    }
  }
  return corner;
}

const bilinear = (c: ArrayLike<number>, o: number, fx: number, fy: number) =>
  (c[o]! * (1 - fx) + c[o + 1]! * fx) * (1 - fy) + (c[o + 3]! * (1 - fx) + c[o + 2]! * fx) * fy;

export function createHeightField(map: Pick<MapDef, 'size' | 'elevation'>): HeightField {
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
      const own = cornerHeights(cols, rows, level, (i, j) => owner[i] === k && owner[j] === k && Math.abs(level[j]! - level[i]!) <= 1);
      const top = new Float32Array(tiles.length * 4), index = new Map<number, number>();
      tiles.forEach((i, n) => { index.set(i, n); top.set(own.subarray(i * 4, i * 4 + 4), n * 4); });
      plateaus.push({
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
  /** One sortable strip per row of depth; add them to the depth-sorted container. */
  strips: Graphics[];
  /** Show only strips that can reach the screen band between `top` and `bottom` (unzoomed iso y pixels). */
  cull(top: number, bottom: number): void;
}

/**
 * Draw every tile with any raised corner: its surface, lit by which way it slopes, then the
 * cliff faces toward the viewer where the next tile's edge is lower. A tile sorts by its back
 * corner (x + y), so it covers what stands behind it and is covered by what stands on or in front of it.
 */
export function createHeightLayer(map: MapDef, field: HeightField): HeightLayer {
  const strips: Graphics[] = [], depths: number[] = [];
  if (!field.raised) return { strips, cull() {} };
  const { cols, rows } = map.size;
  const zones = decodeZones(map);
  const byDepth = new Map<number, Graphics>();
  const strip = (d: number) => {
    let g = byDepth.get(d);
    if (!g) {
      g = new Graphics();
      g.label = `ground-${d}`;
      g.zIndex = d - 0.01;
      byDepth.set(d, g);
    }
    return g;
  };
  // Scree: ground near a mesa turns from grass to broken rock toward the cliff foot.
  const scree = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    const x = i % cols, y = (i - x) / cols;
    if (field.plateauOf(x, y) >= 0) { scree[i] = 1; continue; }
    let d = Infinity;
    for (let dy = -SCREE_TILES; dy <= SCREE_TILES; dy++) for (let dx = -SCREE_TILES; dx <= SCREE_TILES; dx++) {
      if (field.plateauOf(x + dx, y + dy) >= 0) d = Math.min(d, Math.hypot(dx, dy));
    }
    scree[i] = Math.max(0, 1 - (d - 1) / SCREE_TILES);
  }
  const hidden = (x: number, y: number) => {
    const k = field.plateauOf(x, y);
    if (k < 0) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (field.plateauOf(x + dx, y + dy) !== k) return false;
    return true;
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const [tl, tr, br, bl] = field.corners(x, y);
      if (tl + tr + br + bl === 0 || hidden(x, y)) continue;
      const g = strip(x + y);
      const zone = map.zoneLegend[zones[y * cols + x]!]!;
      const t = scree[y * cols + x]! * (0.75 + 0.25 * hash(x * 3, y * 5));
      const base = mix(SURFACE[zone] ?? GROUND, SCREE_COLOUR, zone === 'open' || zone === 'blocked' ? t : 0);
      // Slopes rising toward +x or +y face the light (from up the screen) and are brighter.
      const sx = (tr + br - tl - bl) / 2, sy = (bl + br - tl - tr) / 2;
      const k = Math.min(1.3, Math.max(0.65, 1 + 0.6 * (sx + sy))) * (1 + 0.025 * Math.max(tl, tr, br, bl));
      g.poly([...isoPoly([[x, y]], tl), ...isoPoly([[x + 1, y]], tr), ...isoPoly([[x + 1, y + 1]], br), ...isoPoly([[x, y + 1]], bl)]).fill(shade(base, k));
      if (zone === 'open' && t < 0.4 && hash(x + 17, y + 3) < 0.12) {
        // A grass tuft, as on flat ground.
        const cx = x + 0.3 + 0.4 * hash(y, x), cy = y + 0.3 + 0.4 * hash(x, y + 9), z = field.groundZ(cx, cy);
        g.poly(isoPoly([[cx, cy - 0.12], [cx + 0.12, cy], [cx, cy + 0.12], [cx - 0.12, cy]], z)).fill(shade(base, k * 0.82));
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
  for (const [d, g] of [...byDepth].sort((a, c) => a[0] - c[0])) { strips.push(g); depths.push(d); }
  const margin = 2 * TILE_H, tallest = 8 * LEVEL_TILES * Z_PX;
  return {
    strips,
    cull(top, bottom) {
      for (let i = 0; i < strips.length; i++) {
        const y = (depths[i]! + 1) * (TILE_H / 2);
        strips[i]!.visible = y + margin >= top && y - tallest - margin <= bottom;
      }
    },
  };
}
