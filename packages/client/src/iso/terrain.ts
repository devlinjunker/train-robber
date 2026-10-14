// The ground, terrain zones and track of a map, drawn once in iso pixels. Open ground is sand
// (Devlin, PR #25 playtest 2026-10-13) speckled with darker and paler spots, which with a faint
// grid give the eye something to measure speed against; mud gets darker
// puddles with a wet glint so it reads as mud, not sand. Boulders on blocked ground are in rocks.ts.
import { Container, Graphics } from 'pixi.js';
import { decodeZones, type MapDef, type Zone } from '@train-robber/config';
import { isoPoly, shade, oval } from './draw';
import { Cells, cullChunks, type Chunk, type TileBox } from './cells';
import { isoX, isoY, TILE_H, TILE_W } from '../projection';

export const GROUND = 0xc6a673;
/** Speckles on sand: darker and paler grains, one per this share of tiles. */
export const SPOT_COLOURS = [0xa98a5c, 0xb59767, 0xd8bf8f] as const, SPOT_SHARE = 0.35;
const EDGE_COLOUR = 0x4a3a26;
export const MUD_COLOUR = 0x7a5a36;
/** Blocked ground is gravel under the boulders. Shallow water is pale, deep water dark. */
const ZONE_COLOURS: Partial<Record<Zone, number>> = { slow: MUD_COLOUR, blocked: 0x6a655c, water: 0x6fa6dc, deep: 0x2f62a8 };
const GRID_EVERY = 5;
/** Tufts and puddles are drawn in cells of this many tiles, the track in stretches of this many samples. */
const CELL = 24, TRACK_STRETCH = 64;
/** Half the rail gauge and half a tie's length, in tiles. */
const RAIL_HALF = 0.75, TIE_HALF = 1.2;

/**
 * The rock ring that keeps riders on the map. Devlin found boulders along it tacky (2026-10-12),
 * so the edge draws as a dark border instead (drawn below) and gets no boulders.
 */
export const EDGE_TILES = 2;
export const onEdge = (map: MapDef, x: number, y: number) =>
  x < EDGE_TILES || y < EDGE_TILES || x >= map.size.cols - EDGE_TILES || y >= map.size.rows - EDGE_TILES;

/** A small deterministic hash for scattering tufts; the client may use any maths, the sim may not. */
export const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** The sand spot on tile (x, y), if it has one: where, how big (tiles) and which of SPOT_COLOURS. */
export function sandSpot(x: number, y: number): { x: number; y: number; r: number; k: number } | null {
  const r = hash(x, y);
  if (r > SPOT_SHARE) return null;
  return { x: x + 0.15 + 0.7 * hash(y, x), y: y + 0.15 + 0.7 * hash(x + 5, y + 11), r: 0.1 + 0.22 * hash(x + 13, y + 3) ** 2, k: Math.floor(hash(x + 29, y + 41) * SPOT_COLOURS.length) };
}

/**
 * A sand spot as a flat six-sided fleck at height z: cheaper to draw than an ellipse, and there
 * are tens of thousands of them.
 */
export function spotPoly(spot: { x: number; y: number; r: number }, z = 0): number[] {
  const cx = isoX(spot.x, spot.y), cy = isoY(spot.x, spot.y, z), w = spot.r * TILE_W * 0.5, h = spot.r * TILE_H * 0.5;
  return [cx - w, cy, cx - w * 0.5, cy - h, cx + w * 0.5, cy - h, cx + w, cy, cx + w * 0.5, cy + h, cx - w * 0.5, cy + h];
}

/** The mud puddle on a slow tile, if it has one: centre, size, and whether it has a wet glint. */
export function mudPuddle(x: number, y: number): { x: number; y: number; s: number; glint: boolean } | null {
  const r = hash(x + 911, y + 37);
  if (r > 0.22) return null;
  return { x: x + 0.2 + 0.6 * hash(y, x + 5), y: y + 0.2 + 0.6 * r, s: 0.25 + 0.3 * hash(x + 3, y + 101), glint: r < 0.07 };
}

