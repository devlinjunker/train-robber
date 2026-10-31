// Guards for the views: where each one stands in the world, which way it looks, and its sight
// cone clipped by cells that block sight (faint by default; full with the debug overlay or ?cones=on). The sim decides what a
// guard sees; the cone is only a picture of the same rule.
import { carToWorld, fromTrain, guardTuning, sightRange, sightReach, toTrain, trainGrid, type CarPose, type GuardAwareness, type SimConfig } from '@train-robber/sim';
import type { GuardPose } from './interp';

/** A guard placed in the world: position, unit facing and awareness. */
/** `heard`: the guard just heard the player (an ear shows over its head). `searching`: alert but lost you (a ? shows). */
/** `roof`: up on a roof (drawn on top of the car); `climb`: how far up a ladder, 0 to 1, or null. */
/** `remembers`: it went alert this run and remembers you (a red eye shows, unless ?remembers=off). */
export interface GuardView { id: number; car: number; x: number; y: number; fx: number; fy: number; state: GuardAwareness; heard: boolean; searching: boolean; roof: boolean; climb: number | null; remembers: boolean }

/** A sight cone as a fan of world points, the guard first. */
/** `roof`: a guard up on a roof, whose cone lies on the roofs (nothing blocks it up there). */
export interface ConeView { id: number; car: number; state: GuardAwareness; points: [number, number][]; faint: boolean; roof: boolean }

/** Rays per cone: enough that a doorway reads, few enough to redraw every frame. */
const CONE_RAYS = 18;

/** A car-frame direction in the world, for a car whose front points along (ux, uy): +x is toward the rear, +y toward the right. */
export function carDirToWorld(car: Pick<CarPose, 'ux' | 'uy'>, dx: number, dy: number): [number, number] {
  return [-(car.ux * dx + car.uy * dy), -car.uy * dx + car.ux * dy];
}

/** The run's guards in the world, on the train's cars as drawn this frame. */
export function guardsInWorld(guards: readonly GuardPose[], cars: readonly CarPose[], trainId: string, heard: (id: number) => boolean = () => false, searching: (id: number) => boolean = () => false, showMemory = true): GuardView[] {
  const out: GuardView[] = [];
  for (const g of guards) {
    const car = cars.find((c) => c.trainId === trainId && c.index === g.car);
    if (!car) continue;
    const at = carToWorld(car, g.x, g.y);
    const [fx, fy] = carDirToWorld(car, g.fx, g.fy);
    out.push({ id: g.id, car: g.car, x: at.x, y: at.y, fx, fy, state: g.state, heard: heard(g.id), searching: searching(g.id), roof: g.roof, climb: g.climb, remembers: showMemory && g.remembers });
  }
  return out;
}

/**
 * Each guard's sight cone: rays across the cone, each stopped where a cell that blocks sight
 * starts (`sightReach`, the sim's own sampling), carried through the train's cars end to end. The
 * cone is the guard's real reach at run heat `heat`: its heat band and memory bonus (M6b).
 */
export function sightCones(config: SimConfig, templates: readonly string[], guards: readonly GuardPose[], cars: readonly CarPose[], trainId: string, faint = false, heat = 0): ConeView[] {
  const grid = trainGrid(config, templates);
  const ai = config.values.ai;
  const half = Math.acos(Math.max(-1, Math.min(1, ai.sight.coneCos)));
  const poseOf = (i: number) => cars.find((c) => c.trainId === trainId && c.index === i);
  const world = (lx: number, y: number): [number, number] | null => {
    const at = fromTrain(grid, lx);
    const car = poseOf(at.car);
    if (!car) return null;
    const p = carToWorld(car, at.x, y);
    return [p.x, p.y];
  };
  const out: ConeView[] = [];
  for (const g of guards) {
    const lx = toTrain(grid, g.car, g.x);
    const origin = world(lx, g.y);
    if (!origin) continue;
    const base = Math.atan2(g.fy, g.fx);
    const points: [number, number][] = [origin];
    const bonus = guardTuning(config, heat, g.remembers).sightBonusTiles;
    for (let i = 0; i <= CONE_RAYS; i++) {
      const a = base - half + (2 * half * i) / CONE_RAYS;
      const dx = Math.cos(a), dy = Math.sin(a);
      // Up on a roof nothing is in the way (the sim checks range and cone only).
      const r = g.roof ? config.values.outside.roof.guardSightTiles : sightReach(grid, lx, g.y, dx, dy, sightRange(grid, ai, lx, g.y, bonus));
      const p = world(lx + dx * r, g.y + dy * r);
      if (p) points.push(p);
    }
    out.push({ id: g.id, car: g.car, state: g.state, points, faint, roof: g.roof });
  }
  return out;
}

/** Colours by awareness: calm grey-white, suspicious amber, alert red. */
export const GUARD_STATE_COLOURS: Record<GuardAwareness, number> = { unaware: 0xe8e8e8, suspicious: 0xffb02e, alert: 0xff3b30 };
