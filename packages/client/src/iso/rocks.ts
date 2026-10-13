// Boulders on blocked ground, drawn as low-poly rocks with height so they read as solid in the
// isometric view (Devlin, extra-maps playtest 2026-10-11). Blocked tiles are grouped into 2 × 2
// cells, one boulder per cell, and the boulders are bucketed by depth into strips that sort
// against the horse and cars. A strip runs along x + y = const, a horizontal band on screen, so
// strips off the top or bottom of the screen are hidden each frame.
import { Graphics } from 'pixi.js';
import { decodeZones, type MapDef } from '@train-robber/config';
import { facesViewer, isoPoly, shade } from './draw';
import { depthOf, TILE_H, Z_PX } from '../projection';
import { hash, onEdge } from './terrain';
import type { HeightField } from './height';

export const ROCK_COLOUR = 0x8b857a;
/** Tallest boulder, in tiles: the strip culling margin. */
export const ROCK_MAX_HEIGHT = 1.9;
const CELL = 2;
/** Corners around a boulder's base. */
const SIDES = 7;

export interface Boulder {
  x: number;
  y: number;
  /** Base radius and height, in tiles. */
  r: number;
  h: number;
  /** Seed for the outline and tint. */
  seed: number;
}

/**
 * One boulder per 2 × 2 cell holding blocked tiles, centred on them and sized to cover them.
 * Tiles in `skip` (forest, drawn by the scenery) get none; `lifted` (a mesa top) gets only a few.
 */
export function placeBoulders(map: MapDef, skip: ReadonlySet<number> = new Set(), lifted?: (x: number, y: number) => boolean): Boulder[] {
  const grid = decodeZones(map), { cols, rows } = map.size, out: Boulder[] = [];
  for (let cy = 0; cy < rows; cy += CELL) {
    for (let cx = 0; cx < cols; cx += CELL) {
      let n = 0, sx = 0, sy = 0;
      for (let y = cy; y < Math.min(rows, cy + CELL); y++) {
        for (let x = cx; x < Math.min(cols, cx + CELL); x++) {
          if (map.zoneLegend[grid[y * cols + x]!] !== 'blocked' || onEdge(map, x, y) || skip.has(y * cols + x)) continue;
          n++; sx += x + 0.5; sy += y + 0.5;
        }
      }
      if (n === 0) continue;
      const seed = hash(cx, cy);
      // On raised rock (a mesa top) only a few boulders, so the cliff and its top still read.
      if (lifted?.(sx / n, sy / n) && seed > 0.3) continue;
      const r = 0.5 + 0.2 * (n - 1) + 0.1 * seed;
      out.push({ x: sx / n + (hash(cy, cx) - 0.5) * 0.2, y: sy / n + (seed - 0.5) * 0.2, r, h: Math.min(ROCK_MAX_HEIGHT, r * (1 + 0.6 * hash(cx + 7, cy + 3))), seed });
    }
  }
  return out;
}

/**
 * Draw one boulder: a ring at the base, a slightly narrower ring part way up and a small top, each
 * jittered around the centre. Only the faces toward the viewer are drawn, shaded by which way
 * they face, then the top, lit. A soft shadow sits on the ground beside it.
 */
export function drawBoulder(g: Graphics, b: Boulder, z0 = 0): void {
  const ring = (k: number, z: number, turn: number): [number, number, number][] => Array.from({ length: SIDES }, (_, i) => {
    const a = ((i + turn) / SIDES) * Math.PI * 2 + b.seed * 6;
    const rr = b.r * k * (0.82 + 0.3 * hash(Math.round(b.seed * 1e6) + i, Math.round(k * 10)));
    return [b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr, z0 + z];
  });
  const base = ring(1, 0, 0), mid = ring(0.9, b.h * 0.55, 0.15), top = ring(0.5, b.h, 0.3);
  const colour = shade(ROCK_COLOUR, 0.88 + 0.24 * b.seed);
  g.poly(isoPoly(base.map(([x, y]) => [x + 0.35, y + 0.35] as [number, number]), z0)).fill({ color: 0x000000, alpha: 0.25 });
  for (const [lo, hi] of [[base, mid], [mid, top]] as const) {
    for (let i = 0; i < SIDES; i++) {
      const a = lo[i]!, e = lo[(i + 1) % SIDES]!, c = hi[(i + 1) % SIDES]!, d = hi[i]!;
      // Outward normal of the lower edge, as in drawBox.
      let nx = e[1] - a[1], ny = a[0] - e[0];
      if (nx * ((a[0] + e[0]) / 2 - b.x) + ny * ((a[1] + e[1]) / 2 - b.y) < 0) { nx = -nx; ny = -ny; }
      const n = Math.hypot(nx, ny) || 1;
      nx /= n; ny /= n;
      if (!facesViewer(nx, ny)) continue;
      // Lower faces a little darker; the upper band catches more light.
      const k = (lo === base ? 0.7 : 0.82) + 0.16 * (ny - nx);
      g.poly([a, e, c, d].flatMap(([x, y, z]) => isoPoly([[x, y]], z))).fill(shade(colour, k));
    }
  }
  g.poly(top.flatMap(([x, y, z]) => isoPoly([[x, y]], z))).fill(shade(colour, 1.15));
}

export interface RockLayer {
  /** One sortable strip per unit of depth; add them to the depth-sorted container. */
  strips: Graphics[];
  /** Show only strips that can reach the screen band between `top` and `bottom` (unzoomed iso y pixels). */
  cull(top: number, bottom: number): void;
}

export function createRocks(map: MapDef, field?: HeightField, skip?: ReadonlySet<number>): RockLayer {
  const byDepth = new Map<number, Boulder[]>();
  for (const b of placeBoulders(map, skip, field?.raised ? (x, y) => field.plateauOf(Math.floor(x), Math.floor(y)) >= 0 : undefined)) {
    const d = Math.floor(depthOf(b.x, b.y));
    let list = byDepth.get(d);
    if (!list) byDepth.set(d, (list = []));
    list.push(b);
  }
  const strips: Graphics[] = [], depths: number[] = [];
  for (const [d, list] of [...byDepth].sort((a, c) => a[0] - c[0])) {
    const g = new Graphics();
    g.label = `rocks-${d}`;
    // Left to right along the strip; neighbours share a depth, so their order barely shows.
    for (const b of list.sort((a, c) => a.x - a.y - (c.x - c.y))) drawBoulder(g, b, field?.surfaceZ(b.x, b.y) ?? 0);
    // A boulder covers the strip below its centre's floor depth up to its radius, so sort it by its centre.
    g.zIndex = d + 0.5;
    strips.push(g); depths.push(d);
  }
  const margin = 2 * TILE_H;
  return {
    strips,
    cull(top, bottom) {
      for (let i = 0; i < strips.length; i++) {
        // Ground y of the strip's centre line; boulders rise above it and spread a tile or two below.
        const y = (depths[i]! + 0.5) * (TILE_H / 2);
        const lift = field?.raised ? 8 * 0.6 * Z_PX : 0;
        strips[i]!.visible = y + margin >= top && y - ROCK_MAX_HEIGHT * Z_PX - lift - margin <= bottom;
      }
    },
  };
}
