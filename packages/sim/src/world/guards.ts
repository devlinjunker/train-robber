// Light guards (phase 2 M3): placed on the layouts' guard spawns at commit, they patrol their
// car's route (or stand watch), notice the player by a sight cone blocked by cells that block
// sight and by the noise of footsteps, and go from unaware to suspicious to alert. Spotting the
// player raises `playerSpotted` heat and going alert raises the alarm (`alarmRaised`). There is no
// combat: under guardCatch `thrown-off` an alert guard chases and, on contact, throws the player
// off the train (run.ts `throwOff`); under `heat-only` guards only raise heat.
//
// Sneaking (phase 2): a crouched player is quieter and hidden from a guard by low cover (crates,
// barrels) between them, and a chasing guard that loses the player for `ai.loseSightSec` stops
// chasing, stays alert and searches where it last knew they were.
//
// Perception and movement work in train coordinates: the cars' frames laid end to end, so `lx`
// is the column across the whole train (car offset + x) and y is the row. End doors join the
// cars, so a guard can chase through them and see along a corridor that does not pass a door.
import { nextInt, type StreamName } from '../rng';
import type { CarEnd, GameState, GuardAwareness, GuardState, PlayerState, SimConfig, SimEvent, TrainState } from '../types';
import { carCatalog, carTemplate, type CarCatalog } from './cars';
import { curvePull } from './curve';
import { parseCarFrame } from './frames';
import type { WorldMap } from './map';
import { raiseHeatFor } from '../rules/heat';

const GEN: StreamName = 'gen';

/** What the guard system needs from the tick; `RunCtx` satisfies it. */
export interface GuardCtx {
  state: GameState;
  config: SimConfig;
  /** The world map, for the curve under a roof guard (guards slip with it); without one they never slip. */
  map?: WorldMap;
  emit(ev: SimEvent): void;
}

/**
 * How many guards a train of this type gets at commit: its `guards.base` plus the wanted level
 * bonus. Run generation reads the count only through here, so M5 only fills in the bonus.
 */
/**
 * Guards a train gets: `guards.base` plus `guards.perCar` for each of its cars with guard spawns
 * (rounded), plus the wanted-level bonus. Pass `guardedCars` when the train's cars are known;
 * without it `perCar` counts the train's `carCount`.
 */
export function guardCount(config: SimConfig, trainType: string, wantedLevel: number, guardedCars?: number): number {
  const def = config.values.trains[trainType];
  const perCar = Math.round((def?.guards?.perCar ?? 0) * (guardedCars ?? def?.carCount ?? 0));
  return Math.max(0, (def?.guards?.base ?? 0) + perCar + wantedGuardBonus(config, trainType, wantedLevel));
}

/**
 * Extra guards for the wanted level. Phase 2 M5 adds `wanted.guardBonus` (indexed by level) and
 * `trains.<id>.guards.perWantedLevel`; until then the wanted level adds none.
 */
export function wantedGuardBonus(config: SimConfig, trainType: string, wantedLevel: number): number {
  void config; void trainType; void wantedLevel;
  return 0;
}

