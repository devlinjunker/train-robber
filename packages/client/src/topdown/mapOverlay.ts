// Debug drawing of a map as the converter built it, in tile units, top-down (x right,
// y down, as in Tiled), for checking the build against the Tiled file. The top-down debug
// view (V) draws it; the isometric view has its own overlay in iso/terrain.ts.
import { Container, Graphics, Text } from 'pixi.js';
import { CHUNK_TILES, SOLID_SCENERY, trackPieces, type MapDef, type SceneryDef, type Zone } from '@train-robber/config';
import { mapTiles, type MapTiles, type TileBoxLike } from '../tiles';

/** Small white text in tile units. */
function label(text: string, x: number, y: number): Text {
  const t = new Text({ text, style: { fontFamily: 'monospace', fontSize: 24, fill: 0xffffff, stroke: { color: 0x000000, width: 4 } } });
  t.scale.set(0.1);
  t.position.set(x, y);
  return t;
}

const ZONE_COLOURS: Partial<Record<Zone, number>> = { slow: 0xc9a227, blocked: 0x6b6b6b, water: 0x6fa6dc, deep: 0x2f6fd6 };
/** Draw a tangent tick on every Nth sample (samples are about half a tile apart). */
export const TANGENT_EVERY = 8;
const TANGENT_LENGTH = 2.5;

/** Zones, elevation, trees and bridges in a box of tiles [x0, x1) x [y0, y1), read through `tiles`. */
function drawGround(map: MapDef, tiles: MapTiles, scenery: SceneryDef | null, box: TileBoxLike): Graphics {
  const zones = new Graphics();
  const { cols, rows } = map.size;
  const x0 = Math.max(0, box.x0), y0 = Math.max(0, box.y0), x1 = Math.min(cols, box.x1), y1 = Math.min(rows, box.y1);
  // Zones: one rectangle per horizontal run of the same non-open zone.
  for (let y = y0; y < y1; y++) {
    let x = x0;
    while (x < x1) {
      const z = tiles.zone(x, y);
      let end = x + 1;
      while (end < x1 && tiles.zone(end, y) === z) end++;
      const colour = ZONE_COLOURS[map.zoneLegend[z]!];
      if (colour !== undefined) zones.rect(x, y, end - x, 1).fill({ color: colour, alpha: 0.55 });
      x = end;
    }
  }
  // Elevation: lighter the higher the ground, with a dark line along every cliff (two or more levels).
  if (map.elevation || tiles.streamed) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const l = tiles.level(x, y);
      if (l > 0) zones.rect(x, y, 1, 1).fill({ color: 0xffffff, alpha: 0.05 * l });
      if (x + 1 < cols && Math.abs(l - tiles.level(x + 1, y)) >= 2) zones.moveTo(x + 1, y).lineTo(x + 1, y + 1);
      if (y + 1 < rows && Math.abs(l - tiles.level(x, y + 1)) >= 2) zones.moveTo(x, y + 1).lineTo(x + 1, y + 1);
    }
    zones.stroke({ width: 0.2, color: 0x3a2a18 });
  }
  const items = tiles.sceneryIn(box);
  if (scenery && items) {
    const { kind, x, y } = items.items;
    for (let i = 0; i < kind.length; i++) if (SOLID_SCENERY.has(items.kindLegend[kind[i]!]!)) zones.circle(x[i]!, y[i]!, 0.4);
    zones.fill({ color: 0x2c6b45, alpha: 0.8 });
    for (const b of scenery.bridges) if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) zones.rect(b.x, b.y, b.w, b.h).stroke({ width: 0.2, color: 0x8b6a45 });
  }
  return zones;
}

/**
 * The ground of a streamed map (tiles.ts) in the top-down view: drawn a chunk at a time near the
 * view, dropped when far, so it never reads the whole line.
 */