/**
 * The ground, zones, `scenery` (ground cover and flat scenery) and the track, back to front, and
 * a cull that hides the parts outside a box of world tiles. Spots and puddles are left off
 * `raised` tiles: the height layer draws those on the slope.
 */
export function drawTerrain(map: MapDef, scenery: Container | null = null, raised?: (x: number, y: number) => boolean): { layer: Container; cull(view: TileBox): void } {
  const layer = new Container();
  layer.label = 'iso-terrain';
  const { cols, rows } = map.size;

  const ground = new Graphics();
  ground.poly(isoPoly([[0, 0], [cols, 0], [cols, rows], [0, rows]])).fill(GROUND);

  // Zones: one parallelogram per horizontal run of the same non-open zone, in cells so cells off
  // screen cull (runs break at cell edges), one colour at a time.
  const grid = decodeZones(map);
  const zones = new Cells(CELL);
  for (const colour of new Set(Object.values(ZONE_COLOURS))) {
    for (let y = 0; y < rows; y++) {
      let x = 0;
      while (x < cols) {
        const z = grid[y * cols + x]!, stop = Math.min(cols, (Math.floor(x / CELL) + 1) * CELL);
        let end = x + 1;
        while (end < stop && grid[y * cols + end] === z) end++;
        if (ZONE_COLOURS[map.zoneLegend[z]!] === colour) zones.at(x, y).poly(isoPoly([[x, y], [end, y], [end, y + 1], [x, y + 1]]));
        x = end;
      }
    }
    zones.each((g) => g.fill(colour));
  }

  // The map edge: a dark frame over the rock ring, fading inward, instead of a line of boulders.
  const edge = new Graphics();
  const frame = (inset: number, width: number) => isoPoly([
    [inset, inset], [cols - inset, inset], [cols - inset, rows - inset], [inset, rows - inset], [inset, inset],
    [inset + width, inset + width], [inset + width, rows - inset - width], [cols - inset - width, rows - inset - width], [cols - inset - width, inset + width], [inset + width, inset + width],
  ]);
  edge.poly(frame(0, EDGE_TILES)).fill(EDGE_COLOUR);
  for (let i = 0; i < 3; i++) edge.poly(frame(EDGE_TILES + i, 1)).fill({ color: EDGE_COLOUR, alpha: 0.45 - i * 0.15 });

  // Spots on open sand, in three shades, and a faint grid every few tiles.
  const tufts = new Cells(CELL);
  for (const [k, colour] of SPOT_COLOURS.entries()) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (map.zoneLegend[grid[y * cols + x]!] !== 'open' || raised?.(x, y)) continue;
        const spot = sandSpot(x, y);
        if (!spot || spot.k !== k) continue;
        tufts.at(spot.x, spot.y).poly(spotPoly(spot));
      }
    }
    tufts.each((g) => g.fill(colour));
  }
  const gridLines = new Graphics();
  for (let x = 0; x <= cols; x += GRID_EVERY) gridLines.moveTo(isoX(x, 0), isoY(x, 0)).lineTo(isoX(x, rows), isoY(x, rows));
  for (let y = 0; y <= rows; y += GRID_EVERY) gridLines.moveTo(isoX(0, y), isoY(0, y)).lineTo(isoX(cols, y), isoY(cols, y));
  gridLines.stroke({ width: 1, color: 0x000000, alpha: 0.06 });

  // Mud: a dark puddle on some tiles, and a pale glint on a few of those. Glints draw in the
  // same cells, after every puddle in it.
  const puddles = new Cells(CELL), glints: [Graphics, number, number, number][] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (map.zoneLegend[grid[y * cols + x]!] !== 'slow' || raised?.(x, y)) continue;
      const p = mudPuddle(x, y);
      if (!p) continue;
      const g = puddles.at(p.x, p.y);
      oval(g, isoX(p.x, p.y), isoY(p.x, p.y), p.s * TILE_W * 0.7, p.s * TILE_H * 0.7);
      if (p.glint) glints.push([g, p.x, p.y, p.s]);
    }
  }
  puddles.each((g) => g.fill(shade(MUD_COLOUR, 0.8)));
  for (const [g, cx, cy, s] of glints) oval(g, isoX(cx, cy) - s * 8, isoY(cx, cy) - s * 3, s * 9, s * 2.5);
  puddles.each((g) => g.fill({ color: 0xffffff, alpha: 0.18 }));

  // Track: ties across the route on every other sample (about a tile apart), then two rails, in
  // stretches of TRACK_STRETCH samples so stretches off screen cull.
  const track: Chunk[] = [];
  for (const r of map.routes) {
    const { x, y, tx, ty } = r.samples;
    for (let a = 0; a < x.length; a += TRACK_STRETCH) {
      const b = Math.min(x.length, a + TRACK_STRETCH), g = new Graphics();
      for (let i = a; i < b; i += 2) {
        const nx = -ty[i]!, ny = tx[i]!;
        g.moveTo(isoX(x[i]! + nx * TIE_HALF, y[i]! + ny * TIE_HALF), isoY(x[i]! + nx * TIE_HALF, y[i]! + ny * TIE_HALF))
          .lineTo(isoX(x[i]! - nx * TIE_HALF, y[i]! - ny * TIE_HALF), isoY(x[i]! - nx * TIE_HALF, y[i]! - ny * TIE_HALF));
      }
      g.stroke({ width: 7, color: 0x5a3d26 });
      // Each stretch's rails run on to the next stretch's first sample, so they join up.
      for (const s of [RAIL_HALF, -RAIL_HALF]) {
        for (let i = a; i <= b; i++) {
          const j = i % x.length;
          const px = x[j]! - ty[j]! * s, py = y[j]! + tx[j]! * s;
          if (i === a) g.moveTo(isoX(px, py), isoY(px, py));
          else g.lineTo(isoX(px, py), isoY(px, py));
        }
        g.stroke({ width: 3, color: 0xb9b9c4 });
      }
      const xs = x.slice(a, b + 1), ys = y.slice(a, b + 1);
      track.push({ g, x0: Math.min(...xs) - 2, y0: Math.min(...ys) - 2, x1: Math.max(...xs) + 2, y1: Math.max(...ys) + 2 });
    }
  }

  const culled = [...zones.chunks(), ...tufts.chunks(), ...puddles.chunks(), ...track];
  // Its own render group: the ground is drawn once, so the horse, trains and trees changing every
  // frame don't make Pixi rebuild it.
  layer.enableRenderGroup();
  layer.addChild(ground, ...zones.chunks().map((c) => c.g), edge, gridLines, ...tufts.chunks().map((c) => c.g), ...puddles.chunks().map((c) => c.g));
  if (scenery) layer.addChild(scenery);
  layer.addChild(...track.map((c) => c.g));
  return { layer, cull: (view) => cullChunks(culled, view) };
}

