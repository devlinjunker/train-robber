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
import type { GameState, GuardAwareness, GuardState, PlayerState, SimConfig, SimEvent, TrainState } from '../types';
import { carCatalog, carTemplate, type CarCatalog } from './cars';
import { parseCarFrame } from './frames';
import { raiseHeatFor } from '../rules/heat';

const GEN: StreamName = 'gen';

/** What the guard system needs from the tick; `RunCtx` satisfies it. */
export interface GuardCtx {
  state: GameState;
  config: SimConfig;
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

/** What a train grid cell is: off the train, inside a car, or one of the outside spaces (sneaking PR 2). */
export const Space = { None: 0, Inside: 1, Platform: 2, Ledge: 3, Coupling: 4 } as const;
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
  /** Grid column where each car's own stretch starts: its front platform. The gap behind a car belongs to it. */
  starts: readonly number[];
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
  const offsets: number[] = [], starts: number[] = [];
  let cols = 0, inner = 0;
  templates.forEach((t, k) => {
    starts.push(cols);
    offsets.push(cols + P);
    cols += P + t.size.cols + P + (k < templates.length - 1 ? G : 0);
    inner = Math.max(inner, t.size.rows);
  });
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
    noise[i] = kind === Space.Ledge ? o.ledgeNoise : o.platformNoise;
    speedCap[i] = kind === Space.Ledge ? o.ledgeSpeedTilesPerTick : o.platformSpeedTilesPerTick;
  };
  templates.forEach((t, k) => {
    const c = t.size.cols, r = t.size.rows, off = offsets[k]!;
    const end = k < templates.length - 1 ? starts[k + 1]! : cols;
    for (let gr = 0; gr < rows; gr++) {
      const y = gr - LR;
      if (y >= r + LR) continue;
      for (let gc = starts[k]!; gc < end; gc++) {
        const x = gc - off, i = gr * cols + gc;
        if (x >= 0 && x < c && y >= 0 && y < r) {
          const type = types[t.cells[y * c + x]!]!;
          blocksMove[i] = type.blocksMove ? 1 : 0;
          // An open doorway in the car's outer wall lets a guard see out (`outside.seeThroughDoorways`).
          const doorway = o.seeThroughDoorways && type.opensOnInteract === true && (x === 0 || x === c - 1 || y === 0 || y === r - 1);
          blocksSight[i] = type.blocksSight && !doorway ? 1 : 0;
          noise[i] = type.noise ?? 1;
          cover[i] = type.cover;
          space[i] = Space.Inside;
        } else if (x < c + P) {
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
    }
  });
  const grid: TrainGrid = { offsets, starts, rowOffset: LR, cols, rows, blocksMove, blocksSight, noise, cover, space, speedCap, yMin, yMax };
  byCars.set(key, grid);
  return grid;
}

/** The cell index of a train point, or -1 off the grid. */
export function gridCell(g: TrainGrid, lx: number, y: number): number {
  const c = Math.floor(lx), r = Math.floor(y) + g.rowOffset;
  return c < 0 || r < 0 || c >= g.cols || r >= g.rows ? -1 : r * g.cols + c;
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
 * The sight rule: within `ai.sight.rangeTiles`, inside the cone (the precomputed `coneCos` against
 * a dot product, so no trig), and with a clear line between them. A crouched player also hides
 * behind any cell with at least `ai.sight.crouchCoverMin` cover on that line.
 */
export function canSee(g: TrainGrid, cfg: SimConfig['values']['ai'], gx: number, gy: number, fx: number, fy: number, px: number, py: number, crouched = false): boolean {
  const dx = px - gx, dy = py - gy;
  const d2 = dx * dx + dy * dy;
  const r = cfg.sight.rangeTiles;
  if (d2 > r * r) return false;
  const d = Math.sqrt(d2);
  if (d > 1e-9 && fx * dx + fy * dy < cfg.sight.coneCos * d) return false;
  return lineOfSight(g, gx, gy, px, py, crouched ? cfg.sight.crouchCoverMin : Infinity);
}

/** A searching guard turns on one tick in this many (a third of its turn rate), sweeping each way for this many ticks. */
const SEARCH_TURN_EVERY = 3;
const SEARCH_SWEEP_TICKS = 60;

/** How close a guard comes to the player: two walker radii (0.3 each), so they never overlap. */
const GUARD_GAP = 0.6;

/** Move axes past this share of full are running (the client walks at half and runs at full). */
const RUN_AXIS = 0.75;

/**
 * How far the player's footsteps carry this tick: `ai.noise.walkRadiusTiles` walking,
 * `runRadiusTiles` running or `crouchRadiusTiles` crouched, times the `noise` of the cell they
 * stand on; 0 standing still. Searching loot (`searching`) makes `searchRadiusTiles` of noise,
 * crouched or not, or the footsteps if they carry further (Devlin, 2026-10-20). Stumbling after a
 * good landing (`stumbling`) makes `stumbleRadiusTiles` of noise, moving or not.
 */
export function noiseRadius(config: SimConfig, g: TrainGrid, p: PlayerState, lx: number, crouched = false, searching = false, stumbling = false): number {
  const cfg = config.values.ai.noise;
  const search = Math.max(searching ? cfg.searchRadiusTiles : 0, stumbling ? cfg.stumbleRadiusTiles : 0);
  const mx = p.move.x / 127, my = p.move.y / 127;
  const n = Math.sqrt(mx * mx + my * my);
  if (n === 0) return search;
  const i = gridCell(g, lx, p.placement.y);
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
  return picked.map((si, id) => {
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
      waypoint, dir, waitTicks: 0, sightTicks: 0, calmTicks: 0, lostTicks: 0, lastKnown: null, spotted: false,
    };
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
    ax = (best % g.cols) + 0.5; ay = cellMidY(g, best);
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
 * Tick system 6 and 7, perception and AI, after walking aboard. For each guard in id order: what
 * it sees and hears of the player (only aboard the run's train), how its awareness changes, then
 * where it walks and faces. Returns the first alert guard in reach of the player under guardCatch
 * `thrown-off` (the run system throws the player off), or null.
 */
export function guardSystem(ctx: GuardCtx): { guard: GuardState; player: PlayerState } | null {
  const { state, config } = ctx;
  const run = state.run;
  if (!run || run.guards.length === 0) return null;
  const ai = config.values.ai;
  const train = state.world.trains.find((t) => t.id === run.trainId);
  if (!train) return null;
  const grid = trainGrid(config, train.cars);
  const turn = (w: { fx: number; fy: number }, x: number, y: number) => turnToward(w, x, y, ai.turnRateCosPerTick, ai.turnRateSinPerTick);
  // The one player in phase 2, when aboard this train.
  let target: { p: PlayerState; lx: number; y: number; noise: number; crouched: boolean } | null = null;
  if (run.phase === 'aboard' || run.phase === 'extracting') {
    for (const p of state.players) {
      const f = parseCarFrame(p.placement.frame);
      if (!f || f.trainId !== train.id || !run.players[p.id]) continue;
      const lx = toTrain(grid, f.car, p.placement.x);
      const rp = run.players[p.id]!;
      target = { p, lx, y: p.placement.y, noise: noiseRadius(config, grid, p, lx, rp.crouched, rp.search !== null, rp.stumbleTicks > 0), crouched: rp.crouched };
      break;
    }
  }
  let caught: { guard: GuardState; player: PlayerState } | null = null;
  for (const g of run.guards) {
    const w: Walker = { lx: toTrain(grid, g.car, g.x), y: g.y, fx: g.fx, fy: g.fy };
    // Perception.
    let sees = false, hears = false;
    if (target) {
      sees = canSee(grid, ai, w.lx, w.y, w.fx, w.fy, target.lx, target.y, target.crouched);
      if (!sees && target.noise > 0) {
        const dx = target.lx - w.lx, dy = target.y - w.y;
        hears = dx * dx + dy * dy <= target.noise * target.noise;
      }
      if (sees || hears) {
        const at = fromTrain(grid, target.lx);
        g.lastKnown = { car: at.car, x: at.x, y: target.y };
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
        if (hears) g.calmTicks = 0;
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
    const known = g.lastKnown ? { lx: toTrain(grid, g.lastKnown.car, g.lastKnown.x), y: g.lastKnown.y } : null;
    if (searching && ai.guardCatch === 'thrown-off' && known) {
      // Lost them: walk to where they were last seen or heard, then look one way and the other.
      if (walkToward(grid, w, known.lx, known.y, ai.patrolSpeedTilesPerTick, turn) && g.lostTicks % SEARCH_TURN_EVERY === 0) {
        const left = Math.floor(g.lostTicks / SEARCH_SWEEP_TICKS) % 2 === 0;
        turn(w, left ? w.fy : -w.fy, left ? -w.fx : w.fx);
      }
    } else if (g.state === 'alert' && ai.guardCatch === 'thrown-off' && known) {
      // Chase: to the player while in sight, else to where they were last seen or heard.
      if (sees && target) walkToward(grid, w, target.lx, target.y, ai.chaseSpeedTilesPerTick, turn);
      else walkToward(grid, w, known.lx, known.y, ai.chaseSpeedTilesPerTick, turn);
      if (sees && target) turn(w, target.lx - w.lx, target.y - w.y);
    } else if (g.state !== 'unaware' && known) {
      // Stand and look toward the player, or where they were.
      turn(w, known.lx - w.lx, known.y - w.y);
    } else if (g.state === 'unaware') {
      patrol(grid, g, w, ai, config, train, turn);
    }
    if (target) {
      const dx = target.lx - w.lx, dy = target.y - w.y, ox = target.lx - fromX, oy = target.y - fromY;
      const d2 = dx * dx + dy * dy;
      if (d2 < GUARD_GAP * GUARD_GAP && d2 < ox * ox + oy * oy) { w.lx = fromX; w.y = fromY; }
    }
    const at = fromTrain(grid, w.lx);
    g.car = at.car; g.x = at.x; g.y = w.y; g.fx = w.fx; g.fy = w.fy;
    if (!caught && target && g.state === 'alert' && !searching && ai.guardCatch === 'thrown-off') {
      const dx = target.lx - w.lx, dy = target.y - w.y;
      if (dx * dx + dy * dy <= ai.catchRangeTiles * ai.catchRangeTiles) caught = { guard: g, player: target.p };
    }
  }
  return caught;
}

/** An unaware guard walks its route (pausing at the ends of one that is not a loop), or goes back to its post and keeps watch. */
function patrol(grid: TrainGrid, g: GuardState, w: Walker, ai: SimConfig['values']['ai'], config: SimConfig, train: TrainState, turn: (w: Walker, x: number, y: number) => void): void {
  const route = g.patrol ? config.values.carTemplates[train.cars[g.post.car]!]?.patrols[g.patrol] : undefined;
  const off = grid.offsets[g.post.car] ?? 0;
  if (!route || route.length === 0) {
    const px = off + g.post.x;
    if (Math.abs(w.lx - px) > 1e-6 || Math.abs(w.y - g.post.y) > 1e-6) walkToward(grid, w, px, g.post.y, ai.patrolSpeedTilesPerTick, turn, true);
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
  if (!walkToward(grid, w, off + c + 0.5, r + 0.5, ai.patrolSpeedTilesPerTick, turn, true)) return;
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
