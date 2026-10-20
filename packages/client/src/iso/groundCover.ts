// Grass tufts and scrub brush scattered over open ground at random each time a map loads. Not
// part of any map file and never seen by the sim: it only breaks up the plain grass.
import { Container, Graphics } from 'pixi.js';
import { decodeZones, type MapDef } from '@train-robber/config';
import { addChunks, Cells, cullChunks, LazyChunks, regionUnits, type BuildBudget, type Chunk, type TileBox } from './cells';
import { groundEllipse, shade, oval } from './draw';
import { isoX, isoY } from '../projection';
import { GROUND } from './terrain';

/** Items per open tile. */
const GRASS_DENSITY = 0.14, SCRUB_DENSITY = 0.03;
/**
 * Thick patches (Devlin, 2026-10-13: "some thick patches of grass and shrub would be nice"): one
 * per this many tiles of map, densest at the centre. Looks only; they never slow the horse.
 */
const PATCH_EVERY = 2500, PATCH_GRASS = 0.9, PATCH_SCRUB = 0.35;
/** Keep this many tiles round the track bare, so the ties and the lanes beside the cars read clearly. */
const TRACK_CLEAR = 2;
/** Drawn in square cells of this many tiles, so off-screen cells cull. */
const CELL = 24;
const GRASS = [shade(GROUND, 1.3), 0x9fae58, 0xb3b066];
const SCRUB = [0x8a8a4e, 0x7d7448, 0x6f7f45];
const TWIG = 0x5b4a33;

/** A seeded generator (mulberry32), so `?groundSeed=` can repeat a layout for screenshots. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Open tiles away from the track, where ground cover may go. */
function coverTiles(map: MapDef): Uint8Array {
  const { cols, rows } = map.size;
  const grid = decodeZones(map);
  const open = map.zoneLegend.indexOf('open');
  const ok = new Uint8Array(cols * rows);
  for (let i = 0; i < ok.length; i++) ok[i] = grid[i] === open ? 1 : 0;
  for (const r of map.routes) {
    const { x, y } = r.samples;
    for (let i = 0; i < x.length; i++) {
      for (let ty = Math.floor(y[i]! - TRACK_CLEAR); ty <= y[i]! + TRACK_CLEAR; ty++) {
        for (let tx = Math.floor(x[i]! - TRACK_CLEAR); tx <= x[i]! + TRACK_CLEAR; tx++) {
          if (tx >= 0 && ty >= 0 && tx < cols && ty < rows) ok[ty * cols + tx] = 0;
        }
      }
    }
  }
  return ok;
}

/** A tuft: a few thin blades fanning up from one spot. */
function drawGrass(g: Graphics, x: number, y: number, s: number, r: () => number): void {
  const bx = isoX(x, y), by = isoY(x, y);
  const color = GRASS[Math.floor(r() * GRASS.length)]!;
  const blades = 3 + Math.floor(r() * 3);
  for (let j = 0; j < blades; j++) {
    const lean = (j / (blades - 1) - 0.5) * 14 * s + (r() - 0.5) * 4;
    const h = (11 + r() * 9) * s, w = 2 * s;
    g.poly([bx - w + lean * 0.2, by, bx + w + lean * 0.2, by, bx + lean, by - h]);
  }
  g.fill(color);
}

/** A scrub brush: a low, ragged clump of dull olive with bare twigs poking out of the top. */
function drawScrub(g: Graphics, x: number, y: number, s: number, r: () => number): void {
  groundEllipse(g, x + 0.12, y + 0.12, 0.38 * s).fill({ color: 0x000000, alpha: 0.18 });
  const bx = isoX(x, y), by = isoY(x, y, 0.2 * s);
  const color = SCRUB[Math.floor(r() * SCRUB.length)]!;
  for (let j = 0; j < 5; j++) {
    const ox = (r() - 0.5) * 20 * s, oy = (r() - 0.5) * 6 * s;
    oval(g, bx + ox, by + oy, (6 + r() * 4) * s, (4.5 + r() * 2.5) * s);
  }
  g.fill(color);
  oval(g, bx - 3 * s, by - 3 * s, 5 * s, 3.5 * s).fill(shade(color, 1.2));
  for (let j = 0; j < 4; j++) {
    const tx = bx + (r() - 0.5) * 18 * s, ty = by - 2 * s, h = (9 + r() * 7) * s;
    g.poly([tx - 1.2, ty, tx + 1.2, ty, tx + (r() - 0.5) * 10 * s, ty - h]);
  }
  g.fill(TWIG);
}

