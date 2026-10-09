// Circle against rectangle push-out, shared by terrain tiles and train cars.
// Square roots only: they are exact in IEEE arithmetic, unlike trig.

/** A rectangle with centre (x, y), unit axis (ux, uy) along its length, and half extents. */
export interface Box {
  x: number;
  y: number;
  ux: number;
  uy: number;
  halfLength: number;
  halfWidth: number;
}

/**
 * Move the circle at `p` with radius `r` the shortest way out of `b`. Returns true when it
 * moved. A centre inside the box leaves through the nearest side.
 */
export function pushOutOfBox(p: { x: number; y: number }, r: number, b: Box): boolean {
  const dx = p.x - b.x, dy = p.y - b.y;
  // Box-local coordinates: lx along the axis, ly across it (toward (-uy, ux)).
  const lx = dx * b.ux + dy * b.uy;
  const ly = dy * b.ux - dx * b.uy;
  const hx = b.halfLength, hy = b.halfWidth;
  if (lx >= hx + r || lx <= -hx - r || ly >= hy + r || ly <= -hy - r) return false;
  const cx = lx < -hx ? -hx : lx > hx ? hx : lx;
  const cy = ly < -hy ? -hy : ly > hy ? hy : ly;
  const ox = lx - cx, oy = ly - cy;
  const d2 = ox * ox + oy * oy;
  let nx: number, ny: number;
  if (d2 > 0) {
    if (d2 >= r * r) return false;
    const k = r / Math.sqrt(d2);
    nx = cx + ox * k;
    ny = cy + oy * k;
  } else if (hx - (lx < 0 ? -lx : lx) < hy - (ly < 0 ? -ly : ly)) {
    nx = (lx < 0 ? -1 : 1) * (hx + r);
    ny = ly;
  } else {
    nx = lx;
    ny = (ly < 0 ? -1 : 1) * (hy + r);
  }
  p.x = b.x + nx * b.ux - ny * b.uy;
  p.y = b.y + nx * b.uy + ny * b.ux;
  return true;
}

/** True when the point lies strictly inside the box. */
export function pointInBox(x: number, y: number, b: Box): boolean {
  const dx = x - b.x, dy = y - b.y;
  const lx = dx * b.ux + dy * b.uy;
  const ly = dy * b.ux - dx * b.uy;
  return lx > -b.halfLength && lx < b.halfLength && ly > -b.halfWidth && ly < b.halfWidth;
}

/** Distance from a point to the nearest point of the box; 0 inside it. */
export function distanceToBox(x: number, y: number, b: Box): number {
  const dx = x - b.x, dy = y - b.y;
  const lx = dx * b.ux + dy * b.uy;
  const ly = dy * b.ux - dx * b.uy;
  const ox = lx < -b.halfLength ? -b.halfLength - lx : lx > b.halfLength ? lx - b.halfLength : 0;
  const oy = ly < -b.halfWidth ? -b.halfWidth - ly : ly > b.halfWidth ? ly - b.halfWidth : 0;
  return Math.sqrt(ox * ox + oy * oy);
}
