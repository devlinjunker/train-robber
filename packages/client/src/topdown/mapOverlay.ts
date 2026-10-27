// Debug drawing of a map as the converter built it, in tile units, top-down (x right,
// y down, as in Tiled), for checking the build against the Tiled file. The top-down debug
// view (V) draws it; the isometric view has its own overlay in iso/terrain.ts.
import { Container, Graphics, Text } from 'pixi.js';
import { decodeElevation, decodeZones, SOLID_SCENERY, trackPieces, type MapDef, type SceneryDef, type Zone } from '@train-robber/config';

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

/** `scenery`, when given, adds trees as dots and bridges as outlines over the zones. */
export function drawMapOverlay(map: MapDef, scenery: SceneryDef | null = null): Container {
  const layer = new Container();
  layer.label = 'map-overlay';

  // Zones: one rectangle per horizontal run of the same non-open zone.
  const zones = new Graphics();
  const grid = decodeZones(map);
  const { cols, rows } = map.size;
  zones.rect(0, 0, cols, rows).stroke({ width: 0.25, color: 0xffffff, alpha: 0.4 });
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      const z = grid[y * cols + x]!;
      let end = x + 1;
      while (end < cols && grid[y * cols + end] === z) end++;
      const colour = ZONE_COLOURS[map.zoneLegend[z]!];
      if (colour !== undefined) zones.rect(x, y, end - x, 1).fill({ color: colour, alpha: 0.55 });
      x = end;
    }
  }
  // Elevation: lighter the higher the ground, with a dark line along every cliff (two or more levels).
  if (map.elevation) {
    const level = decodeElevation(map);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const l = level[y * cols + x]!;
      if (l > 0) zones.rect(x, y, 1, 1).fill({ color: 0xffffff, alpha: 0.05 * l });
      if (x + 1 < cols && Math.abs(l - level[y * cols + x + 1]!) >= 2) zones.moveTo(x + 1, y).lineTo(x + 1, y + 1);
      if (y + 1 < rows && Math.abs(l - level[(y + 1) * cols + x]!) >= 2) zones.moveTo(x, y + 1).lineTo(x + 1, y + 1);
    }
    zones.stroke({ width: 0.2, color: 0x3a2a18 });
  }
  for (const s of map.speedZones) zones.rect(s.x, s.y, s.w, s.h).stroke({ width: 0.2, color: 0xff7a1a });
  if (scenery) {
    const { kind, x, y } = scenery.items;
    for (let i = 0; i < kind.length; i++) if (SOLID_SCENERY.has(scenery.kindLegend[kind[i]!]!)) zones.circle(x[i]!, y[i]!, 0.4);
    zones.fill({ color: 0x2c6b45, alpha: 0.8 });
    for (const b of scenery.bridges) zones.rect(b.x, b.y, b.w, b.h).stroke({ width: 0.2, color: 0x8b6a45 });
  }

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

  layer.addChild(zones, track, markers, junctions, labels);
  return layer;
}
