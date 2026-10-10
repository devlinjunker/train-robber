// Tick system 3: the mounted player's horse. Steering, throttle, terrain and car collision.
import type { CollisionTarget, HorseState, PlayerId, PlayerState, SimConfig } from '../types';
import type { CarPose } from './cars';
import { pushOutOfBox, type Box } from './collide';
import { isSolid, Terrain, terrainAt, type WorldMap } from './map';

/** The horse collides as a circle of this radius. */
export const HORSE_RADIUS = 0.5;
/** Push-out passes per tick; one is enough unless boxes overlap, as tiles and bent cars do. */
const PASSES = 4;

const axis = (v: number) => (v < -127 ? -127 : v > 127 ? 127 : v | 0) / 127;

/** Rotate the heading by (cos, ±sin): positive turns clockwise on screen (y grows down). */
function rotate(h: HorseState, c: number, s: number): void {
  const x = h.hx * c - h.hy * s;
  const y = h.hx * s + h.hy * c;
  const n = Math.sqrt(x * x + y * y);
  h.hx = x / n;
  h.hy = y / n;
}

/** Heading-relative: x steers at the full turn rate, or a share of it for a partial axis. */
export function steerHeading(h: HorseState, k: number, cos: number, sin: number): void {
  if (k === 0) return;
  if (k === 1 || k === -1) { rotate(h, cos, sin * k); return; }
  const s = sin * k;
  rotate(h, Math.sqrt(1 - s * s), s);
}

/** Screen-relative: turn toward the world direction (tx, ty) by at most one tick's rotation. */
export function steerToward(h: HorseState, tx: number, ty: number, cos: number, sin: number): void {
  const n = Math.sqrt(tx * tx + ty * ty);
  if (n === 0) return;
  tx /= n; ty /= n;
  const dot = h.hx * tx + h.hy * ty;
  if (dot >= cos) { h.hx = tx; h.hy = ty; return; }
  const cross = h.hx * ty - h.hy * tx;
  // Directly behind turns clockwise, so the choice is deterministic.
  rotate(h, cos, cross < 0 ? -sin : sin);
}

/** Apply one tick of throttle under the configured model; speeds are tiles/s. */
export function throttle(h: HorseState, thr: number, cfg: SimConfig['values']['horse'], hz: number, cap: number): void {
  const accel = cfg.accel / hz, brake = cfg.brake / hz;
  if (cfg.throttleModel === 'cruise') {
    const rate = cfg.cruiseTargetRateTilesPerSec2 / hz;
    h.cruiseTarget += rate * thr;
    if (h.cruiseTarget > cfg.maxSpeed) h.cruiseTarget = cfg.maxSpeed;
    if (h.cruiseTarget < 0) h.cruiseTarget = 0;
    h.speed = h.speed < h.cruiseTarget ? Math.min(h.cruiseTarget, h.speed + accel) : Math.max(h.cruiseTarget, h.speed - brake);
  } else if (thr > 0) {
    h.speed += accel * thr;
  } else if (thr < 0) {
    h.speed += brake * thr;
  } else if (cfg.throttleModel === 'coast') {
    h.speed -= cfg.dragTilesPerSec2 / hz;
  }
  if (h.speed > cfg.maxSpeed) h.speed = cfg.maxSpeed;
  if (h.speed < 0) h.speed = 0;
  // Slow ground lowers the cap; above it the horse reins in at its braking rate.
  if (h.speed > cap) h.speed = Math.max(cap, h.speed - brake);
}

const tile: Box = { x: 0, y: 0, ux: 1, uy: 0, halfLength: 0.5, halfWidth: 0.5 };

/**
 * Push the horse out of blocked and water tiles (and the map edge). Returns 0 for no contact,
 * 1 for contact with water or the edge only, and 2 when a blocked tile inside the map was among
 * them: the only terrain that hurts to run into.
 */
