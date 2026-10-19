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

/**
 * Apply one tick of throttle under the configured model; speeds are tiles/s. `top` is the top
 * speed (raised during a boost) and `cap` the top speed on this ground. Above either, as after a
 * boost or on entering mud, the horse reins in at its braking rate rather than all at once.
 */
export function throttle(h: HorseState, thr: number, cfg: SimConfig['values']['horse'], hz: number, cap: number, top: number = cfg.maxSpeed): void {
  const accel = cfg.accel / hz, brake = cfg.brake / hz;
  const before = h.speed;
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
  // Never accelerate past the top speed, nor past where a boost left the horse.
  const ceiling = Math.max(top, before);
  if (h.speed > ceiling) h.speed = ceiling;
  if (h.speed < 0) h.speed = 0;
  // Slow ground lowers the cap; above it the horse reins in at its braking rate.
  if (h.speed > cap) h.speed = Math.max(cap, h.speed - brake);
}

const tile: Box = { x: 0, y: 0, ux: 1, uy: 0, halfLength: 0.5, halfWidth: 0.5 };

/**
 * Push the horse out of blocked and deep-water tiles (and the map edge). Returns 0 for no contact,
 * 1 for contact with deep water or the edge only, and 2 when a blocked tile inside the map was
 * among them: the only terrain that hurts to run into.
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
function collideCars(h: HorseState, cars: readonly CarPose[]): CarPose | null {
  let hit: CarPose | null = null;
  for (let pass = 0; pass < PASSES * 2; pass++) {
    let moved = false;
    for (const car of cars) if (pushOutOfBox(h, HORSE_RADIUS, car)) { moved = true; hit = car; }
    if (!moved) break;
  }
  return hit;
}

/**
 * How hard a contact was: the closing speed along the push. (vx, vy) is the horse's velocity
 * relative to what it hit, (px, py) how far the collision moved it. Head-on into a rock or a car
 * side, or a car running into a standing horse, closes fast; scraping along a car at a shallow
 * angle barely closes at all. Zero when the push came with no closing motion.
 */
function closingSpeed(vx: number, vy: number, px: number, py: number): number {
  const n = Math.sqrt(px * px + py * py);
  if (n === 0) return 0;
  const c = -(vx * px + vy * py) / n;
  return c > 0 ? c : 0;
}

/**
 * What a riderless horse's steering AI wants this tick (U4): a world point to turn toward and a
 * speed to reach, in tiles/s. It turns at the horse's turn rate and changes speed at its accel and
 * brake rates, so it rides with the same physics as a ridden horse (and never boosts).
 */
export interface HorseIntent { tx: number; ty: number; speed: number }

/** One tick of AI throttle: accelerate or brake toward `target`, under the ground's cap. */
function aiThrottle(h: HorseState, target: number, cfg: SimConfig['values']['horse'], hz: number, cap: number): void {
  const t = Math.min(target, cap, cfg.maxSpeed);
  if (h.speed < t) h.speed = Math.min(t, h.speed + cfg.accel / hz);
  else if (h.speed > t) h.speed = Math.max(t, h.speed - cfg.brake / hz);
  if (h.speed < 0) h.speed = 0;
}

/** A horse touching a car or blocked ground this tick, and how hard: the closing speed along the contact, tiles/s. */
export interface Impact { player: PlayerId; target: CollisionTarget; impact: number }

/**
 * Tick system 3. Returns every contact a ridden horse makes with a train car or blocked ground; deep
 * water and the map edge stop the horse without one. A physical horse whose rider is aboard is
 * riderless: `ai` steers it, it collides the same way, and its contacts cost nothing.
 */
