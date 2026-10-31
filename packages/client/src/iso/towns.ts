// Towns along an open line (G6): each town's buildings from its layout (MapDef.towns[].layout).
// Placeholder art like the rest of the iso view: flat-shaded boxes. Flat pieces (the dirt street and
// the platform) go in one static layer under everything; each building is its own piece that sorts
// with the horse, the player and the cars in `land`, so you can ride behind a saloon.
import { Graphics } from 'pixi.js';
import type { MapDef, TownBuilding } from '@train-robber/config';
import { depthOf } from '../projection';
import { drawBox, isoPoly, shade, type Box } from './draw';

type Town = NonNullable<MapDef['towns']>[number];

const DIRT = 0xb89a68, PLATFORM = 0x8a6a48, ROOF = 0x5d4636, SIGN = 0xe8d9a8;
const WALLS: Record<TownBuilding['kind'], number> = {
  station: 0xa4572f, platform: PLATFORM, 'water-tower': 0x7a5a3a, house: 0xc9a46a, store: 0xb08850,
  saloon: 0x9c6b3e, church: 0xe6e0d0, stable: 0x8c5a32,
};

/** A box for one building at ground height z, `inset` tiles smaller each side and between z0 and z1 above it. */
const boxOf = (b: TownBuilding, z: number, z0: number, z1: number, inset = 0, along = 0, out = 0): Box => ({
  x: b.x + b.ux * along - b.uy * out, y: b.y + b.uy * along + b.ux * out, ux: b.ux, uy: b.uy,
  halfLength: Math.max(0.05, b.halfLength - inset), halfWidth: Math.max(0.05, b.halfWidth - inset), z0: z + z0, z1: z + z1,
});

/** Draw boxes far to near, so nearer ones cover farther ones. */
function drawSorted(g: Graphics, parts: readonly [Box, number][]): void {
  for (const [box, color] of [...parts].sort((a, b) => depthOf(a[0].x, a[0].y) - depthOf(b[0].x, b[0].y))) drawBox(g, box, color);
}

/** One building: its walls, then what makes it read as that kind (a false front, a steeple, a tank). */
export function drawBuilding(g: Graphics, b: TownBuilding, town: Town, z: number): void {
  const wall = WALLS[b.kind], h = b.heightTiles;
  // Which way the building faces: toward the street through the town's middle.
  const nx = -b.uy, ny = b.ux;
  const face = (town.x - b.x) * nx + (town.y - b.y) * ny >= 0 ? 1 : -1;
  if (b.kind === 'water-tower') {
    const legs: [Box, number][] = [];
    for (const [a, o] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      legs.push([{ x: b.x + b.ux * a * b.halfLength * 0.7 + nx * o * b.halfWidth * 0.7, y: b.y + b.uy * a * b.halfLength * 0.7 + ny * o * b.halfWidth * 0.7, ux: b.ux, uy: b.uy, halfLength: 0.12, halfWidth: 0.12, z0: z, z1: z + h * 0.55 }, shade(wall, 0.8)]);
    }
    drawSorted(g, legs);
    drawBox(g, boxOf(b, z, h * 0.55, h * 0.95), wall);
    drawBox(g, boxOf(b, z, h * 0.95, h, -0.15), ROOF);
    return;
  }
  if (b.kind === 'platform') {
    drawBox(g, boxOf(b, z, 0, h), wall);
    return;
  }
  const parts: [Box, number][] = [[boxOf(b, z, 0, h), wall]];
  if (b.kind === 'store' || b.kind === 'saloon') {
    // A false front: a tall board on the street side.
    parts.push([{ ...boxOf(b, z, 0, h + 1.2), halfWidth: 0.12, x: b.x + nx * face * b.halfWidth, y: b.y + ny * face * b.halfWidth }, shade(wall, 1.05)]);
  }
  if (b.kind === 'station') {
    // A roof over the walls with eaves that reach toward the track.
    parts.push([{ ...boxOf(b, z, h, h + 0.25, -0.6), x: b.x - nx * face * 0.6, y: b.y - ny * face * 0.6, halfWidth: b.halfWidth + 1.2 }, ROOF]);
  } else if (b.kind !== 'store' && b.kind !== 'saloon') {
    parts.push([boxOf(b, z, h, h + 0.25, -0.2), ROOF]);
  }
  if (b.kind === 'church') {
    // A steeple at the street end.
    parts.push([{ x: b.x + nx * face * (b.halfWidth - 1.2), y: b.y + ny * face * (b.halfWidth - 1.2), ux: b.ux, uy: b.uy, halfLength: 0.9, halfWidth: 0.9, z0: z + h, z1: z + h + 3 }, wall]);
  }
  drawSorted(g, parts);
  if (b.kind === 'station') {
    // A name board along the platform side.
    const s = -face, w = b.halfWidth + 0.02;
    const p = (a: number): [number, number] => [b.x + b.ux * a + nx * s * w, b.y + b.uy * a + ny * s * w];
    if (nx * s + ny * s > 0) g.poly([...isoPoly([p(-2), p(2)], z + h - 0.9), ...isoPoly([p(2), p(-2)], z + h - 0.3)]).fill(SIGN);
  }
}

/**
 * Every town's flat pieces as one static layer (the street and the platforms), and each building as
 * its own Graphics with zIndex at its depth, for the sorted `land` layer. Towns off the ends of the
 * line have no layout and draw nothing.
 */
export function drawTowns(map: MapDef, surfaceZ: (x: number, y: number) => number = () => 0): { flat: Graphics; buildings: Graphics[] } {
  const flat = new Graphics();
  flat.label = 'iso-towns';
  const buildings: Graphics[] = [];
  for (const t of map.towns ?? []) {
    if (!t.layout.length) continue;
    const z = surfaceZ(t.x, t.y);
    // The street: a dirt strip through the clearing, along the line.
    const along = t.layout[0]!;
    const L = t.radiusTiles * 0.85, W = 2.2;
    const nx = -along.uy, ny = along.ux;
    const c = (a: number, o: number): [number, number] => [t.x + along.ux * a + nx * o, t.y + along.uy * a + ny * o];
    flat.poly(isoPoly([c(-L, -W), c(L, -W), c(L, W), c(-L, W)], z)).fill({ color: DIRT, alpha: 0.85 });
    for (const b of t.layout) {
      if (b.kind === 'platform') { drawBuilding(flat, b, t, surfaceZ(b.x, b.y)); continue; }
      const g = new Graphics();
      g.label = `town-${t.id}-${b.kind}`;
      drawBuilding(g, b, t, z);
      g.zIndex = depthOf(b.x, b.y);
      buildings.push(g);
    }
  }
  return { flat, buildings };
}
