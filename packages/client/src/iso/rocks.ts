// Boulders on blocked ground, drawn as low-poly rocks with height so they read as solid in the
// isometric view (Devlin, extra-maps playtest 2026-10-11). Blocked tiles are grouped into 2 × 2
// cells, one boulder per cell, and the boulders are bucketed by depth into strips that sort
// against the horse and cars. A strip runs along x + y = const, a horizontal band on screen, so
// strips off the top or bottom of the screen are hidden each frame.
import type { Container, Graphics } from 'pixi.js';
import { cullSorted, LazyChunks, regionUnits, SortedCells, type BuildBudget, type Chunk, type TileBox } from './cells';
import { decodeZones, type MapDef } from '@train-robber/config';
import { facesViewer, isoPoly, shade } from './draw';
import { depthOf } from '../projection';
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
  /** The sortable pieces built so far, for the see-through hole (iso/mesa.ts). */
  readonly chunks: readonly Chunk[];
  /** Build what has come near a box of world tiles, and put the pieces that overlap it into the sorted container; true while some still wait for budget. */
  cull(view: TileBox, budget?: BuildBudget): boolean;
}

/**
 * Boulders in pieces by depth and stretch across the screen; pieces go into `objects` only while
 * on screen. Built per region of `region` tiles as they come near the view (all at once with one
 * region); `hooks` hear about pieces being built and dropped.
 */
export function createRocks(map: MapDef, objects: Container, field?: HeightField, skip?: ReadonlySet<number>, region = Math.max(map.size.cols, map.size.rows), hooks: { onBuild?(c: Chunk[]): void; onDrop?(c: Chunk[]): void } = {}): RockLayer {
  const placed = placeBoulders(map, skip, field?.raised ? (x, y) => field.plateauOf(Math.floor(x), Math.floor(y)) >= 0 : undefined);
  // Back to front, then left to right along a depth; neighbours share a depth, so their order barely shows.
  placed.sort((a, c) => Math.floor(depthOf(a.x, a.y)) - Math.floor(depthOf(c.x, c.y)) || a.x - a.y - (c.x - c.y));
  // Each boulder by the region its centre is in, keeping the back-to-front order.
  const across = Math.ceil(map.size.cols / region), down = Math.ceil(map.size.rows / region), byRegion = new Map<number, Boulder[]>();
  for (const b of placed) {
    const k = Math.min(down - 1, Math.max(0, Math.floor(b.y / region))) * across + Math.min(across - 1, Math.max(0, Math.floor(b.x / region)));
    const list = byRegion.get(k);
    if (list) list.push(b); else byRegion.set(k, [b]);
  }
  const lazy = new LazyChunks(regionUnits(map, region, ROCK_MAX_HEIGHT + 4, (_r, index) => {
    const cells = new SortedCells('rocks', 32, 2);
    for (const b of byRegion.get(index) ?? []) {
      const z = field?.surfaceZ(b.x, b.y) ?? 0;
      // A boulder covers the strip below its centre's floor depth up to its radius, so sort it by its centre.
      drawBoulder(cells.at(Math.floor(depthOf(b.x, b.y)) + 0.5, b.x, b.y, z + b.h), b, z);
    }
    return cells.chunks();
  }), hooks);
  if (region >= Math.max(map.size.cols, map.size.rows)) lazy.buildAll();
  return {
    get chunks() { return lazy.chunks; },
    cull(view, budget) {
      const waiting = lazy.update(view, budget);
      cullSorted(lazy.chunks, view, objects);
      return waiting;
    },
  };
}