function collideTerrain(h: HorseState, map: WorldMap): 0 | 1 | 2 {
  let hit: 0 | 1 | 2 = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false;
    const c0 = Math.floor(h.x - HORSE_RADIUS), c1 = Math.floor(h.x + HORSE_RADIUS);
    const r0 = Math.floor(h.y - HORSE_RADIUS), r1 = Math.floor(h.y + HORSE_RADIUS);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = terrainAt(map, c, r);
        if (!isSolid(t)) continue;
        tile.x = c + 0.5; tile.y = r + 0.5;
        if (!pushOutOfBox(h, HORSE_RADIUS, tile)) continue;
        moved = true;
        const inside = c >= 0 && r >= 0 && c < map.cols && r < map.rows;
        if (t === Terrain.Blocked && inside) hit = 2;
        else if (hit === 0) hit = 1;
      }
    }
    if (!moved) break;
    if (hit === 0) hit = 1;
  }
  return hit;
}

/** Push the horse out of every car; cars win over terrain, so this runs last. */
function collideCars(h: HorseState, cars: readonly CarPose[]): boolean {
  let hit = false;
  for (let pass = 0; pass < PASSES * 2; pass++) {
    let moved = false;
    for (const car of cars) if (pushOutOfBox(h, HORSE_RADIUS, car)) moved = true;
    if (!moved) break;
    hit = true;
  }
  return hit;
}

/** A horse that ran into something solid this tick, and the speed it lost doing so (tiles/s). */
export interface Impact { player: PlayerId; target: CollisionTarget; speedLost: number }

/** Tick system 3. Returns the impacts with a train or blocked ground; water and the map edge stop the horse without one. */
export function ride(players: readonly PlayerState[], horses: HorseState[], map: WorldMap, config: SimConfig, cars: readonly CarPose[]): Impact[] {
  const impacts: Impact[] = [];
  const cfg = config.values.horse;
  const hz = config.values.sim.tickRateHz;
  for (const p of players) {
    const h = horses.find((q) => q.id === p.horseId);
    if (!h || h.mode !== 'physical') continue;
    // A stunned horse ignores its rider: no steering or throttle, speed held where the failed jump left it.
    const stunned = h.stunTicks > 0;
    if (stunned) h.stunTicks -= 1;
    else if (cfg.steering === 'heading') steerHeading(h, axis(p.move.x), cfg.turnRateCosPerTick, cfg.turnRateSinPerTick);
    else steerToward(h, p.steer.x, p.steer.y, cfg.turnRateCosPerTick, cfg.turnRateSinPerTick);

    if (!stunned) {
      const cap = terrainAt(map, h.x, h.y) === Terrain.Slow ? cfg.maxSpeed * cfg.slowZoneSpeedScale : cfg.maxSpeed;
      throttle(h, -axis(p.move.y), cfg, hz, cap);
    }

    const x0 = h.x, y0 = h.y;
    h.x += (h.hx * h.speed) / hz;
    h.y += (h.hy * h.speed) / hz;
    const hitTerrain = collideTerrain(h, map);
    const hitCar = collideCars(h, cars);
    if (hitTerrain || hitCar) {
      // Speed drops to the distance actually covered: head-on stops the horse, a glancing
      // contact slides it along the obstacle and bleeds speed the steeper the angle. The speed
      // lost is the impact: riding into the back of a moving car loses only the closing speed.
      const dx = h.x - x0, dy = h.y - y0;
      const moved = Math.sqrt(dx * dx + dy * dy) * hz;
      if (moved < h.speed) {
        const target: CollisionTarget | null = hitCar ? 'train' : hitTerrain === 2 ? 'obstacle' : null;
        if (target) impacts.push({ player: p.id, target, speedLost: h.speed - moved });
        h.speed = moved;
      }
    }
    // A mounted player rides in the world frame with the horse.
    if (p.placement.frame === 'world') { p.placement.x = h.x; p.placement.y = h.y; }
  }
  return impacts;
}
