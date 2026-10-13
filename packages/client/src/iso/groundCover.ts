// Grass tufts and scrub brush scattered over open ground at random each time a map loads. Not
// part of any map file and never seen by the sim: it only breaks up the plain grass.
import { Graphics } from 'pixi.js';
import { decodeZones, type MapDef } from '@train-robber/config';
import { cullChunks, type Chunk } from './scenery';
import { groundEllipse, shade } from './draw';
import { isoX, isoY } from '../projection';
import { GROUND } from './terrain';

/** Items per open tile. */
const GRASS_DENSITY = 0.14, SCRUB_DENSITY = 0.03;
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
    g.ellipse(bx + ox, by + oy, (6 + r() * 4) * s, (4.5 + r() * 2.5) * s);
  }
  g.fill(color);
  g.ellipse(bx - 3 * s, by - 3 * s, 5 * s, 3.5 * s).fill(shade(color, 1.2));
  for (let j = 0; j < 4; j++) {
    const tx = bx + (r() - 0.5) * 18 * s, ty = by - 2 * s, h = (9 + r() * 7) * s;
    g.poly([tx - 1.2, ty, tx + 1.2, ty, tx + (r() - 0.5) * 10 * s, ty - h]);
  }
  g.fill(TWIG);
}

/**
 * Scatter grass and scrub over the map's open ground, away from the track, as cells of
 * Graphics to add under everything else on the ground.
 */
export function createGroundCover(map: MapDef, seed: number): { chunks: Chunk[]; cull(view: { x0: number; y0: number; x1: number; y1: number }): void } {
  const { cols, rows } = map.size;
  const ok = coverTiles(map);
  const r = rng(seed);
  const cells = new Map<number, Graphics>();
  const cell = (x: number, y: number) => {
    const k = Math.floor(y / CELL) * 100000 + Math.floor(x / CELL);
    let g = cells.get(k);
    if (!g) cells.set(k, g = new Graphics());
    return g;
  };
  // Row by row; the items are small enough that strict back-to-front order doesn't show.
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      // The tiles behind (up the screen) must be open too, or a clump would poke over water or rock.
      if (!ok[ty * cols + tx] || tx === 0 || ty === 0 || !ok[(ty - 1) * cols + tx] || !ok[ty * cols + tx - 1] || !ok[(ty - 1) * cols + tx - 1]) continue;
      const roll = r();
      if (roll >= GRASS_DENSITY + SCRUB_DENSITY) continue;
      const x = tx + r(), y = ty + r(), s = 0.75 + r() * 0.5;
      if (roll < SCRUB_DENSITY) drawScrub(cell(x, y), x, y, s, r);
      else drawGrass(cell(x, y), x, y, s, r);
    }
  }
  const chunks = [...cells.entries()].map(([k, g]) => {
    const cx = (k % 100000) * CELL, cy = Math.floor(k / 100000) * CELL;
    return { g, x0: cx - 1, y0: cy - 1, x1: cx + CELL + 1, y1: cy + CELL + 1 };
  });
  return { chunks, cull: (view) => cullChunks(chunks, view) };
}