const FACING: Record<string, readonly [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** What a train grid cell is: off the train, inside a car, or one of the outside spaces (sneaking PR 2). `Roof` is never a cell: `playerSpace` says it for a player up on a roof (sneaking PR 3). */
export const Space = { None: 0, Inside: 1, Platform: 2, Ledge: 3, Coupling: 4, Roof: 5 } as const;
export type Space = (typeof Space)[keyof typeof Space];

/**
 * The whole train as one grid of cells, cars in order with their outside spaces round them: an
 * end platform `outside.platformDepthTiles` deep at each end, a ledge `ledgeWidthTiles` wide along
 * each long side (round the platform corners too), and after each car but the last the coupling
 * gap, crossed on the coupling plate. What perception, pathing and walking aboard read.
 *
 * Train coordinates: `lx` is the grid column (a car's x plus its offset) and y is the car-frame
 * row, so a car's row 0 is grid row `rowOffset` and the left ledge has negative y. A ledge narrower
 * than a tile still takes a whole row of cells; `yMin` / `yMax` narrow where in them one can stand.
 */
export interface TrainGrid {
  /** Grid column of each car's x = 0 (its front wall). */
  offsets: readonly number[];
  /** Each car body's columns (length) and rows (width): its roof, from its offset (sneaking PR 3). */
  carCols: readonly number[];
  carRows: readonly number[];
  /** Grid column where each car's own stretch starts: its front platform. The gap behind a car belongs to it. */
  starts: readonly number[];
  /** Train x where each column starts, and the train's length at the end (cols + 1 entries). */
  colX: Float64Array;
  /** Every column one tile wide from 0 (whole-tile platforms and gaps), so a column is floor(lx). */
  unitCols: boolean;
  /** `outside.ledgeWidthTiles`. */
  ledgeWidth: number;
  /** Grid row of car-frame y = 0: the ledge width, rounded up to whole cells. */
  rowOffset: number;
  cols: number;
  rows: number;
  /** Per cell, row-major over the whole train: 1 where it blocks movement / sight; noise multiplier; cover. */
  blocksMove: Uint8Array;
  blocksSight: Uint8Array;
  noise: Float64Array;
  cover: Float64Array;
  /** The kind of space, a `Space` value. */
  space: Uint8Array;
  /** Top walking speed in tiles per tick (Infinity inside: the walk rules decide). */
  speedCap: Float64Array;
  /** The car-frame y band a point in the cell must lie in to stand there: the ledge's width out from the wall, else unbounded. */
  yMin: Float64Array;
  yMax: Float64Array;
}

const grids = new WeakMap<object, Map<string, TrainGrid>>();

/** The grid of a train's cars, built once per config and car list. Cells off the train block both. */
export function trainGrid(config: SimConfig, cars: readonly string[], catalog: CarCatalog = carCatalog(config)): TrainGrid {
  let byCars = grids.get(config.values);
  if (!byCars) { byCars = new Map(); grids.set(config.values, byCars); }
  const key = cars.join(',');
  const hit = byCars.get(key);
  if (hit) return hit;
  const o = config.values.outside;
  const P = o.platformDepthTiles, G = o.couplingGapTiles, L = o.ledgeWidthTiles, LR = Math.ceil(L);
  const templates = cars.map((id) => carTemplate(catalog, id));
  // Columns in train order. A platform or gap that is not a whole number of tiles still takes whole
  // columns, the first (front platform) or last (rear platform, gap) of them cut short, so train
  // coordinates match the cars' spacing in the world; `colX` says where each column starts.
  const offsets: number[] = [], starts: number[] = [], colX: number[] = [];
  type Col = { k: number; part: 'front' | 'body' | 'rear' | 'gap'; x: number };
  const colOf: Col[] = [];
  let at = 0, inner = 0;
  const span = (k: number, part: Col['part'], len: number, fromEnd: boolean) => {
    const n = Math.ceil(len - 1e-9);
    for (let j = 0; j < n; j++) {
      // The front platform's short column is its first (furthest from the car); the others' their last.
      const w = fromEnd ? Math.min(1, len - j) : (j === 0 ? len - (n - 1) : 1);
      colX.push(at); colOf.push({ k, part, x: j }); at += w;
    }
  };
  templates.forEach((t, k) => {
    starts.push(at);
    offsets.push(at + P);
    span(k, 'front', P, false);
    for (let x = 0; x < t.size.cols; x++) { colX.push(at); colOf.push({ k, part: 'body', x }); at += 1; }
    span(k, 'rear', P, true);
    if (k < templates.length - 1) span(k, 'gap', G, true);
    inner = Math.max(inner, t.size.rows);
  });
  const cols = colX.length;
  colX.push(at);
  const unitCols = colX.every((x, i) => x === i);
  const rows = inner + 2 * LR;
  const n = cols * rows;
  const blocksMove = new Uint8Array(n).fill(1), blocksSight = new Uint8Array(n).fill(1), noise = new Float64Array(n).fill(1), cover = new Float64Array(n).fill(1);
  const space = new Uint8Array(n), speedCap = new Float64Array(n).fill(Infinity);
  const yMin = new Float64Array(n).fill(-Infinity), yMax = new Float64Array(n).fill(Infinity);
  const types = config.values.cellTypes;
  const air = (i: number) => { blocksSight[i] = 0; cover[i] = 0; };
  const outside = (i: number, kind: Space, walkable: boolean) => {
    air(i);
    space[i] = kind;
    blocksMove[i] = walkable ? 0 : 1;
    noise[i] = kind === Space.Ledge ? 1 : o.platformNoise;
    speedCap[i] = kind === Space.Ledge ? o.ledgeSpeedTilesPerTick : o.platformSpeedTilesPerTick;
  };
  colOf.forEach(({ k, part, x }, gc) => {
    const t = templates[k]!, c = t.size.cols, r = t.size.rows;
    for (let gr = 0; gr < rows; gr++) {
      const y = gr - LR;
      if (y >= r + LR) continue;
      const i = gr * cols + gc;
      if (part === 'body' && y >= 0 && y < r) {
        const type = types[t.cells[y * c + x]!]!;
        blocksMove[i] = type.blocksMove ? 1 : 0;
        // An open doorway in the car's outer wall lets a guard see out (`outside.seeThroughDoorways`).
        const doorway = o.seeThroughDoorways && type.opensOnInteract === true && (x === 0 || x === c - 1 || y === 0 || y === r - 1);
        blocksSight[i] = type.blocksSight && !doorway ? 1 : 0;
        noise[i] = type.noise ?? 1;
        cover[i] = type.cover;
        space[i] = Space.Inside;
      } else if (part !== 'gap') {
        // Round the car: platforms across its ends, ledges along its sides and round the corners.
        if (y >= 0 && y < r) outside(i, Space.Platform, true);
        else {
          outside(i, Space.Ledge, o.ledges && L > 0);
          if (y < 0) yMin[i] = -L; else yMax[i] = r + L;
        }
      } else {
        // The coupling gap: open air, crossed on the plate in the middle.
        air(i);
        if (y >= 0 && y < r && Math.abs(y + 0.5 - r / 2) < o.gangwayWidthTiles / 2) outside(i, Space.Coupling, true);
      }
    }
  });
  const grid: TrainGrid = { offsets, carCols: templates.map((t) => t.size.cols), carRows: templates.map((t) => t.size.rows), starts, colX: Float64Array.from(colX), unitCols, ledgeWidth: L, rowOffset: LR, cols, rows, blocksMove, blocksSight, noise, cover, space, speedCap, yMin, yMax };
  byCars.set(key, grid);
  return grid;
}

/** The cell index of a train point, or -1 off the grid. */
export function gridCell(g: TrainGrid, lx: number, y: number): number {
  const c = gridCol(g, lx), r = Math.floor(y) + g.rowOffset;
  return c < 0 || r < 0 || r >= g.rows ? -1 : r * g.cols + c;
}

/** The column holding train x `lx`, or -1 off the train. */
export function gridCol(g: TrainGrid, lx: number): number {
  if (g.unitCols) { const c = Math.floor(lx); return c < 0 || c >= g.cols ? -1 : c; }
  const x = g.colX;
  if (!(lx >= 0) || lx >= x[g.cols]!) return -1;
  let lo = 0, hi = g.cols - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (x[m]! <= lx) lo = m; else hi = m - 1; }
  return lo;
}

/** The middle of a column, in train x. */
export function colMidX(g: TrainGrid, c: number): number {
  return (g.colX[c]! + g.colX[c + 1]!) / 2;
}

/** True when the train point is on a cell that does not block movement, whatever the ledge's width. Walkers test their edges with it. */
export function gridCellOpen(g: TrainGrid, lx: number, y: number): boolean {
  const i = gridCell(g, lx, y);
  return i >= 0 && g.blocksMove[i] === 0;
}

/** True when one can stand at the train point: an open cell and, on a ledge, within its width of the wall. */
export function gridWalkable(g: TrainGrid, lx: number, y: number): boolean {
  const i = gridCell(g, lx, y);
  return i >= 0 && g.blocksMove[i] === 0 && y >= g.yMin[i]! && y < g.yMax[i]!;
}

/** The y a walker heads for in a cell: its middle, or the middle of the ledge's width in it. */
function cellMidY(g: TrainGrid, i: number): number {
  const y0 = Math.floor(i / g.cols) - g.rowOffset;
  return (Math.max(y0, g.yMin[i]!) + Math.min(y0 + 1, g.yMax[i]!)) / 2;
}

/** The space a train point is in (`Space.None` off the train). */
export function spaceAt(g: TrainGrid, lx: number, y: number): Space {
  const i = gridCell(g, lx, y);
  return (i < 0 ? Space.None : g.space[i]!) as Space;
}

/** A car-frame point in train coordinates. */
export function toTrain(g: TrainGrid, car: number, x: number): number {
  return (g.offsets[car] ?? 0) + x;
}

/** A train point back in a car's frame: the car whose stretch holds it (the first before the front, the last past the end). */
export function fromTrain(g: TrainGrid, lx: number): { car: number; x: number } {
  let car = 0;
  while (car + 1 < g.starts.length && lx >= g.starts[car + 1]!) car++;
  return { car, x: lx - g.offsets[car]! };
}

/** Which car's roof is over train x `lx` (its body, not the platforms or gap), or -1. */
export function roofCarAt(g: TrainGrid, lx: number): number {
  for (let k = 0; k < g.offsets.length; k++) if (lx >= g.offsets[k]! && lx < g.offsets[k]! + g.carCols[k]!) return k;
  return -1;
}

/** True when car-frame (x, y) lies over car `car`'s roof. */
export function onRoof(g: TrainGrid, car: number, x: number, y: number): boolean {
  return car >= 0 && car < g.carCols.length && x >= 0 && x < g.carCols[car]! && y >= 0 && y < g.carRows[car]!;
}

/**
 * A ladder (sneaking PR 3): on car `car`'s end platform at `end`, at car-frame row y. Its foot is at
 * train x `deckLx` on the platform (far enough out that a walker fits there); its top at car-frame x
 * `roofX` on the roof.
 */