/** The map debug overlay in iso: speed zones, route samples and tangents, control points and markers. */
export function drawIsoMapOverlay(map: MapDef): Container {
  const layer = new Container();
  layer.label = 'iso-map-overlay';
  const g = new Graphics();
  for (const s of map.speedZones) g.poly(isoPoly([[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]], 0)).stroke({ width: 3, color: 0xff7a1a });
  for (const r of map.routes) {
    const { x, y, tx, ty } = r.samples;
    for (let i = 0; i < x.length; i += 8) {
      g.moveTo(isoX(x[i]!, y[i]!), isoY(x[i]!, y[i]!)).lineTo(isoX(x[i]! + tx[i]! * 2.5, y[i]! + ty[i]! * 2.5), isoY(x[i]! + tx[i]! * 2.5, y[i]! + ty[i]! * 2.5));
    }
    g.stroke({ width: 2, color: 0x4dd4ff });
    for (const p of r.points) g.circle(isoX(p.x, p.y), isoY(p.x, p.y), 8);
    g.fill(0xff3b3b);
  }
  for (const p of Object.values(map.markers)) g.poly(isoPoly([[p.x, p.y - 0.8], [p.x + 0.8, p.y], [p.x, p.y + 0.8], [p.x - 0.8, p.y]]));
  g.fill(0xb46bff);
  layer.addChild(g);
  return layer;
}