/** A thick patch: an ellipse of tiles where grass and scrub grow densely. */
interface Patch { x: number; y: number; rx: number; ry: number }

/** Some thick patches at random over the map, about one per PATCH_EVERY tiles of map. */
function placePatches(map: MapDef, r: () => number): Patch[] {
  const { cols, rows } = map.size;
  return Array.from({ length: Math.round((cols * rows) / PATCH_EVERY) }, () => ({
    x: r() * cols, y: r() * rows, rx: 3 + r() * 5, ry: 3 + r() * 5,
  }));
}

/** How far into a patch a tile is: 1 at the centre, 0 at the edge and outside. */
function patchDepth(patches: readonly Patch[], x: number, y: number): number {
  let best = 0;
  for (const p of patches) {
    const dx = (x - p.x) / p.rx, dy = (y - p.y) / p.ry, d = 1 - Math.sqrt(dx * dx + dy * dy);
    if (d > best) best = d;
  }
  return best;
}

/**
 * Scatter grass and scrub over the map's open ground, away from the track, with a few thick
 * patches, as cells of Graphics to add under everything else on the ground. Built per region of
 * `region` tiles as it comes near the view; with one region (small maps) it is built at once.
 */
export function createGroundCover(map: MapDef, seed: number, region = Math.max(map.size.cols, map.size.rows)): { layer: Container; readonly chunks: readonly Chunk[]; cull(view: TileBox, budget?: BuildBudget): boolean } {
  const { cols, rows } = map.size;
  const ok = coverTiles(map);
  const whole = region >= Math.max(cols, rows);
  const patches = placePatches(map, rng(seed));
  // Patches only matter near their centres, so look them up per cell of the patch grid.
  const near = new Map<number, Patch[]>();
  for (const p of patches) {
    for (let cy = Math.floor((p.y - p.ry) / CELL); cy <= Math.floor((p.y + p.ry) / CELL); cy++) {
      for (let cx = Math.floor((p.x - p.rx) / CELL); cx <= Math.floor((p.x + p.rx) / CELL); cx++) {
        const k = cy * 100000 + cx;
        near.set(k, [...(near.get(k) ?? []), p]);
      }
    }
  }
  const layer = new Container();
  layer.label = 'iso-ground-cover';
  // One map-wide stream after the patches when built whole, as before; a stream per region otherwise, so a region looks the same each time it is rebuilt.
  const wholeStream = whole ? (() => { const r = rng(seed); placePatches(map, r); return r; })() : null;
  const build = (reg: TileBox, index: number): Chunk[] => {
    const r = wholeStream ?? rng((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    const cells = new Cells(CELL);
    // Row by row; the items are small enough that strict back-to-front order doesn't show.
    for (let ty = reg.y0; ty < reg.y1; ty++) {
      for (let tx = reg.x0; tx < reg.x1; tx++) {
        // The tiles behind (up the screen) must be open too, or a clump would poke over water or rock.
        if (!ok[ty * cols + tx] || tx === 0 || ty === 0 || !ok[(ty - 1) * cols + tx] || !ok[ty * cols + tx - 1] || !ok[(ty - 1) * cols + tx - 1]) continue;
        const thick = patchDepth(near.get(Math.floor(ty / CELL) * 100000 + Math.floor(tx / CELL)) ?? [], tx + 0.5, ty + 0.5);
        const grass = GRASS_DENSITY + thick * (PATCH_GRASS - GRASS_DENSITY), scrub = SCRUB_DENSITY + thick * (PATCH_SCRUB - SCRUB_DENSITY);
        // A thick tile can hold more than one item.
        for (let n = 0; n < 1 + Math.floor(thick * 2); n++) {
          const roll = r();
          if (roll >= grass + scrub) continue;
          const x = tx + r(), y = ty + r(), size = 0.75 + r() * 0.5 + thick * 0.3;
          if (roll < scrub) drawScrub(cells.at(x, y), x, y, size, r);
          else drawGrass(cells.at(x, y), x, y, size, r);
        }
      }
    }
    const chunks = cells.chunks();
    addChunks(layer, chunks);
    return chunks;
  };
  const lazy = new LazyChunks(regionUnits(map, region, 2, build));
  if (whole) lazy.buildAll();
  return {
    layer,
    get chunks() { return lazy.chunks; },
    cull(view, budget) {
      const waiting = lazy.update(view, budget);
      cullChunks(lazy.chunks, view);
      return waiting;
    },
  };
}