export interface Ladder { car: number; end: CarEnd; y: number; deckLx: number; roofX: number }

/** How far in from the roof's end a climber steps off the ladder: a walker radius and a little. */
export const ROOF_STEP_IN = 0.4;

const ladderCache = new WeakMap<object, Map<string, Ladder[]>>();

/**
 * Every ladder of a train: one on the end platform at each of `outside.roof.ladderEnds` of the cars
 * that have ladders, at row `ladderRow` (or the car's last row on a narrower car). None with the roof
 * off or no platforms. `ladderCarShare` of the cars have ladders (at least one); which ones comes
 * from a hash of the car list, so it is fixed for a train's layout and needs no random stream.
 */
export function trainLadders(config: SimConfig, cars: readonly string[]): Ladder[] {
  let byCars = ladderCache.get(config.values);
  if (!byCars) { byCars = new Map(); ladderCache.set(config.values, byCars); }
  const key = cars.join(',');
  const hit = byCars.get(key);
  if (hit) return hit;
  const o = config.values.outside, rc = o.roof, P = o.platformDepthTiles;
  const out: Ladder[] = [];
  if (rc.enabled && P > 0) {
    const g = trainGrid(config, cars);
    // The foot stands out from the end wall far enough that a walker's body clears it.
    const out_ = Math.max(P / 2, Math.min(P - 0.01, WALKER_R + 0.05));
    const withLadders = ladderCars(key, cars.length, rc.ladderCarShare);
    for (let k = 0; k < cars.length; k++) {
      if (!withLadders.has(k)) continue;
      const y = Math.min(rc.ladderRow, g.carRows[k]! - 1) + 0.5, cols = g.carCols[k]!;
      if (rc.ladderEnds !== 'rear') out.push({ car: k, end: 'front', y, deckLx: g.offsets[k]! - out_, roofX: ROOF_STEP_IN });
      if (rc.ladderEnds !== 'front') out.push({ car: k, end: 'rear', y, deckLx: g.offsets[k]! + cols + out_, roofX: cols - ROOF_STEP_IN });
    }
  }
  byCars.set(key, out);
  return out;
}

/** The cars of a train (by index) that get ladders: `share` of `n`, at least one, picked by a hash of the car list. */
function ladderCars(key: string, n: number, share: number): Set<number> {
  const count = Math.max(1, Math.min(n, Math.round(n * share)));
  if (count >= n) return new Set(Array.from({ length: n }, (_, k) => k));
  const score = (k: number) => {
    let h = 2166136261;
    const s = `${key}#${k}`;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h;
  };
  return new Set(Array.from({ length: n }, (_, k) => k).sort((a, b) => score(a) - score(b) || a - b).slice(0, count));
}

/** A walker's radius (separate.ts WALKER_RADIUS, repeated here to keep the import one way). */
const WALKER_R = 0.3;

/** Sample spacing along a sight line, in tiles: well under a cell, so a one-cell wall is never skipped. */
const SIGHT_STEP = 0.2;

/**
 * Whether nothing that blocks sight lies between two train points. The cells the two ends stand
 * in never block, so a guard in a doorway can see out and a player in one can be seen. With
 * `coverMin` (looking at a crouched player), a cell with at least that much cover blocks too.
 */
export function lineOfSight(g: TrainGrid, ax: number, ay: number, bx: number, by: number, coverMin = Infinity): boolean {
  const dx = bx - ax, dy = by - ay;
  const d = Math.sqrt(dx * dx + dy * dy);
  const a = gridCell(g, ax, ay), b = gridCell(g, bx, by);
  const steps = Math.ceil(d / SIGHT_STEP);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const c = gridCell(g, ax + dx * t, ay + dy * t);
    if (c === a || c === b) continue;
    if (c < 0 || g.blocksSight[c] === 1 || g.cover[c]! >= coverMin) return false;
  }
  return true;
}

/**
 * How far a guard sees along the unit direction (dx, dy), up to `range`: where the first cell that
 * blocks sight starts, sampled like `lineOfSight`. The debug overlay draws cones with it.
 */
export function sightReach(g: TrainGrid, ax: number, ay: number, dx: number, dy: number, range: number): number {
  const a = gridCell(g, ax, ay);
  const steps = Math.ceil(range / SIGHT_STEP);
  for (let i = 1; i <= steps; i++) {
    const t = (i * range) / steps;
    const c = gridCell(g, ax + dx * t, ay + dy * t);
    if (c === a) continue;
    if (c < 0 || g.blocksSight[c] === 1) return ((i - 1) * range) / steps;
  }
  return range;
}

/**
 * How far a guard at (gx, gy) sees: `ai.sight.rangeTiles`, or `ledgeRangeTiles` out on a ledge,
 * where nothing is in the way along the car's side (Devlin, 2026-10-21).
 */
export function sightRange(g: TrainGrid, cfg: SimConfig['values']['ai'], gx: number, gy: number): number {
  return spaceAt(g, gx, gy) === Space.Ledge ? cfg.sight.ledgeRangeTiles : cfg.sight.rangeTiles;
}

/**
 * The sight rule: within `sightRange`, inside the cone (the precomputed `coneCos` against
 * a dot product, so no trig), and with a clear line between them. A crouched player also hides
 * behind any cell with at least `ai.sight.crouchCoverMin` cover on that line.
 */
export function canSee(g: TrainGrid, cfg: SimConfig['values']['ai'], gx: number, gy: number, fx: number, fy: number, px: number, py: number, crouched = false): boolean {
  const dx = px - gx, dy = py - gy;
  const d2 = dx * dx + dy * dy;
  const r = sightRange(g, cfg, gx, gy);
  if (d2 > r * r) return false;
  const d = Math.sqrt(d2);
  if (d > 1e-9 && fx * dx + fy * dy < cfg.sight.coneCos * d) return false;
  return lineOfSight(g, gx, gy, px, py, crouched ? cfg.sight.crouchCoverMin : Infinity);
}

/** Range and cone only: open air between them (a guard on a roof, or looking up at one). */
function seesInOpen(cfg: SimConfig['values']['ai'], range: number, gx: number, gy: number, fx: number, fy: number, px: number, py: number): boolean {
  const dx = px - gx, dy = py - gy;
  const d2 = dx * dx + dy * dy;
  if (d2 > range * range) return false;
  const d = Math.sqrt(d2);
  return d <= 1e-9 || fx * dx + fy * dy >= cfg.sight.coneCos * d;
}

/** Where a player is for a guard's eyes and ears: train point, layer, and on a roof, which car and its frame x. */
export interface SightTarget { lx: number; y: number; roof: boolean; car: number; x: number; crouched: boolean }

/**
 * The sight rule across the roof (sneaking PR 3). Both below: `canSee`. Both on roofs: range and cone,
 * nothing in the way. A guard on a roof never sees below it, and a guard inside never sees a roof.
 * A guard out on a platform, the coupling or a ledge sees a player on a roof within
 * `outside.roof.edgeSeenTiles` (crouched `crouchEdgeSeenTiles`) of the edge on that guard's side:
 * a ledge's long side, or the end a platform is beyond. Within range and cone, open air between.
 */
