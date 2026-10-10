// The ground, terrain zones and track of a map, drawn once in iso pixels. Grass tufts and a
// faint grid give the eye something to measure speed against on open ground.
import { Container, Graphics } from 'pixi.js';
import { decodeZones, type MapDef, type Zone } from '@train-robber/config';
import { isoPoly, shade } from './draw';
import { isoX, isoY } from '../projection';

export const GROUND = 0x6d8a4a;
const ZONE_COLOURS: Partial<Record<Zone, number>> = { slow: 0xa88a4a, blocked: 0x7a756c, water: 0x3f78b8 };
const GRID_EVERY = 5;
/** Half the rail gauge and half a tie's length, in tiles. */
const RAIL_HALF = 0.75, TIE_HALF = 1.2;

/** A small deterministic hash for scattering tufts; the client may use any maths, the sim may not. */
const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function drawTerrain(map: MapDef): Container {
  const layer = new Container();
  layer.label = 'iso-terrain';
  const { cols, rows } = map.size;

  const ground = new Graphics();
  ground.poly(isoPoly([[0, 0], [cols, 0], [cols, rows], [0, rows]])).fill(GROUND);

  // Zones: one parallelogram per horizontal run of the same non-open zone.
  const grid = decodeZones(map);
  const zoneG = new Graphics();
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      const z = grid[y * cols + x]!;
      let end = x + 1;
      while (end < cols && grid[y * cols + end] === z) end++;
      const colour = ZONE_COLOURS[map.zoneLegend[z]!];
      if (colour !== undefined) zoneG.poly(isoPoly([[x, y], [end, y], [end, y + 1], [x, y + 1]])).fill(colour);
      x = end;
    }
  }

  // Tufts on open ground, and a faint grid every few tiles.
  const tufts = new Graphics();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const r = hash(x, y);
      if (r > 0.12 || map.zoneLegend[grid[y * cols + x]!] !== 'open') continue;
      const cx = x + hash(y, x), cy = y + r * 8;
      tufts.poly(isoPoly([[cx, cy - 0.12], [cx + 0.12, cy], [cx, cy + 0.12], [cx - 0.12, cy]]));
    }
  }
  tufts.fill(shade(GROUND, 0.82));
  for (let x = 0; x <= cols; x += GRID_EVERY) tufts.moveTo(isoX(x, 0), isoY(x, 0)).lineTo(isoX(x, rows), isoY(x, rows));
  for (let y = 0; y <= rows; y += GRID_EVERY) tufts.moveTo(isoX(0, y), isoY(0, y)).lineTo(isoX(cols, y), isoY(cols, y));
  tufts.stroke({ width: 1, color: 0x000000, alpha: 0.06 });

  // Track: ties across the route on every other sample (about a tile apart), then two rails.
  const track = new Graphics();
  for (const r of map.routes) {
    const { x, y, tx, ty } = r.samples;
    for (let i = 0; i < x.length; i += 2) {
      const nx = -ty[i]!, ny = tx[i]!;
      track.moveTo(isoX(x[i]! + nx * TIE_HALF, y[i]! + ny * TIE_HALF), isoY(x[i]! + nx * TIE_HALF, y[i]! + ny * TIE_HALF))
        .lineTo(isoX(x[i]! - nx * TIE_HALF, y[i]! - ny * TIE_HALF), isoY(x[i]! - nx * TIE_HALF, y[i]! - ny * TIE_HALF));
    }
    track.stroke({ width: 7, color: 0x5a3d26 });
    for (const s of [RAIL_HALF, -RAIL_HALF]) {
      for (let i = 0; i <= x.length; i++) {
        const j = i % x.length;
        const px = x[j]! - ty[j]! * s, py = y[j]! + tx[j]! * s;
        if (i === 0) track.moveTo(isoX(px, py), isoY(px, py));
        else track.lineTo(isoX(px, py), isoY(px, py));
      }
      track.stroke({ width: 3, color: 0xb9b9c4 });
    }
  }

  layer.addChild(ground, zoneG, tufts, track);
  return layer;
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