export function createStreamedOverlayGround(map: MapDef, tiles: MapTiles, scenery: SceneryDef | null): { layer: Container; cull(view: TileBoxLike): void } {
  const layer = new Container();
  const T = CHUNK_TILES, NEAR = 16, FAR = 2 * T;
  const shown = new Map<number, Graphics>();
  return {
    layer,
    cull(view) {
      for (const [key, g] of shown) {
        const cx = key % 100_003, cy = (key - cx) / 100_003;
        if (cx * T > view.x1 + FAR || (cx + 1) * T < view.x0 - FAR || cy * T > view.y1 + FAR || (cy + 1) * T < view.y0 - FAR) { g.destroy(); shown.delete(key); }
      }
      for (let cy = Math.max(0, Math.floor((view.y0 - NEAR) / T)); cy * T < Math.min(map.size.rows, view.y1 + NEAR); cy++) {
        for (let cx = Math.max(0, Math.floor((view.x0 - NEAR) / T)); cx * T < Math.min(map.size.cols, view.x1 + NEAR); cx++) {
          const key = cy * 100_003 + cx;
          if (shown.has(key)) continue;
          const g = drawGround(map, tiles, scenery, { x0: cx * T, y0: cy * T, x1: (cx + 1) * T, y1: (cy + 1) * T });
          shown.set(key, g);
          layer.addChild(g);
        }
      }
    },
  };
}

/**
 * `scenery`, when given, adds trees as dots and bridges as outlines over the zones. `withGround`
 * false leaves the zones, elevation and scenery out (a streamed map draws them near the view, see
 * createStreamedOverlayGround).
 */
export function drawMapOverlay(map: MapDef, scenery: SceneryDef | null = null, withGround = true): Container {
  const layer = new Container();
  layer.label = 'map-overlay';
  const { cols, rows } = map.size;
  const border = new Graphics().rect(0, 0, cols, rows).stroke({ width: 0.25, color: 0xffffff, alpha: 0.4 });
  const zones = withGround ? drawGround(map, mapTiles(map, scenery), scenery, { x0: 0, y0: 0, x1: cols, y1: rows }) : new Graphics();
  for (const s of map.speedZones) zones.rect(s.x, s.y, s.w, s.h).stroke({ width: 0.2, color: 0xff7a1a });

  // Routes: baked samples, a tangent tick every few samples, then the control points on top.
  const track = new Graphics();
  for (const r of map.routes) {
    const { x, y, tx, ty } = r.samples;
    for (let i = 0; i < x.length; i++) track.circle(x[i]!, y[i]!, 0.12);
    track.fill({ color: 0xffffff, alpha: 0.9 });
    for (let i = 0; i < x.length; i += TANGENT_EVERY) {
      track.moveTo(x[i]!, y[i]!).lineTo(x[i]! + tx[i]! * TANGENT_LENGTH, y[i]! + ty[i]! * TANGENT_LENGTH);
    }
    track.stroke({ width: 0.15, color: 0x4dd4ff });
    for (const p of r.points) track.circle(p.x, p.y, 0.6);
    track.fill({ color: 0xff3b3b }).stroke({ width: 0.15, color: 0x000000 });
  }

  // Markers as small diamonds.
  const markers = new Graphics();
  for (const p of Object.values(map.markers)) markers.poly([p.x, p.y - 0.8, p.x + 0.8, p.y, p.x, p.y + 0.8, p.x - 0.8, p.y]);
  markers.fill({ color: 0xb46bff });
  // Town spots on an open line: a ring round each clearing.
  for (const t of map.towns ?? []) markers.circle(t.x, t.y, t.radiusTiles).stroke({ width: 0.4, color: 0xe8d9a8, alpha: 0.8 });

  // Junctions: a ring and the shared tangent, labelled with their id, as are segments at their middle.
  const junctions = new Graphics();
  const labels = new Container();
  for (const j of map.junctions ?? []) {
    junctions.circle(j.x, j.y, 1.6).stroke({ width: 0.3, color: 0xffffff });
    junctions.moveTo(j.x, j.y).lineTo(j.x + j.tx * 5, j.y + j.ty * 5).stroke({ width: 0.3, color: 0xffffff });
    labels.addChild(label(j.id, j.x + 2, j.y - 3));
  }
  for (const p of trackPieces(map)) {
    if (p.closed) continue;
    const m = Math.floor(p.x.length / 2);
    labels.addChild(label(p.id, p.x[m]! + 2, p.y[m]! + 1));
  }

  layer.addChild(border, zones, track, markers, junctions, labels);
  return layer;
}