export function guardSees(g: TrainGrid, config: SimConfig, gx: number, gy: number, gRoof: boolean, fx: number, fy: number, t: SightTarget): boolean {
  const ai = config.values.ai;
  if (!gRoof && !t.roof) return canSee(g, ai, gx, gy, fx, fy, t.lx, t.y, t.crouched);
  if (gRoof) return t.roof && seesInOpen(ai, config.values.outside.roof.guardSightTiles, gx, gy, fx, fy, t.lx, t.y);
  const space = spaceAt(g, gx, gy);
  if (space === Space.Inside || space === Space.None) return false;
  const rc = config.values.outside.roof;
  const edge = t.crouched ? rc.crouchEdgeSeenTiles : rc.edgeSeenTiles;
  const cols = g.carCols[t.car] ?? 0, rows = g.carRows[t.car] ?? 0, off = g.offsets[t.car] ?? 0;
  const onEdge = space === Space.Ledge
    ? (gy < 0 ? t.y < edge : t.y > rows - edge)
    : (gx < off && t.x < edge) || (gx >= off + cols && t.x > cols - edge);
  return onEdge && seesInOpen(ai, sightRange(g, ai, gx, gy), gx, gy, fx, fy, t.lx, t.y);
}

/** A searching guard turns on one tick in this many (a third of its turn rate), sweeping each way for this many ticks. */
const SEARCH_TURN_EVERY = 3;
const SEARCH_SWEEP_TICKS = 60;

/** How close a guard comes to the player: two walker radii (0.3 each), so they never overlap. */
const GUARD_GAP = 0.6;

/** Move axes past this share of full are running (the client walks at half and runs at full). */
const RUN_AXIS = 0.75;

/**
 * How far the player's footsteps carry this tick (on a roof, `outside.roof.noise.*` instead, with
 * `thud` the landing of a jump and nothing while `airborne`): `ai.noise.walkRadiusTiles` walking,
 * `runRadiusTiles` running or `crouchRadiusTiles` crouched, times the `noise` of the cell they
 * stand on; 0 standing still. Searching loot (`searching`) makes `searchRadiusTiles` of noise,
 * crouched or not, or the footsteps if they carry further (Devlin, 2026-10-20). Stumbling after a
 * good landing (`stumbling`) makes `stumbleRadiusTiles` of noise, moving or not.
 */
export function noiseRadius(config: SimConfig, g: TrainGrid, p: PlayerState, lx: number, crouched = false, searching = false, stumbling = false, thud = false, airborne = false): number {
  const cfg = config.values.ai.noise;
  const search = Math.max(searching ? cfg.searchRadiusTiles : 0, stumbling ? cfg.stumbleRadiusTiles : 0);
  const mx = p.move.x / 127, my = p.move.y / 127;
  const n = airborne ? 0 : Math.sqrt(mx * mx + my * my);
  if (p.placement.layer === 'roof') {
    // On the roof (sneaking PR 3): footsteps on the car's top, and the thud of a landing.
    const rn = config.values.outside.roof.noise;
    const land = Math.max(search, thud ? rn.landRadiusTiles : 0);
    if (n === 0) return land;
    return Math.max(land, crouched ? rn.crouchRadiusTiles : n > RUN_AXIS ? rn.runRadiusTiles : rn.walkRadiusTiles);
  }
  if (n === 0) return search;
  const i = gridCell(g, lx, p.placement.y);
  // On a ledge you shuffle along at one pace, crouched or not: a fixed, short reach through the wall.
  if (i >= 0 && g.space[i] === Space.Ledge) return Math.max(search, config.values.outside.ledgeNoiseRadiusTiles);
  const r = crouched ? cfg.crouchRadiusTiles : n > RUN_AXIS ? cfg.runRadiusTiles : cfg.walkRadiusTiles;
  return Math.max(search, r * (i >= 0 ? g.noise[i]! : 1));
}

/** Whether an alert guard has given up the chase (`ai.loseSightTicks` without sight or sound of the player) and is searching. */
export function isSearching(g: GuardState, config: SimConfig): boolean {
  return g.state === 'alert' && g.lostTicks >= config.values.ai.loseSightTicks;
}

