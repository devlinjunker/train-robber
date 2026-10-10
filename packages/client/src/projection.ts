// The isometric projection, the one place that knows how the logical 2D world maps to the
// screen. The sim never sees any of this. 2:1 isometric with placeholder 64 × 32 px tiles:
// world +x runs down-right on screen and +y down-left, so up the screen is -x -y.

export const TILE_W = 64;
export const TILE_H = 32;
/** Screen pixels per tile of height (z), at zoom 1. */
export const Z_PX = TILE_H;

/** Zoom steps for Q / Z and - / =; the wheel zooms smoothly between the ends. */
export const ZOOM_STEPS = [0.35, 0.5, 0.7, 1, 1.4, 2] as const;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;
export const DEFAULT_ZOOM = 0.7;

/** What the camera shows: the world point at the screen centre, the zoom and the screen size. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

/** A world point in unzoomed iso pixels, relative to the world origin. `z` is height in tiles. */
export function isoX(x: number, y: number): number {
  return (x - y) * (TILE_W / 2);
}
export function isoY(x: number, y: number, z = 0): number {
  return (x + y) * (TILE_H / 2) - z * Z_PX;
}

/** World (tiles, plus height in tiles) to screen pixels through the camera. */
export function worldToScreen(x: number, y: number, z: number, cam: Camera, out = { x: 0, y: 0 }): { x: number; y: number } {
  out.x = (isoX(x, y) - isoX(cam.x, cam.y)) * cam.zoom + cam.width / 2;
  out.y = (isoY(x, y, z) - isoY(cam.x, cam.y)) * cam.zoom + cam.height / 2;
  return out;
}

/** Screen pixels to the world point on the ground (z = 0) under them. */
export function screenToWorld(sx: number, sy: number, cam: Camera, out = { x: 0, y: 0 }): { x: number; y: number } {
  const px = (sx - cam.width / 2) / cam.zoom + isoX(cam.x, cam.y);
  const py = (sy - cam.height / 2) / cam.zoom + isoY(cam.x, cam.y);
  // Invert isoX = (x - y) * W/2 and isoY = (x + y) * H/2.
  const a = px / (TILE_W / 2), b = py / (TILE_H / 2);
  out.x = (a + b) / 2;
  out.y = (b - a) / 2;
  return out;
}

/**
 * A direction on screen (for example from the arrow keys) as a unit world direction, through
 * the inverse projection, so "up the screen" stays up the screen. Zero in, zero out.
 */
export function screenDirToWorld(dx: number, dy: number): [number, number] {
  const a = dx / (TILE_W / 2), b = dy / (TILE_H / 2);
  const x = (a + b) / 2, y = (b - a) / 2;
  const n = Math.hypot(x, y);
  return n === 0 ? [0, 0] : [x / n, y / n];
}

/**
 * A key direction (arrows or WASD, -1..1 per axis) as a unit world direction. Single keys follow
 * the inverse projection exactly (right on screen stays right on screen), and two-key diagonals
 * land on the world axes, the tile edges that tracks, car walls and the train scene run along.
 * Keys only make 45° diagonals, and an axis is 26.6° from horizontal on a 2:1 screen, so the exact
 * inverse would leave no way to ride or walk straight along one.
 */
export function keyDirToWorld(dx: number, dy: number): [number, number] {
  const n = Math.hypot(dx, dy);
  if (n === 0) return [0, 0];
  const x = dx / n, y = dy / n;
  return [(x + y) * Math.SQRT1_2, (y - x) * Math.SQRT1_2];
}

/** Depth for draw order: larger is nearer the viewer. Height is a per-layer offset. */
export function depthOf(x: number, y: number, layerOffset = 0): number {
  return x + y + layerOffset;
}

/** The next zoom step in or out from the current zoom (which the wheel may have left between steps). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > zoom + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6) ?? ZOOM_STEPS[0]!;
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}
