// Drawing helpers for the isometric view, in unzoomed iso pixels (the scene container applies
// the camera). Placeholder art: flat-shaded boxes, ellipses on the ground, simple polygons.
import type { Graphics } from 'pixi.js';
import { isoX, isoY, TILE_H, TILE_W } from '../projection';

/** Scale a colour's channels by `k` (above 1 lightens, clamped). */
export function shade(color: number, k: number): number {
  const ch = (s: number) => Math.min(255, Math.max(0, Math.round(((color >> s) & 0xff) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Flat points [x0, y0, x1, y1, ...] in iso pixels for world points at height z. */
export function isoPoly(pts: readonly (readonly [number, number])[], z = 0): number[] {
  return pts.flatMap(([x, y]) => [isoX(x, y), isoY(x, y, z)]);
}

/** An oriented box on the ground: centre, unit axis u (its length runs along u), half sizes, height range. */
export interface Box {
  x: number;
  y: number;
  ux: number;
  uy: number;
  halfLength: number;
  halfWidth: number;
  z0: number;
  z1: number;
}

/** The box's ground corners, in order around it: front-left, front-right, rear-right, rear-left. */
export function boxCorners(b: Box): [number, number][] {
  // Left of travel is (uy, -ux), as in the sim's car poses.
  const lx = b.uy, ly = -b.ux;
  const fx = b.ux * b.halfLength, fy = b.uy * b.halfLength;
  const sx = lx * b.halfWidth, sy = ly * b.halfWidth;
  return [
    [b.x + fx + sx, b.y + fy + sy],
    [b.x + fx - sx, b.y + fy - sy],
    [b.x - fx - sx, b.y - fy - sy],
    [b.x - fx + sx, b.y - fy + sy],
  ];
}

/**
 * Whether a face with outward ground normal (nx, ny) faces the viewer. The camera looks up the
 * screen, toward -x -y, so faces pointing toward +x +y are seen.
 */
export const facesViewer = (nx: number, ny: number) => nx + ny > 1e-9;

/**
 * Draw the visible sides and the top of a box, flat-shaded: faces toward +y (down-left on
 * screen) are lighter than faces toward +x (down-right). `skipFace` hides faces by index
 * (0 front, 1 right, 2 rear, 3 left), for slices of one long box whose inner ends never show.
 */
export function drawBox(g: Graphics, b: Box, color: number, skipFace: readonly boolean[] = []): void {
  const c = boxCorners(b);
  for (let i = 0; i < 4; i++) {
    if (skipFace[i]) continue;
    const a = c[i]!, e = c[(i + 1) % 4]!;
    // Outward normal: the edge direction turned away from the centre.
    let nx = e[1] - a[1], ny = a[0] - e[0];
    const mx = (a[0] + e[0]) / 2 - b.x, my = (a[1] + e[1]) / 2 - b.y;
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
    const n = Math.hypot(nx, ny) || 1;
    nx /= n; ny /= n;
    if (!facesViewer(nx, ny)) continue;
    const k = 0.72 + 0.16 * (ny - nx);
    g.poly([...isoPoly([a, e], b.z0), ...isoPoly([e, a], b.z1)]).fill(shade(color, k));
  }
  g.poly(isoPoly(c, b.z1)).fill(shade(color, 1.12));
}

/** An upright quad on one side face of a box, between `along0` and `along1` (from the centre toward the front) and two heights. */
export function sidePanel(g: Graphics, b: Box, side: 'left' | 'right', along0: number, along1: number, z0: number, z1: number, color: number): void {
  const s = side === 'left' ? 1 : -1;
  const lx = b.uy * s * b.halfWidth, ly = -b.ux * s * b.halfWidth;
  const p = (a: number): [number, number] => [b.x + b.ux * a + lx, b.y + b.uy * a + ly];
  const nx = b.uy * s, ny = -b.ux * s;
  if (!facesViewer(nx, ny)) return;
  g.poly([...isoPoly([p(along0), p(along1)], z0), ...isoPoly([p(along1), p(along0)], z1)]).fill(color);
}

/** The ellipse a world circle of radius r becomes on the ground. */
export function groundEllipse(g: Graphics, x: number, y: number, r: number, z = 0): Graphics {
  return g.ellipse(isoX(x, y), isoY(x, y, z), r * Math.SQRT2 * (TILE_W / 2), r * Math.SQRT2 * (TILE_H / 2));
}
