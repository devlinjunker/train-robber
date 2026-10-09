// Car templates, car placement along a route, and entry points in world space.
// Phase 1 generates the two templates in code; `tools build-cars` replaces this in phase 2.
import { trackAt, type TrackPoint, type TrackRoute } from './track';

export type CellType = 'floor' | 'wall' | 'door';
export type Side = 'left' | 'right';

export interface EntryPoint {
  id: string;
  /** Side of the car relative to the direction of travel. */
  side: Side;
  /** Distance from the car's centre toward its front, in tiles; 0 is mid-car. */
  along: number;
  /** The door cell a boarding player lands on: [col, row], col 0 at the front, row 0 on the left. */
  cell: readonly [number, number];
}

export interface CarTemplate {
  id: string;
  /** Cells along the car (cols) and across it (rows), one cell per tile. */
  size: { cols: number; rows: number };
  /** Row-major cell types, cols × rows. */
  cells: readonly CellType[];
  entryPoints: readonly EntryPoint[];
}

export const CAR_LENGTH = 16;
export const CAR_WIDTH = 6;

function walledCar(id: string, doorCols: readonly number[]): CarTemplate {
  const cols = CAR_LENGTH, rows = CAR_WIDTH;
  const cells: CellType[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const edge = r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
      const side = r === 0 || r === rows - 1;
      cells.push(!edge ? 'floor' : side && doorCols.includes(c) ? 'door' : 'wall');
    }
  }
  const mid = cols / 2;
  const entryPoints: EntryPoint[] = doorCols.length === 0 ? [] : [
    { id: 'side-left', side: 'left', along: 0, cell: [mid, 0] },
    { id: 'side-right', side: 'right', along: 0, cell: [mid, rows - 1] },
  ];
  return { id, size: { cols, rows }, cells, entryPoints };
}

/** The engine has no doors; a blank car has a two-cell door mid-car on both sides. */
export const CAR_TEMPLATES: Readonly<Record<string, CarTemplate>> = {
  engine: walledCar('engine', []),
  'blank-car': walledCar('blank-car', [CAR_LENGTH / 2 - 1, CAR_LENGTH / 2]),
};

/** A car's rigid rectangle in world space. */
export interface CarPose {
  trainId: string;
  /** Position in the train, 0 is the engine. */
  index: number;
  template: string;
  /** Centre of the rectangle. */
  x: number;
  y: number;
  /** Unit axis toward the car's front (the direction of travel). */
  ux: number;
  uy: number;
  halfLength: number;
  halfWidth: number;
}

/** Template ids in train order, with `count` expanded. */
export function expandCars(cars: readonly { template: string; count?: number }[]): string[] {
  return cars.flatMap((c) => Array<string>(c.count ?? 1).fill(c.template));
}

const front: TrackPoint = { d: 0, x: 0, y: 0, tx: 1, ty: 0 };
const rear: TrackPoint = { d: 0, x: 0, y: 0, tx: 1, ty: 0 };

/**
 * Place a train's cars end to end behind the engine's front at distance `d`. Each car is
 * rigid: its front and rear sit on the track and its body is the chord between them, so
 * on a bend the middle of a car cuts inside the curve, as a real one does.
 */
export function placeCars(trainId: string, templates: readonly string[], route: TrackRoute, d: number, out: CarPose[] = []): CarPose[] {
  out.length = 0;
  let offset = 0;
  for (let i = 0; i < templates.length; i++) {
    const t = CAR_TEMPLATES[templates[i]!];
    if (!t) throw new Error(`unknown car template ${templates[i]}`);
    const len = t.size.cols;
    trackAt(route, d - offset, front);
    trackAt(route, d - offset - len, rear);
    offset += len;
    let ux = front.x - rear.x, uy = front.y - rear.y;
    const n = Math.sqrt(ux * ux + uy * uy);
    if (n > 1e-9) { ux /= n; uy /= n; } else { ux = front.tx; uy = front.ty; }
    out.push({
      trainId, index: i, template: t.id,
      x: (front.x + rear.x) / 2, y: (front.y + rear.y) / 2, ux, uy,
      halfLength: len / 2, halfWidth: t.size.rows / 2,
    });
  }
  return out;
}

/** Total length of a train in tiles. */
export function trainLength(templates: readonly string[]): number {
  return templates.reduce((n, id) => n + (CAR_TEMPLATES[id]?.size.cols ?? 0), 0);
}

/**
 * An entry point in world space: the car's centre, moved `along` the car and out to the
 * side wall across the track. Left is to the left of the direction of travel (screen y
 * grows down, so left of (ux, uy) is (uy, -ux)). The boarding rule and the markers share this.
 */
export function entryPointWorld(car: CarPose, ep: Pick<EntryPoint, 'side' | 'along'>, out = { x: 0, y: 0 }): { x: number; y: number } {
  const s = ep.side === 'left' ? 1 : -1;
  out.x = car.x + car.ux * ep.along + car.uy * car.halfWidth * s;
  out.y = car.y + car.uy * ep.along - car.ux * car.halfWidth * s;
  return out;
}

/** Every entry point of a placed car, in world space. */
export function carEntryPoints(car: CarPose): { id: string; side: Side; x: number; y: number }[] {
  const t = CAR_TEMPLATES[car.template]!;
  return t.entryPoints.map((ep) => ({ id: ep.id, side: ep.side, ...entryPointWorld(car, ep) }));
}
