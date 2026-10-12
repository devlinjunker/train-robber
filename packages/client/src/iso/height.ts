// Ground height in the isometric view, from the map's optional elevation layer (Devlin,
// 2026-10-12: cliffs and hills you can see; the sim stays flat). Each tile corner takes the
// average height of the tiles around it that are within one level of each other, so a step of
// one level is a slope and a bigger step leaves a gap that is drawn as a cliff face.
// Raised tiles are drawn in depth strips that sort with the horse and cars, like the boulders.
import { Graphics } from 'pixi.js';
import { decodeElevation, decodeZones, type MapDef, type Zone } from '@train-robber/config';
import { facesViewer, isoPoly, shade } from './draw';
import { GROUND, hash, MUD_COLOUR } from './terrain';
import { TILE_H, Z_PX } from '../projection';

/** Height of one elevation level, in tiles of z. */
export const LEVEL_TILES = 0.6;
const CLIFF_COLOUR = 0x8c7a62;
const SURFACE: Partial<Record<Zone, number>> = { open: GROUND, slow: MUD_COLOUR, blocked: 0x6a655c };

export interface HeightField {
  /** False when the map has no raised ground: everything else is then a no-op. */
  raised: boolean;
  /** Ground height in tiles of z under a world point. */
  groundZ(x: number, y: number): number;
  /** Corner heights of tile (x, y): top-left, top-right, bottom-right, bottom-left. */
  corners(x: number, y: number): [number, number, number, number];
}

export function createHeightField(map: Pick<MapDef, 'size' | 'elevation'>): HeightField {
  const { cols, rows } = map.size;
  const level = decodeElevation(map);
  const raised = level.some((l) => l > 0);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? -1 : level[y * cols + x]!);
  // Per tile, its four corner heights (only filled for maps with raised ground).
  const corner = new Float32Array(raised ? cols * rows * 4 : 0);
  if (raised) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const own = level[y * cols + x]!;
        // Corners in order TL, TR, BR, BL; each is shared by the 2 × 2 tiles around it.
        [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([cx, cy], k) => {
          let sum = 0, n = 0;
          for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
            const l = at(x + cx! + dx, y + cy! + dy);
            if (l < 0 || Math.abs(l - own) > 1) continue;
            sum += l; n++;
          }
          corner[(y * cols + x) * 4 + k] = (sum / n) * LEVEL_TILES;
        });
      }
    }
  }
  if (raised) {
    // Soften slopes: where no cliff meets a vertex, its height is the average of the vertices
    // around it (two passes), so hills read as rounded rather than stepped.
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
  const corners = (x: number, y: number): [number, number, number, number] => {
    if (!raised || x < 0 || y < 0 || x >= cols || y >= rows) return [0, 0, 0, 0];
    const o = (y * cols + x) * 4;
    return [corner[o]!, corner[o + 1]!, corner[o + 2]!, corner[o + 3]!];
  };
  return {
    raised,
    corners,
    groundZ(x, y) {
      if (!raised) return 0;
      const tx = Math.floor(x), ty = Math.floor(y), fx = x - tx, fy = y - ty;
      const [tl, tr, br, bl] = corners(tx, ty);
      return (tl * (1 - fx) + tr * fx) * (1 - fy) + (bl * (1 - fx) + br * fx) * fy;
    },
  };
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
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const [tl, tr, br, bl] = field.corners(x, y);
      if (tl + tr + br + bl === 0) continue;
      const g = strip(x + y);
      const zone = map.zoneLegend[zones[y * cols + x]!]!;
      const base = SURFACE[zone] ?? GROUND;
      // Slopes rising toward +x or +y face the light (from up the screen) and are brighter.
      const sx = (tr + br - tl - bl) / 2, sy = (bl + br - tl - tr) / 2;
      const k = Math.min(1.3, Math.max(0.65, 1 + 0.6 * (sx + sy))) * (1 + 0.025 * Math.max(tl, tr, br, bl));
      g.poly([...isoPoly([[x, y]], tl), ...isoPoly([[x + 1, y]], tr), ...isoPoly([[x + 1, y + 1]], br), ...isoPoly([[x, y + 1]], bl)]).fill(shade(base, k));
      if (zone === 'open' && hash(x + 17, y + 3) < 0.12) {
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
