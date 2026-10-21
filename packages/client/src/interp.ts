// Interpolation between the last two ticks. After each tick the host pushes the positions of
// the actors the view draws; each frame draws a lerp between the previous and current tick by
// the accumulator remainder. Only these numbers are copied, never the whole state.
import type { CarPose, GameState, GuardAwareness } from '@train-robber/sim';

/** A jump this far in one tick (cancel, quick retry, boarding) snaps instead of sliding. */
const SNAP_TILES = 3;
const CAR_FIELDS = 4; // x, y, ux, uy

export interface ActorPose { x: number; y: number; hx: number; hy: number }

/** A guard in its car's frame, as the view draws it. */
/** `roof`: up on its car's roof; `climb`: how far up a ladder it is (0 at the foot, 1 at the top) while climbing, else null. */
export interface GuardPose { id: number; car: number; x: number; y: number; fx: number; fy: number; state: GuardAwareness; roof: boolean; climb: number | null }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Interpolator {
  private prevCars = new Float64Array(0);
  private currCars = new Float64Array(0);
  private carMeta: Pick<CarPose, 'trainId' | 'index' | 'template' | 'halfLength' | 'halfWidth'>[] = [];
  private carsChanged = true;
  private prevHorse = new Float64Array(4);
  private currHorse = new Float64Array(4);
  private prevPlacement = new Float64Array(2);
  private currPlacement = new Float64Array(2);
  private prevFrame = '';
  private currFrame = '';
  private prevTrainD = new Map<string, number>();
  private currTrainD = new Map<string, number>();
  private prevGuards = new Map<number, GuardPose>();
  private currGuards = new Map<number, GuardPose>();
  private pushes = 0;

  /** Record the state after a tick. Call once per tick, after `sim.step`. */
  push(state: Readonly<GameState>, cars: readonly CarPose[], climbTicks = 60): void {
    [this.prevCars, this.currCars] = [this.currCars, this.prevCars];
    if (this.currCars.length !== cars.length * CAR_FIELDS) this.currCars = new Float64Array(cars.length * CAR_FIELDS);
    this.carsChanged = this.prevCars.length !== this.currCars.length
      || cars.some((c, i) => this.carMeta[i]?.trainId !== c.trainId || this.carMeta[i]?.index !== c.index);
    this.carMeta = cars.map(({ trainId, index, template, halfLength, halfWidth }) => ({ trainId, index, template, halfLength, halfWidth }));
    cars.forEach((c, i) => this.currCars.set([c.x, c.y, c.ux, c.uy], i * CAR_FIELDS));

    [this.prevHorse, this.currHorse] = [this.currHorse, this.prevHorse];
    const h = state.world.horses[0];
    if (h) this.currHorse.set([h.x, h.y, h.hx, h.hy]);

    [this.prevPlacement, this.currPlacement] = [this.currPlacement, this.prevPlacement];
    this.prevFrame = this.currFrame;
    const p = state.players[0];
    if (p) { this.currPlacement.set([p.placement.x, p.placement.y]); this.currFrame = p.placement.frame; }

    [this.prevTrainD, this.currTrainD] = [this.currTrainD, this.prevTrainD];
    this.currTrainD.clear();
    for (const t of state.world.trains) this.currTrainD.set(t.id, t.d);

    [this.prevGuards, this.currGuards] = [this.currGuards, this.prevGuards];
    this.currGuards.clear();
    for (const g of state.run?.guards ?? []) {
      // Up a ladder: the share of the climb done, counted from the foot.
      const left = g.climb ? g.climb.ticks / Math.max(1, climbTicks) : 0;
      const climb = g.climb ? (g.roof ? left : 1 - left) : null;
      this.currGuards.set(g.id, { id: g.id, car: g.car, x: g.x, y: g.y, fx: g.fx, fy: g.fy, state: g.state, roof: g.roof, climb });
    }
    this.pushes++;
  }

  /** The run's guards at fraction `t`; one that changed car (or is new) snaps. */
  guards(t: number): GuardPose[] {
    const out: GuardPose[] = [];
    for (const c of this.currGuards.values()) {
      const p = this.prevGuards.get(c.id);
      if (!p || p.car !== c.car || p.roof !== c.roof) { out.push(c); continue; }
      let fx = lerp(p.fx, c.fx, t), fy = lerp(p.fy, c.fy, t);
      const n = Math.hypot(fx, fy);
      if (n > 1e-6) { fx /= n; fy /= n; } else { fx = c.fx; fy = c.fy; }
      out.push({ ...c, x: lerp(p.x, c.x, t), y: lerp(p.y, c.y, t), fx, fy });
    }
    return out;
  }

  /** Car poses at fraction `t` between the last two ticks. */
  cars(t: number): CarPose[] {
    const fresh = this.carsChanged || this.pushes < 2;
    return this.carMeta.map((m, i) => {
      const o = i * CAR_FIELDS, c = this.currCars, p = fresh ? c : this.prevCars;
      const far = Math.abs(c[o]! - p[o]!) + Math.abs(c[o + 1]! - p[o + 1]!) > SNAP_TILES;
      const k = far ? 1 : t;
      let ux = lerp(p[o + 2]!, c[o + 2]!, k), uy = lerp(p[o + 3]!, c[o + 3]!, k);
      const n = Math.hypot(ux, uy) || 1;
      ux /= n; uy /= n;
      return { ...m, x: lerp(p[o]!, c[o]!, k), y: lerp(p[o + 1]!, c[o + 1]!, k), ux, uy };
    });
  }

  /** The horse at fraction `t`. */
  horse(t: number): ActorPose {
    const p = this.pushes < 2 ? this.currHorse : this.prevHorse, c = this.currHorse;
    const k = Math.abs(c[0]! - p[0]!) + Math.abs(c[1]! - p[1]!) > SNAP_TILES ? 1 : t;
    let hx = lerp(p[2]!, c[2]!, k), hy = lerp(p[3]!, c[3]!, k);
    const n = Math.hypot(hx, hy) || 1;
    hx /= n; hy /= n;
    return { x: lerp(p[0]!, c[0]!, k), y: lerp(p[1]!, c[1]!, k), hx, hy };
  }

  /** The player's placement at fraction `t`, in its current frame; a frame change snaps. */
  placement(t: number): { frame: string; x: number; y: number } {
    const c = this.currPlacement, k = this.prevFrame === this.currFrame ? t : 1, p = this.prevPlacement;
    return { frame: this.currFrame, x: lerp(p[0]!, c[0]!, k), y: lerp(p[1]!, c[1]!, k) };
  }

  /** A train's distance along its route at fraction `t`; a wrap past the route's end snaps. */
  trainD(id: string, t: number): number | null {
    const c = this.currTrainD.get(id);
    if (c === undefined) return null;
    const p = this.prevTrainD.get(id) ?? c;
    return c < p ? c : lerp(p, c, t);
  }
}
