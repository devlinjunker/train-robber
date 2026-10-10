// The follow camera: it leads the horse along its velocity, scaled by speed and clamped, and
// eases toward that point so turns and speed changes never jerk the view.

/** Seconds of travel the camera leads by, and the most it leads, in tiles. */
export const LEAD_SEC = 0.7;
export const LEAD_MAX_TILES = 10;
/** How fast the camera closes on its target, per second (exponential ease). */
export const FOLLOW_RATE = 4;

export interface FollowCamera { x: number; y: number }

/** Where the camera wants to be: the focus plus a speed-scaled lead along the heading. */
export function lookAheadTarget(x: number, y: number, hx: number, hy: number, speed: number): { x: number; y: number } {
  const lead = Math.min(LEAD_MAX_TILES, speed * LEAD_SEC);
  return { x: x + hx * lead, y: y + hy * lead };
}

/** Move the camera toward the target for `dtSec`; `snap` jumps straight there (a teleport or a scene change). */
export function follow(cam: FollowCamera, target: { x: number; y: number }, dtSec: number, snap = false): void {
  const k = snap ? 1 : 1 - Math.exp(-FOLLOW_RATE * dtSec);
  cam.x += (target.x - cam.x) * k;
  cam.y += (target.y - cam.y) * k;
}