export function ride(
  players: readonly PlayerState[], horses: HorseState[], map: WorldMap, config: SimConfig, cars: readonly CarPose[],
  /** Each train's speed, tiles/s, for how hard a car and the horse meet; standing still when left out. */
  carSpeed: (trainId: string) => number = () => 0,
  /** The steering AI for a riderless horse; without it (or a null intent) the horse reins in where it is. */
  ai: (p: PlayerState, h: HorseState) => HorseIntent | null = () => null,
): Impact[] {
  const impacts: Impact[] = [];
  const cfg = config.values.horse;
  const hz = config.values.sim.tickRateHz;
  for (const p of players) {
    const h = horses.find((q) => q.id === p.horseId);
    if (!h || h.mode !== 'physical') continue;
    const mounted = p.placement.frame === 'world';
    const intent = mounted ? null : ai(p, h) ?? { tx: h.x + h.hx, ty: h.y + h.hy, speed: 0 };
    // A stunned horse ignores its rider: no steering or throttle, speed held where the failed jump left it.
    const stunned = h.stunTicks > 0;
    if (stunned) h.stunTicks -= 1;
    else if (intent) steerToward(h, intent.tx - h.x, intent.ty - h.y, cfg.turnRateCosPerTick, cfg.turnRateSinPerTick);
    else if (cfg.steering === 'heading') steerHeading(h, axis(p.move.x), cfg.turnRateCosPerTick, cfg.turnRateSinPerTick);
    else steerToward(h, p.steer.x, p.steer.y, cfg.turnRateCosPerTick, cfg.turnRateSinPerTick);

    // A boost (handlingModel arcade-boost) raises the top speed and pushes toward it; its
    // cooldown starts when it ends. A stun holds both clocks. The riderless horse never boosts.
    const boosting = mounted && h.boostTicks > 0 && !stunned;
    if (!stunned) {
      if (h.boostTicks > 0) { h.boostTicks -= 1; if (h.boostTicks === 0) h.boostCooldownTicks = cfg.boost.cooldownTicks; }
      else if (h.boostCooldownTicks > 0) h.boostCooldownTicks -= 1;
    }
    if (!stunned) {
      const top = boosting ? cfg.maxSpeed * cfg.boost.topSpeedScale : cfg.maxSpeed;
      const ground = terrainAt(map, h.x, h.y);
      const cap = ground === Terrain.Slow ? top * cfg.slowZoneSpeedScale
        : ground === Terrain.Water ? top * cfg.waterSpeedScale : top;
      // Mud reins the horse in at its braking rate; water drags it down to wading speed at once.
      if (ground === Terrain.Water && h.speed > cap) h.speed = cap;
      if (intent) aiThrottle(h, intent.speed, cfg, hz, cap);
      else {
        throttle(h, -axis(p.move.y), cfg, hz, cap, top);
        if (boosting && h.speed < cap) h.speed = Math.min(cap, h.speed + cfg.boost.accelTilesPerSec2 / hz);
      }
    }

    const x0 = h.x, y0 = h.y, speed = h.speed;
    h.x += (h.hx * h.speed) / hz;
    h.y += (h.hy * h.speed) / hz;
    const x1 = h.x, y1 = h.y;
    const hitTerrain = collideTerrain(h, map);
    const x2 = h.x, y2 = h.y;
    const hitCar = collideCars(h, cars);
    const vx = h.hx * speed, vy = h.hy * speed;
    // A riderless horse takes no crash damage (U4), so only a ridden one reports contacts.
    if (mounted && hitCar) {
      const cs = carSpeed(hitCar.trainId);
      impacts.push({ player: p.id, target: 'train', impact: closingSpeed(vx - hitCar.ux * cs, vy - hitCar.uy * cs, h.x - x2, h.y - y2) });
    } else if (mounted && hitTerrain === 2) impacts.push({ player: p.id, target: 'obstacle', impact: closingSpeed(vx, vy, x2 - x1, y2 - y1) });
    if (hitTerrain || hitCar) {
      // Speed drops to the distance actually covered: head-on stops the horse, a glancing
      // contact slides it along the obstacle and bleeds speed the steeper the angle.
      const dx = h.x - x0, dy = h.y - y0;
      const moved = Math.sqrt(dx * dx + dy * dy) * hz;
      if (moved < h.speed) h.speed = moved;
    }
    // A mounted player rides in the world frame with the horse.
    if (p.placement.frame === 'world') { p.placement.x = h.x; p.placement.y = h.y; }
  }
  return impacts;
}