/** Place the train's guards for a run: `guardCount` of the layouts' spawns, picked from the `gen` stream. */
export function generateGuards(state: GameState, config: SimConfig, train: TrainState): GuardState[] {
  const catalog = carCatalog(config);
  const guarded = train.cars.filter((id) => carTemplate(catalog, id).guardSpawns.length > 0).length;
  const n = guardCount(config, train.type, state.persistent.wantedLevel, guarded);
  if (n <= 0) return [];
  const spawns: { car: number; spawn: ReturnType<typeof carTemplate>['guardSpawns'][number] }[] = [];
  train.cars.forEach((id, car) => { for (const spawn of carTemplate(catalog, id).guardSpawns) spawns.push({ car, spawn }); });
  // A partial shuffle picks which spawns get a guard; ids then follow train order.
  const order = spawns.map((_, i) => i);
  const take = Math.min(n, order.length);
  for (let i = 0; i < take; i++) {
    const j = i + nextInt(state.rng, GEN, order.length - i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const picked = order.slice(0, take).sort((a, b) => a - b);
  const guards = picked.map((si, id) => {
    const { car, spawn } = spawns[si]!;
    const [fx, fy] = FACING[spawn.facing] ?? FACING.left!;
    const x = spawn.cell[0] + 0.5, y = spawn.cell[1] + 0.5;
    const route = spawn.patrol ? config.values.carTemplates[train.cars[car]!]?.patrols[spawn.patrol] : undefined;
    let waypoint = 0, dir: 1 | -1 = 1;
    if (route && route.length) {
      // Start from the route cell nearest the spawn, heading the way the guard faces.
      let best = Infinity;
      route.forEach(([c, r], i) => { const d = (c + 0.5 - x) ** 2 + (r + 0.5 - y) ** 2; if (d < best) { best = d; waypoint = i; } });
      const next = route[waypoint + 1] ?? route[waypoint]!, prev = route[waypoint - 1] ?? route[waypoint]!;
      dir = (next[0] - prev[0]) * fx + (next[1] - prev[1]) * fy >= 0 ? 1 : -1;
    }
    return {
      id, car, x, y, fx, fy, state: 'unaware' as GuardAwareness,
      post: { car, x, y, fx, fy }, patrol: route && route.length ? spawn.patrol! : null,
      waypoint, dir, waitTicks: 0, sightTicks: 0, calmTicks: 0, lostTicks: 0, lastKnown: null, spotted: false, roof: false, climb: null, slip: null, slipCooldownTicks: 0, jump: null,
    };
  });
  if (config.values.playtest.edgeGuards && guards.length > 0) placeEdgeGuards(config, train, guards);
  return guards;
}

/**
 * `playtest.edgeGuards`: the first guard stands watch on its car's left ledge, two tiles in from the
 * front and looking toward the rear, and the second on that car's rear platform looking forward, so
 * being seen from outside can be tried on demand (preset `roof-edge-test`).
 */
function placeEdgeGuards(config: SimConfig, train: TrainState, guards: GuardState[]): void {
  const o = config.values.outside;
  const car = guards[0]!.car;
  const { cols, rows } = carTemplate(carCatalog(config), train.cars[car]!).size;
  const spots = [
    { x: 2, y: -o.ledgeWidthTiles / 2, fx: 1, fy: 0 },
    { x: cols + o.platformDepthTiles / 2, y: rows / 2, fx: -1, fy: 0 },
  ];
  spots.forEach((p, i) => {
    const g = guards[i];
    if (!g) return;
    Object.assign(g, { car, x: p.x, y: p.y, fx: p.fx, fy: p.fy, post: { car, ...p }, patrol: null, waypoint: 0 });
  });
}

/** Turn a unit facing toward (tx, ty) by at most one tick of `ai.turnRateDegPerSec`. */
export function turnToward(g: { fx: number; fy: number }, tx: number, ty: number, cos: number, sin: number): void {
  const n = Math.sqrt(tx * tx + ty * ty);
  if (n < 1e-9) return;
  tx /= n; ty /= n;
  if (g.fx * tx + g.fy * ty >= cos) { g.fx = tx; g.fy = ty; return; }
  const s = g.fx * ty - g.fy * tx < 0 ? -sin : sin;
  const x = g.fx * cos - g.fy * s, y = g.fx * s + g.fy * cos;
  const m = Math.sqrt(x * x + y * y);
  g.fx = x / m; g.fy = y / m;
}

// Breadth-first search buffers, grown as needed and reused every tick.
let dist = new Int32Array(0), queue = new Int32Array(0);

/**
 * Steps from every cell to `target` over cells that do not block movement (4-connected); -1
 * unreachable. `insideOnly` keeps to the inside of the cars, for guards that are not after the player.
 */
function distancesTo(g: TrainGrid, target: number, insideOnly = false): Int32Array {
  const n = g.cols * g.rows;
  if (dist.length < n) { dist = new Int32Array(n); queue = new Int32Array(n); }
  dist.fill(-1, 0, n);
  const ok = (i: number) => g.blocksMove[i] === 0 && (!insideOnly || g.space[i] === Space.Inside);
  if (target < 0 || !ok(target)) return dist;
  let head = 0, tail = 0;
  dist[target] = 0;
  queue[tail++] = target;
  while (head < tail) {
    const i = queue[head++]!, c = i % g.cols, d = dist[i]! + 1;
    if (c > 0 && dist[i - 1] === -1 && ok(i - 1)) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (c < g.cols - 1 && dist[i + 1] === -1 && ok(i + 1)) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (i >= g.cols && dist[i - g.cols] === -1 && ok(i - g.cols)) { dist[i - g.cols] = d; queue[tail++] = i - g.cols; }
    if (i + g.cols < n && dist[i + g.cols] === -1 && ok(i + g.cols)) { dist[i + g.cols] = d; queue[tail++] = i + g.cols; }
  }
  return dist;
}

/** A guard's place in train coordinates while the system moves it. */
interface Walker { lx: number; y: number; fx: number; fy: number }

/**
 * Move up to `speed` tiles toward a train point over walkable cells, facing the way it goes, no
 * faster than the cell it is on allows (the outside speeds). In the target's cell or the one next
 * to it, it goes straight there (two neighbouring cells make a rectangle, so the straight line
 * never leaves them); otherwise it heads for the centre of the neighbouring cell nearest the target
 * by a breadth-first search, kept inside the cars with `insideOnly` while the guard is inside.
 * Returns true on arrival.
 */
function walkToward(g: TrainGrid, w: Walker, tx: number, ty: number, speed: number, turn: (w: Walker, x: number, y: number) => void, insideOnly = false): boolean {
  const from = gridCell(g, w.lx, w.y), to = gridCell(g, tx, ty);
  if (from >= 0) speed = Math.min(speed, g.speedCap[from]!);
  let ax = tx, ay = ty;
  const adjacent = from === to || (to >= 0 && g.blocksMove[to] === 0
    && (Math.abs(from - to) === g.cols || (Math.abs(from - to) === 1 && Math.floor(from / g.cols) === Math.floor(to / g.cols))));
  if (!adjacent) {
    // A guard already outside finds its way back in by any route.
    const d = distancesTo(g, to, insideOnly && from >= 0 && g.space[from] === Space.Inside);
    const c = from % g.cols;
    let best = -1, bestD = d[from]! >= 0 ? d[from]! : Infinity;
    // Neighbours in a fixed order, so ties always break the same way.
    const near = [c > 0 ? from - 1 : -1, c < g.cols - 1 ? from + 1 : -1, from - g.cols, from + g.cols];
    for (const k of near) {
      if (k < 0 || k >= g.cols * g.rows) continue;
      if (d[k]! >= 0 && d[k]! < bestD) { bestD = d[k]!; best = k; }
    }
    if (best < 0) return false;
    ax = colMidX(g, best % g.cols); ay = cellMidY(g, best);
  }
  const dx = ax - w.lx, dy = ay - w.y;
  const n = Math.sqrt(dx * dx + dy * dy);
  if (n > 1e-9) turn(w, dx, dy);
  if (n <= speed) { w.lx = ax; w.y = ay; return adjacent; }
  w.lx += (dx / n) * speed; w.y += (dy / n) * speed;
  return false;
}

/** A route that starts next to where it ends is walked round as a loop; any other route back and forth. */
function isLoop(route: readonly (readonly [number, number])[]): boolean {
  if (route.length < 3) return false;
  const a = route[0]!, b = route[route.length - 1]!;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

function setState(ctx: GuardCtx, g: GuardState, to: GuardAwareness, cause: 'sight' | 'noise' | 'calm'): void {
  if (g.state === to) return;
  ctx.emit({ type: 'GuardStateChanged', tick: ctx.state.tick, guard: g.id, from: g.state, to, cause });
  g.state = to;
  g.sightTicks = 0;
  g.calmTicks = 0;
  g.lostTicks = 0;
  if (to === 'unaware') { g.spotted = false; g.lastKnown = null; }
  // Going alert raises the alarm.
  if (to === 'alert') raiseHeatFor(ctx, 'alarmRaised');
}

/**
 * Walk straight toward car-frame-of-car `car` point (train x tx, y ty) on that car's roof, kept a
 * walker radius in from its edges. Returns true on arrival.
 */
function walkRoof(g: TrainGrid, w: Walker, car: number, tx: number, ty: number, speed: number, turn: (w: Walker, x: number, y: number) => void): boolean {
  const off = g.offsets[car]!, cols = g.carCols[car]!, rows = g.carRows[car]!;
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  tx = clamp(tx, off + WALKER_R, off + cols - WALKER_R); ty = clamp(ty, WALKER_R, rows - WALKER_R);
  const dx = tx - w.lx, dy = ty - w.y;
  const n = Math.sqrt(dx * dx + dy * dy);
  if (n > 1e-9) turn(w, dx, dy);
  if (n <= speed) { w.lx = tx; w.y = ty; return true; }
  w.lx += (dx / n) * speed; w.y += (dy / n) * speed;
  return false;
}

/** The ladder of car `car` nearest train point (lx, y), at its foot (`deck`) or its top. */
function nearestLadder(g: TrainGrid, ladders: readonly Ladder[], car: number, lx: number, y: number, at: 'deck' | 'roof'): Ladder | null {
  let best: Ladder | null = null, bestD = Infinity;
  for (const l of ladders) {
    if (l.car !== car) continue;
    const x = at === 'deck' ? l.deckLx : g.offsets[car]! + l.roofX;
    const d = Math.abs(x - lx) + Math.abs(l.y - y);
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}

/** What `moveGuard` needs besides the guard. */
interface MoveCtx { ctx: GuardCtx; grid: TrainGrid; ladders: readonly Ladder[]; turn: (w: Walker, x: number, y: number) => void }

/**
 * Move a guard toward train point (tx, ty), on a roof (`roof`) or below, at `speed`. On the same
 * layer (and for a roof, the same car's roof) it walks there; otherwise it walks to a ladder and
 * starts climbing (`GuardClimbing`): up the one of the goal car nearest it, or down the one of its
 * own car nearest the goal. With `outside.roof.guardJump` a guard on a roof heads for the end facing
 * a goal on another car's roof and jumps the gap (`GuardJumped`), one car at a time; below, it climbs
 * the ladder nearest the goal car on any car when the goal car has none; and on a roof with no ladder
 * down it drops off the end nearest the goal onto the platform. Without `outside.roof.guardsClimb` a
 * guard below only turns to face a goal on a roof. Returns true on arrival.
 */
function moveGuard(m: MoveCtx, g: GuardState, w: Walker, tx: number, ty: number, roof: boolean, speed: number, insideOnly = false): boolean {
  const { grid, ladders, turn, ctx } = m;
  const rc = ctx.config.values.outside.roof;
  if (g.climb || g.jump) return false;
  if (!g.roof && !roof) return walkToward(grid, w, tx, ty, speed, turn, insideOnly);
  const jumps = rc.guardJump.enabled;
  const roofSpeed = Math.min(speed, rc.speedTilesPerTick);
  const goalCar = roof ? roofCarAt(grid, tx) : -1;
  if (g.roof && roof && goalCar === g.car) return walkRoof(grid, w, g.car, tx, ty, roofSpeed, turn);
  if (!g.roof) {
    let l = rc.guardsClimb && goalCar >= 0 ? nearestLadder(grid, ladders, goalCar, w.lx, w.y, 'deck') : null;
    if (!l && rc.guardsClimb && jumps && goalCar >= 0) l = ladderNearCar(ladders, goalCar, w.lx);
    if (!l) { turn(w, tx - w.lx, ty - w.y); return false; }
    if (walkToward(grid, w, l.deckLx, l.y, speed, turn)) startClimb(m, g, l, 'roof');
    return false;
  }
  const off = grid.offsets[g.car]!, cols = grid.carCols[g.car]!;
  if (roof && goalCar >= 0 && jumps) {
    // Toward the goal's roof: run to the end facing it and jump to the next car.
    const dir = goalCar > g.car ? 1 : -1;
    const edge = dir > 0 ? off + cols : off;
    if (walkRoof(grid, w, g.car, edge - dir * WALKER_R, w.y, roofSpeed, turn)) startJump(m, g, w, g.car + dir, edge, dir);
    return false;
  }
  const l = nearestLadder(grid, ladders, g.car, tx, ty, 'roof');
  if (!l) {
    // No ladder down on this car (it jumped here): drop off the end nearest the goal onto the platform.
    if (!jumps) return false;
    const dir = tx >= off + cols / 2 ? 1 : -1;
    const edge = dir > 0 ? off + cols : off;
    if (walkRoof(grid, w, g.car, edge - dir * WALKER_R, w.y, roofSpeed, turn)) {
      w.lx = edge + dir * ctx.config.values.outside.platformDepthTiles / 2;
      g.roof = false;
    }
    return false;
  }
  if (walkRoof(grid, w, g.car, off + l.roofX, l.y, roofSpeed, turn)) startClimb(m, g, l, 'deck');
  return false;
}

/** The ladder (at its foot) on the car nearest car `car`, then nearest train x `lx`, for a guard heading to a roof with no ladder. */
function ladderNearCar(ladders: readonly Ladder[], car: number, lx: number): Ladder | null {
  let best: Ladder | null = null, bestCars = Infinity, bestD = Infinity;
  for (const l of ladders) {
    const c = Math.abs(l.car - car), d = Math.abs(l.deckLx - lx);
    if (c < bestCars || (c === bestCars && d < bestD)) { best = l; bestCars = c; bestD = d; }
  }
  return best;
}

/**
 * A guard at roof end `edge` (train x) jumps toward car `toCar`, over `outside.roof.jump.airSec`:
 * onto that car's roof, or with chance `guardJump.shortShare` (the `ai` stream) short onto the
 * platform below the end it jumped from.
 */
function startJump(m: MoveCtx, g: GuardState, w: Walker, toCar: number, edge: number, dir: 1 | -1): void {
  const { ctx, grid } = m;
  const rc = ctx.config.values.outside.roof;
  if (toCar < 0 || toCar >= grid.carCols.length) return;
  const short = rc.guardJump.shortShare > 0 && nextInt(ctx.state.rng, 'ai', 1000) < rc.guardJump.shortShare * 1000;
  const toOff = grid.offsets[toCar]!, toCols = grid.carCols[toCar]!;
  const toLx = short ? edge + dir * ctx.config.values.outside.platformDepthTiles / 2 : dir > 0 ? toOff + 2 * WALKER_R : toOff + toCols - 2 * WALKER_R;
  const total = Math.max(1, rc.jump.airTicks);
  g.jump = { ticks: total, total, fromLx: w.lx, toLx, toRoof: !short, toCar };
  ctx.emit({ type: 'GuardJumped', tick: ctx.state.tick, guard: g.id, car: g.car, toCar, short });
}

function startClimb(m: MoveCtx, g: GuardState, l: Ladder, to: 'roof' | 'deck'): void {
  g.climb = { ticks: Math.max(1, m.ctx.config.values.outside.roof.climbTicks), car: l.car, end: l.end };
  m.ctx.emit({ type: 'GuardClimbing', tick: m.ctx.state.tick, guard: g.id, car: l.car, to });
}

/**
 * Tick system 6 and 7, perception and AI, after walking aboard. For each guard in id order: what
 * it sees and hears of the player (only aboard the run's train), how its awareness changes, then
 * where it walks and faces. Returns the first alert guard in reach of the player under guardCatch
 * `thrown-off` (the run system throws the player off), or null.
 *
 * Roofs (sneaking PR 3): a guard and the player are each on a roof or below. Sight across the two
 * follows `guardSees`. Footsteps on a roof reach a guard below only in the car under the player (its
 * stretch: inside, its platforms and ledges). A guard after the player goes up and down the ladders
 * (`moveGuard`), and catches only on the same layer.
 */
/**
 * A fall off a roof (sneaking PR 3, Devlin's PR #36 playtest): the guards in the car the player fell
 * from and `outside.roof.fallAlert.cars` cars either side hear it. Each one not already alert turns
 * suspicious and walks out to the ledge on the side the player went over, and keeps looking for at
 * least `fallAlert.checkSec` before it can calm down.
 */
export function alertGuardsToFall(ctx: GuardCtx, p: PlayerState): void {
  const { state, config } = ctx;
  const fa = config.values.outside.roof.fallAlert;
  const run = state.run;
  const f = parseCarFrame(p.placement.frame);
  if (!fa.enabled || !run || !f) return;
  const train = state.world.trains.find((t) => t.id === f.trainId);
  if (!train) return;
  const grid = trainGrid(config, train.cars);
  const at = fromTrain(grid, toTrain(grid, f.car, p.placement.x));
  const rows = grid.carRows[at.car] ?? 1;
  // Just outside the car body on the side they went over: the ledge there.
  const y = p.placement.y < rows / 2 ? -0.05 : rows + 0.05;
  for (const g of run.guards) {
    if (g.state === 'alert' || Math.abs(g.car - at.car) > fa.cars) continue;
    if (g.state === 'unaware') setState(ctx, g, 'suspicious', 'noise');
    g.lastKnown = { car: at.car, x: at.x, y, roof: false };
    g.calmTicks = -fa.checkTicks;
  }
}

export function guardSystem(ctx: GuardCtx): { guard: GuardState; player: PlayerState } | null {
  const { state, config } = ctx;
  const run = state.run;
  if (!run || run.guards.length === 0) return null;
  const ai = config.values.ai;
  const train = state.world.trains.find((t) => t.id === run.trainId);
  if (!train) return null;
  const grid = trainGrid(config, train.cars);
  const ladders = trainLadders(config, train.cars);
  const turn = (w: { fx: number; fy: number }, x: number, y: number) => turnToward(w, x, y, ai.turnRateCosPerTick, ai.turnRateSinPerTick);
  const m: MoveCtx = { ctx, grid, ladders, turn };
  // The one player in phase 2, when aboard this train.
  let target: (SightTarget & { p: PlayerState; noise: number; air: boolean }) | null = null;
  if (run.phase === 'aboard' || run.phase === 'extracting') {
    for (const p of state.players) {
      const f = parseCarFrame(p.placement.frame);
      if (!f || f.trainId !== train.id || !run.players[p.id]) continue;
      const lx = toTrain(grid, f.car, p.placement.x);
      const rp = run.players[p.id]!;
      target = {
        p, lx, y: p.placement.y, roof: p.placement.layer === 'roof', car: f.car, x: p.placement.x, crouched: rp.crouched, air: rp.air !== null,
        noise: noiseRadius(config, grid, p, lx, rp.crouched, rp.search !== null, rp.stumbleTicks > 0, rp.thudTicks > 0, rp.air !== null),
      };
      break;
    }
  }
  let caught: { guard: GuardState; player: PlayerState } | null = null;
  for (const g of run.guards) {
    const w: Walker = { lx: toTrain(grid, g.car, g.x), y: g.y, fx: g.fx, fy: g.fy };
    // Perception.
    let sees = false, hears = false;
    if (target) {
      sees = guardSees(grid, config, w.lx, w.y, g.roof, w.fx, w.fy, target);
      if (!sees && target.noise > 0) {
        const dx = target.lx - w.lx, dy = target.y - w.y;
        // Footsteps on a roof only carry down into the car under them.
        hears = dx * dx + dy * dy <= target.noise * target.noise && (!target.roof || g.roof || fromTrain(grid, w.lx).car === target.car);
      }
      if (sees || hears) {
        const at = fromTrain(grid, target.lx);
        g.lastKnown = { car: at.car, x: at.x, y: target.y, roof: target.roof };
      }
    }
    // Awareness: unaware, suspicious (spotted or heard), alert after `alertAfterTicks` of sight.
    if (sees && !g.spotted && target) {
      g.spotted = true;
      ctx.emit({ type: 'PlayerSpotted', tick: state.tick, player: target.p.id, guard: g.id, car: g.car });
      raiseHeatFor(ctx, 'playerSpotted');
    }
    if (g.state === 'unaware') {
      if (sees) setState(ctx, g, 'suspicious', 'sight');
      else if (hears) setState(ctx, g, 'suspicious', 'noise');
    } else if (g.state === 'suspicious') {
      if (sees) {
        g.calmTicks = 0;
        if (++g.sightTicks >= ai.alertAfterTicks) setState(ctx, g, 'alert', 'sight');
      } else {
        if (g.sightTicks > 0) g.sightTicks -= 1;
        // On its way up to check the roof, it does not calm down until it is up there.
        const goingUp = !g.roof && g.lastKnown?.roof === true && config.values.outside.roof.enabled && config.values.outside.roof.guardsClimb;
        if (hears || goingUp) g.calmTicks = 0;
        else if (++g.calmTicks >= ai.calmTicks) setState(ctx, g, 'unaware', 'calm');
      }
    } else if (sees || hears) { g.calmTicks = 0; g.lostTicks = 0; }
    else {
      // Alert with no sign of the player: after `loseSightTicks` a chasing guard gives up and searches.
      if (++g.lostTicks === ai.loseSightTicks && ai.guardCatch === 'thrown-off') ctx.emit({ type: 'GuardLostTrack', tick: state.tick, guard: g.id });
      if (++g.calmTicks >= ai.alertCalmTicks) setState(ctx, g, 'suspicious', 'calm');
    }
    const searching = isSearching(g, config);

    // Action. A guard never walks into the player: a step that ends closer than two walker radii is undone.
    const fromX = w.lx, fromY = w.y;
    const known = g.lastKnown ? { lx: toTrain(grid, g.lastKnown.car, g.lastKnown.x), y: g.lastKnown.y, roof: g.lastKnown.roof } : null;
    if (g.jump) {
      // In the air over the gap: then on the next roof, or short on the platform.
      const j = g.jump;
      j.ticks -= 1;
      w.lx = j.fromLx + (j.toLx - j.fromLx) * (1 - j.ticks / j.total);
      if (j.ticks <= 0) { w.lx = j.toLx; g.roof = j.toRoof; g.jump = null; }
    } else if (g.climb) {
      // On a ladder: up or down it, then step off at the other end.
      if (--g.climb.ticks <= 0) {
        const l = ladders.find((q) => q.car === g.climb!.car && q.end === g.climb!.end);
        g.roof = !g.roof;
        if (l) { w.lx = g.roof ? grid.offsets[l.car]! + l.roofX : l.deckLx; w.y = l.y; }
        g.climb = null;
      }
      if (sees && target) turn(w, target.lx - w.lx, target.y - w.y);
    } else if (searching && ai.guardCatch === 'thrown-off' && known) {
      // Lost them: walk to where they were last seen or heard, then look one way and the other.
      if (moveGuard(m, g, w, known.lx, known.y, known.roof, ai.patrolSpeedTilesPerTick) && g.lostTicks % SEARCH_TURN_EVERY === 0) {
        const left = Math.floor(g.lostTicks / SEARCH_SWEEP_TICKS) % 2 === 0;
        turn(w, left ? w.fy : -w.fy, left ? -w.fx : w.fx);
      }
    } else if (g.state === 'alert' && ai.guardCatch === 'thrown-off' && known) {
      // Chase: to the player while in sight, else to where they were last seen or heard.
      if (sees && target) moveGuard(m, g, w, target.lx, target.y, target.roof, ai.chaseSpeedTilesPerTick);
      else moveGuard(m, g, w, known.lx, known.y, known.roof, ai.chaseSpeedTilesPerTick);
      if (sees && target) turn(w, target.lx - w.lx, target.y - w.y);
    } else if (g.state === 'suspicious' && known && (known.roof ? config.values.outside.roof.guardsClimb : spaceAt(grid, known.lx, known.y) === Space.Inside ? ai.suspiciousApproach : ai.suspiciousStepOutside)) {
      // Saw or heard something: walk over to look, out by a door if it was outside, say through a
      // window (Devlin, 2026-10-21), or up the ladder to check the roof, facing it while it is still in view.
      if (moveGuard(m, g, w, known.lx, known.y, known.roof, ai.patrolSpeedTilesPerTick) || sees) turn(w, known.lx - w.lx, known.y - w.y);
    } else if (g.state !== 'unaware' && known) {
      // Stand and look toward the player, or where they were.
      turn(w, known.lx - w.lx, known.y - w.y);
    } else if (g.state === 'unaware' && g.roof) {
      // Calm again up on a roof: back down the nearest ladder toward its post.
      moveGuard(m, g, w, toTrain(grid, g.post.car, g.post.x), g.post.y, false, ai.patrolSpeedTilesPerTick);
    } else if (g.state === 'unaware') {
      patrol(grid, g, w, ai, config, train, turn);
    }
    if (target && target.roof === g.roof) {
      const dx = target.lx - w.lx, dy = target.y - w.y, ox = target.lx - fromX, oy = target.y - fromY;
      const d2 = dx * dx + dy * dy;
      if (d2 < GUARD_GAP * GUARD_GAP && d2 < ox * ox + oy * oy) { w.lx = fromX; w.y = fromY; }
    }
    if (g.roof) slipGuard(ctx, grid, train, g, w, fromX, fromY);
    // A guard on a roof stays in that car's frame; one below takes the car whose stretch it is in.
    const at = g.roof ? { car: roofCarAt(grid, w.lx) >= 0 ? roofCarAt(grid, w.lx) : g.car, x: 0 } : fromTrain(grid, w.lx);
    if (g.roof) at.x = w.lx - grid.offsets[at.car]!;
    g.car = at.car; g.x = at.x; g.y = w.y; g.fx = w.fx; g.fy = w.fy;
    if (!caught && target && g.state === 'alert' && !searching && ai.guardCatch === 'thrown-off' && !g.climb && !g.slip && !g.jump && g.roof === target.roof && !target.air) {
      const dx = target.lx - w.lx, dy = target.y - w.y;
      if (dx * dx + dy * dy <= ai.catchRangeTiles * ai.catchRangeTiles) caught = { guard: g, player: target.p };
    }
  }
  return caught;
}

/**
 * A guard up on a roof slips on a curve as the player does (Devlin, PR #36 playtest), when the pull
 * times its pace as a share of the top roof speed reaches `outside.roof.slip.thresholdTilesPerSec2`:
 * it slides toward the outside for `slip.guardCatchSec` instead of moving, then has caught itself
 * (it never falls off), and cannot catch the player meanwhile. Then no slip for `slip.cooldownSec`.
 */
function slipGuard(ctx: GuardCtx, grid: TrainGrid, train: TrainState, g: GuardState, w: Walker, fromX: number, fromY: number): void {
  const rc = ctx.config.values.outside.roof, sl = rc.slip;
  if (!ctx.map || !sl.enabled || !sl.guards) { g.slip = null; return; }
  if (g.slipCooldownTicks > 0) g.slipCooldownTicks -= 1;
  if (g.slip) {
    const rows = grid.carRows[g.car] ?? 1, r = GUARD_GAP / 2;
    w.lx = fromX;
    w.y = Math.max(r, Math.min(rows - r, fromY + g.slip.dir * sl.slideTilesPerTick));
    if (--g.slip.ticks <= 0) { g.slip = null; g.slipCooldownTicks = sl.cooldownTicks; }
    return;
  }
  if (g.slipCooldownTicks > 0 || g.climb || g.jump || !g.roof || !(rc.speedTilesPerTick > 0)) return;
  const dx = w.lx - fromX, dy = w.y - fromY;
  const share = Math.sqrt(dx * dx + dy * dy) / rc.speedTilesPerTick;
  if (share <= 0) return;
  const pull = curvePull(ctx.state, ctx.map, ctx.config, train.id, g.car);
  if (Math.abs(pull) * share < sl.thresholdTilesPerSec2) return;
  const dir: 1 | -1 = pull > 0 ? 1 : -1;
  g.slip = { dir, ticks: sl.guardCatchTicks };
  ctx.emit({ type: 'GuardSlipped', tick: ctx.state.tick, guard: g.id, car: g.car, dir });
}

/** An unaware guard walks its route (pausing at the ends of one that is not a loop), or goes back to its post and keeps watch. */
function patrol(grid: TrainGrid, g: GuardState, w: Walker, ai: SimConfig['values']['ai'], config: SimConfig, train: TrainState, turn: (w: Walker, x: number, y: number) => void): void {
  const route = g.patrol ? config.values.carTemplates[train.cars[g.post.car]!]?.patrols[g.patrol] : undefined;
  const off = grid.offsets[g.post.car] ?? 0;
  // A patrol stays inside its car, but a guard left in another car (after a chase) goes back by any
  // route: through the doors, over the platforms (Devlin, PR #36 playtest: guards forgot their routes).
  const inside = fromTrain(grid, w.lx).car === g.post.car;
  if (!route || route.length === 0) {
    const px = off + g.post.x;
    if (Math.abs(w.lx - px) > 1e-6 || Math.abs(w.y - g.post.y) > 1e-6) walkToward(grid, w, px, g.post.y, ai.patrolSpeedTilesPerTick, turn, inside);
    else turn(w, g.post.fx, g.post.fy);
    return;
  }
  const cell = (i: number) => route[i]!;
  if (g.waitTicks > 0) {
    // Pausing at a route end: turn to face the way back.
    g.waitTicks -= 1;
    const [c, r] = cell(g.waypoint);
    turn(w, off + c + 0.5 - w.lx, r + 0.5 - w.y);
    return;
  }
  const [c, r] = cell(g.waypoint);
  if (!walkToward(grid, w, off + c + 0.5, r + 0.5, ai.patrolSpeedTilesPerTick, turn, inside)) return;
  if (route.length === 1) return;
  let next = g.waypoint + g.dir;
  if (isLoop(route)) next = (next + route.length) % route.length;
  else if (next < 0 || next >= route.length) {
    g.dir = g.dir === 1 ? -1 : 1;
    next = g.waypoint + g.dir;
    g.waitTicks = ai.patrolPauseTicks;
  }
  g.waypoint = next;
}
