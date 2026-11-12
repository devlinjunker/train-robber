// The isometric world: terrain and track, boulders and cars drawn with height that depth-sort
// against the horse (cars in two-tile slices, boulders in strips), the mud cue, entry markers and
// the debug overlays.
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { carEntryPoints, carTemplate, HORSE_RADIUS, WALKER_RADIUS, type BoardingCheck, type BoardingState, type CarCatalog, type CarPose, type CellTypeDef, type SimConfig } from '@train-robber/sim';
import type { MapDef, SceneryDef } from '@train-robber/config';
import { boxCorners, drawBox, groundEllipse, isoPoly, mix, shade, sidePanel, type Box } from './draw';
import { drawIsoMapOverlay, drawTerrain } from './terrain';
import { carHides, sliceSpans } from './occlusion';
import { createMesas } from './mesa';
import { createSceneryLayers } from './scenery';
import { mapTiles, type MapTiles } from '../tiles';
import { createGroundCover } from './groundCover';
import { createRocks } from './rocks';
import { DepthBands, freshlyBuilt, regionSize, type Chunk, type TileBox } from './cells';
import { Overdraw, type Mover } from './overdraw';
import { createHeightField, createHeightLayer } from './height';
import { createMud } from './mud';
import { createDust } from './dust';
import { drawTowns } from './towns';
import { depthOf, isoX, isoY, TILE_H, TILE_W } from '../projection';
import type { ActorPose } from '../interp';
import { COMMITTED_COLOUR, flashOn, GOOD_COLOUR, HIT_COLOUR, PERFECT_COLOUR, SWITCH_CANDIDATE_COLOUR, SWITCH_FLASH_SEC, type TrainFocus } from '../cues';
import { drawInterior, type InteriorLoot } from './interior';
import { drawCarOutside, drawLadder, type OutsideDims } from './outside';
import { GUARD_STATE_COLOURS, type ConeView, type GuardView } from '../guards';
import { obstacleNear, type ObstacleKind, type ObstacleTiles } from '../obstacle';

const PERFECT_RING_SEC = 0.8;

/**
 * Body colour by car type. A blank car is a slightly duller, greyer brown than a mail car: close
 * enough that a decoy train is a guess from a distance, different enough to read up close (G17,
 * Devlin's M2 playtest).
 */
/** A positive number from the page URL, or `fallback` (also outside a browser, as in tests). */
function urlNumber(name: string, fallback: number, min: number): number {
  const raw = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v >= min ? v : fallback;
}
/**
 * `?farDetail=off` hides grass, scrub, bushes and flowers at zoom 0.35 and below (the farthest Q
 * step, and the wheel past it); `?farDetail=<zoom>` hides them at that zoom and below. Shown at
 * every zoom by default (Devlin's PR #42 playtest: a setting to try).
 */
const urlFlag = (name: string) => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name));
const FAR_DETAIL_ZOOM = (() => {
  const raw = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('farDetail');
  if (raw === 'off') return 0.35;
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();
export const CAR_COLOURS: Record<string, number> = { engine: 0x4a4a58, caboose: 0xa83a2a, 'mail-car': 0x9a5534, 'blank-car': 0x86604a, 'small-mail-car': 0x9a5534, 'small-blank-car': 0x86604a };
const DOOR_COLOUR = 0xe8c872;
/** A shut door (a cash-out closed the train's doors): dark planks the body's colour, barred across. */
const SHUT_DOOR_SHADE = 0.62, DOOR_BAR_COLOUR = 0x2a1d12;
/** Slice length along a car, in tiles; each slice sorts on its own. */
export const SLICE_TILES = 2;
/** Car height in tiles, visual only: about 5 (Devlin, 2026-10-20), `?carHeight=` to try others. */
export const CAR_HEIGHT = urlNumber('carHeight', 5, 1);
/** Side doors stay person-sized however tall the car is. */
const DOOR_TOP = Math.min(CAR_HEIGHT - 0.4, 2.6);
const PLAYER_COLOUR = 0x6bd3ff;
const GUARD_COLOUR = 0x2c3e66, GUARD_HAT_COLOUR = 0x1a1a22;
const HORSE_COLOUR = 0x8a5a32, RIDER_COLOUR = 0x6bd3ff, MUDDY_LEGS = 0x3d2a18;
/**
 * When a car hides the horse and rider (or you aboard), a round hole is cut through the cars in
 * front of them, so they and the ground around them show through (Devlin, 2026-10-10). Radius in
 * tiles.
 */
/**
 * Culling views grow by CULL_MARGIN tiles and snap out to CULL_SNAP: each cull makes Pixi repack
 * the static layers, so it should happen every few seconds of riding, not every frame.
 */
const CULL_SNAP = 12, CULL_MARGIN = 6;
/**
 * The land's depth bands (cells.ts DepthBands): each LAND_BAND_DEPTH of sort depth, and how many
 * take their pieces' comings and goings each frame while the view slides. Thinner bands repack
 * faster (riding fast at 0.25x, worst repack 67 ms with 48 and one at a time, 27 ms with 16 and two).
 */
const LAND_BAND_DEPTH = 16, LAND_BANDS_PER_FRAME = 2;
const overlapsBox = (a: TileBox, b: TileBox) => a.x1 >= b.x0 && a.x0 <= b.x1 && a.y1 >= b.y0 && a.y0 <= b.y1;
/** On big maps, how long a frame may spend building regions that are near the view but not on it yet. */
const BUILD_MS_PER_FRAME = 4;
/** Milliseconds a frame may spend triangulating freshly built pieces ahead of drawing them. */
const WARM_MS_PER_FRAME = 2;
const HIDDEN_HEIGHTS = [0.6, 1.6], CUTOUT_RADIUS = 2.55;
/**
 * Seeing the gap to the train (Devlin, 2026-10-12, in place of a line and a number): within
 * GAP_HOLE_TILES on the far side, the hole stretches from the horse to the car side so the ground
 * between them shows, narrowing to GAP_HOLE_END_RADIUS tiles at the car. Within GAP_GLOW_TILES on
 * either side, the bottom edge of the car nearest the horse glows, longer and brighter as it closes,
 * and turns red within GAP_DANGER_TILES (Devlin, PR #20 playtest).
 */
export const GAP_HOLE_TILES = 8, GAP_GLOW_TILES = 6, GAP_DANGER_TILES = 1;
const GAP_HOLE_END_RADIUS = 1.4, GAP_GLOW_COLOUR = 0xffe9a8, GAP_DANGER_COLOUR = 0xff4a3a;

const MARKER_COLOURS: Record<BoardingState, number> = { 'too far': 0xc8c8c8, 'too slow': 0xff9f43, 'too fast': 0xff9f43, eligible: 0x6bff8a };

export interface WorldSceneInput {
  cars: readonly CarPose[];
  /** The horse, unless it is abstract (its rider is aboard). */
  horse: ActorPose | null;
  /** The horse has no rider: its player is aboard and it runs off or comes when whistled. */
  riderless?: boolean;
  stunned: boolean;
  /** Seconds since a crash cost health, while its red flash lasts, else null. */
  hitAge: number | null;
  /** Aboard: the good-landing stumble is on (amber flash and a wobble), and seconds since a perfect landing for its ring burst. */
  stumbling: boolean;
  /** Crouching aboard: the player is drawn low. */
  crouched?: boolean;
  perfectAge: number | null;
  /** The boarding rule against the committed train, or the nearest one while idle. */
  check: BoardingCheck | null;
  /** The train the check is against: only its markers show. */
  trainId: string | null;
  rangeTiles: number;
  timeSec: number;
  /**
   * The car the player is aboard, drawn open, and the player's world position in it. Up on its roof
   * (`roof`) or on a ladder (`climb`, 0 at the foot to 1 at the top) the car stays closed and the
   * player is drawn on it (sneaking PR 3).
   */
  aboard: { trainId: string; index: number; x: number; y: number; roof?: boolean; climb?: number | null; lift?: number } | null;
  /** Slipping on a roof: the player leans and flashes. */
  slipping?: boolean;
  /** Running on a roof: where a jump now would come down (`roof` on a roof, `drop` short onto the platform or coupling, `fall` off the train). */
  jumpCue?: { x: number; y: number; z: number; kind: 'roof' | 'drop' | 'fall' } | null;
  /** Roof outlines on the committed train and the one Tab would switch to. */
  focus: TrainFocus;
  /** The horse's speed in tiles per second, and whether it is in mud, for the mud cue. */
  horseSpeed: number;
  inMud: boolean;
  /** The horse is boosting: dust flies up behind it. */
  boosting?: boolean;
  /** How far the player's footsteps carry aboard (a ring on the floor, or on the roof with `roof`), or null when silent. */
  noise?: { x: number; y: number; r: number; running: boolean; roof?: boolean } | null;
  /** The nearest point on the run's train to the horse, for the stretched hole and the edge glow; null hides both. */
  gap?: { trainId: string; index: number; x: number; y: number; distance: number } | null;
  /** The box of world tiles on screen: scenery outside it is not drawn. */
  view: { x0: number; y0: number; x1: number; y1: number };
  /** While zooming out, the box on screen once the zoom settles: culled for at once, built within the frame budget. */
  cullView?: { x0: number; y0: number; x1: number; y1: number };
  /** The zoom is still easing: the culled box is not shrunk to fit until it settles. */
  zooming?: boolean;
  /** The zoom on screen, for hiding small ground detail far out (?farDetail=). */
  zoom?: number;
  /** Trains whose doors a cash-out shut: their side doors are drawn closed and barred. */
  closedTrains?: ReadonlySet<string>;
  /** Loot lying in the car the player is aboard (its frame), the loot being searched and the one in reach. */
  loot: readonly InteriorLoot[];
  searching: number | null;
  inReach: number | null;
  /** Guards in the car the player is aboard (the open one), in the world. */
  guards?: readonly GuardView[];
  /** Sight cones to draw on the floor (faint by default, full with the debug overlay or ?cones=on), or null. */
  cones?: readonly ConeView[] | null;
  /** Guards in a closed car you can see through its doorways, and their cones: drawn over the roof. */
  throughGuards?: readonly GuardView[];
  throughCones?: readonly ConeView[] | null;
}

/** What the scene needs from the config once: car layouts, the cell catalog and items. */
export interface SceneContent {
  catalog: CarCatalog;
  cellTypes: readonly CellTypeDef[];
  items: Readonly<Record<string, { weight: number; category: string }>>;
  /** Boost dust opacity scale (?boostDust=), 1 by default. */
  boostDust?: number;
  /** Platforms, coupling and ledges round each car (outside.*); none when absent. */
  outside?: OutsideDims;
  /** Ladders up to the roofs (outside.roof.*); none when absent or off. */
  roof?: Pick<SimConfig['values']['outside']['roof'], 'enabled' | 'ladderEnds' | 'ladderRow'> & {
    /** Whether a train's car has a ladder at that end (only some cars do, `ladderCarShare`); absent, every car. */
    hasLadder?(trainId: string, index: number, end: 'front' | 'rear'): boolean;
  };
}

export interface WorldScene {
  root: Container;
  mapOverlay: Container;
  zoneOverlay: Graphics;
  /** Ground height under a world point, in tiles of z (0 on maps without elevation). */
  groundZ(x: number, y: number): number;
  /** The map's tiles as the scene reads them (streamed on a generated line, tiles.ts). */
  tiles: MapTiles;
  /** What the blocked ground nearest a world point, within `reach` tiles, is drawn as: for the crash notice. */
  obstacleAt(x: number, y: number, reach: number): ObstacleKind;
  update(input: WorldSceneInput): void;
}

/** Whether a slice's screen box (roughly) can overlap the hole, so it needs the hole cut in it. */
function sliceNearHole(b: Box, hole: { x: number; y: number; to: { x: number; y: number } | null }): boolean {
  const cx = isoX(b.x, b.y), cy = isoY(b.x, b.y, CAR_HEIGHT / 2);
  const reach = (b.halfLength + b.halfWidth) * (TILE_W / 2) + CAR_HEIGHT * TILE_H + CUTOUT_RADIUS * TILE_H;
  const near = (x: number, y: number) => Math.abs(x - cx) < reach && Math.abs(y - cy) < reach;
  if (near(hole.x, hole.y)) return true;
  if (!hole.to) return false;
  // Along the stretched band, a few points are enough at this size.
  for (let t = 0.25; t <= 1; t += 0.25) if (near(hole.x + (hole.to.x - hole.x) * t, hole.y + (hole.to.y - hole.y) * t)) return true;
  return false;
}

/** The hole's mask: a circle round the horse or player, or a tapered band from it to the car side. */
function drawHole(m: Graphics, hole: { x: number; y: number; to: { x: number; y: number } | null }): void {
  const r0 = CUTOUT_RADIUS * TILE_H;
  m.circle(hole.x, hole.y, r0).fill(0xffffff);
  if (!hole.to) return;
  const r1 = GAP_HOLE_END_RADIUS * TILE_H, { x, y } = hole.to;
  const dx = x - hole.x, dy = y - hole.y, n = Math.hypot(dx, dy) || 1, px = -dy / n, py = dx / n;
  m.circle(x, y, r1).fill(0xffffff);
  m.poly([hole.x + px * r0, hole.y + py * r0, x + px * r1, y + py * r1, x - px * r1, y - py * r1, hole.x - px * r0, hole.y - py * r0]).fill(0xffffff);
}

/** A warm strip on the ground along the car side nearest the horse: `t` from 0 (just in reach) to 1 (touching). */
function drawGapGlow(g: Graphics, car: CarPose, at: { x: number; y: number }, t: number, colour: number): void {
  const along = (at.x - car.x) * car.ux + (at.y - car.y) * car.uy;
  const s = (at.x - car.x) * car.uy - (at.y - car.y) * car.ux >= 0 ? 1 : -1;
  const lx = car.uy * s, ly = -car.ux * s;
  const half = 1 + 3 * t;
  const a0 = Math.max(-car.halfLength, along - half), a1 = Math.min(car.halfLength, along + half);
  const strip = (out: number, alpha: number) => {
    const p = (a: number, o: number): [number, number] => [car.x + car.ux * a + lx * (car.halfWidth + o), car.y + car.uy * a + ly * (car.halfWidth + o)];
    g.poly(isoPoly([p(a0, 0), p(a1, 0), p(a1, out), p(a0, out)], 0.01)).fill({ color: colour, alpha });
  };
  strip(0.15 + 0.4 * t, 0.1 + 0.2 * t);
  strip(0.06 + 0.1 * t, 0.25 + 0.45 * t);
}

/** One slice of a car: its box, the stretch of the car it covers, and whether it holds the car's real ends. */
interface CarSlice { box: Box; along0: number; along1: number; first: boolean; last: boolean }
type DoorSpan = { side: 'left' | 'right'; a0: number; a1: number };

/** Car slices turn in steps this fine (radians, half a degree) so their drawings can be cached. */
const SLICE_ANGLE_STEP = Math.PI / 360;
/** Cached slice drawings kept before old ones are dropped. */
const SLICE_CACHE_MAX = 3000;

/** A slice's box, doors and (at the front) roof chevron, drawn as `box` (the slice's own box, or one round the origin for the cache). */
function drawSliceBody(g: Graphics | GraphicsContext, s: CarSlice, box: Box, colour: number, doors: readonly DoorSpan[], shut: boolean): void {
  const gg = g as Graphics;
  // Inner slice ends are hidden by their neighbours; only the car's real ends are drawn.
  drawBox(gg, box, colour, [!s.first, false, !s.last, false]);
  const mid = (s.along0 + s.along1) / 2;
  for (const d of doors) {
    const a0 = Math.max(d.a0, s.along0), a1 = Math.min(d.a1, s.along1);
    if (a1 <= a0) continue;
    // sidePanel measures along the slice from its own centre.
    if (!shut) { sidePanel(gg, box, d.side, a0 - mid, a1 - mid, 0.15, DOOR_TOP, DOOR_COLOUR); continue; }
    // Shut: a dark plank door with two bars across it.
    sidePanel(gg, box, d.side, a0 - mid, a1 - mid, 0.15, DOOR_TOP, shade(colour, SHUT_DOOR_SHADE));
    sidePanel(gg, box, d.side, a0 - mid, a1 - mid, 0.55, 0.75, DOOR_BAR_COLOUR);
    sidePanel(gg, box, d.side, a0 - mid, a1 - mid, 1.35, 1.55, DOOR_BAR_COLOUR);
  }
  if (s.first) {
    // A pale chevron on the roof at the front, so the direction of travel reads at a glance.
    const b = box, lx = b.uy, ly = -b.ux, tip = b.halfLength - 0.2, back = tip - 1.4;
    gg.poly(isoPoly([
      [b.x + b.ux * tip, b.y + b.uy * tip],
      [b.x + b.ux * back + lx * 1.4, b.y + b.uy * back + ly * 1.4],
      [b.x + b.ux * back - lx * 1.4, b.y + b.uy * back - ly * 1.4],
    ], CAR_HEIGHT + 0.01)).fill({ color: 0xffffff, alpha: 0.55 });
  }
}

/** A car in slices along its length. */
function carSlices(car: CarPose): CarSlice[] {
  const spans = sliceSpans(car.halfLength, SLICE_TILES);
  return spans.map(([a0, a1], i) => {
    const mid = (a0 + a1) / 2;
    return {
      box: { x: car.x + car.ux * mid, y: car.y + car.uy * mid, ux: car.ux, uy: car.uy, halfLength: (a1 - a0) / 2, halfWidth: car.halfWidth, z0: 0, z1: CAR_HEIGHT },
      along0: a0, along1: a1, first: i === 0, last: i === spans.length - 1,
    };
  });
}

/** Side door spans of a template, as [from, to] along the car from its centre toward the front. End doors are not drawn outside. */
export function doorSpans(content: SceneContent, template: string): { side: 'left' | 'right'; a0: number; a1: number }[] {
  const t = carTemplate(content.catalog, template);
  const door = content.cellTypes.findIndex((c) => c.id === 'door');
  const hl = t.size.cols / 2, spans: { side: 'left' | 'right'; a0: number; a1: number }[] = [];
  t.cells.forEach((cell, i) => {
    const col = i % t.size.cols, row = Math.floor(i / t.size.cols);
    if (cell !== door || (row !== 0 && row !== t.size.rows - 1)) return;
    spans.push({ side: row === 0 ? 'left' : 'right', a0: hl - col - 1, a1: hl - col });
  });
  return spans;
}

/** Standing height of the player, and crouched (about crate height, so cover reads). */
const PLAYER_HEIGHT = 1.7, CROUCH_HEIGHT = 0.95;

function drawPlayer(g: Graphics, p: { x: number; y: number }, colour = PLAYER_COLOUR, crouched = false, z = 0): void {
  const r = crouched ? WALKER_RADIUS * 1.15 : WALKER_RADIUS;
  drawBox(g, { x: p.x, y: p.y, ux: 1, uy: 0, halfLength: r, halfWidth: r, z0: z, z1: z + (crouched ? CROUCH_HEIGHT : PLAYER_HEIGHT) }, colour);
}

/**
 * Up on a roof (or a ladder's top half), a figure sorts after every slice of the car under it: well
 * past the car's own depth, so the roof never paints over its feet.
 */
const ROOF_DEPTH_BIAS = 40;
/** Height of a figure's feet: on a roof, or a share of the way up a ladder. */
const figureZ = (roof: boolean | undefined, climb: number | null | undefined) => (climb != null ? climb * CAR_HEIGHT : roof ? CAR_HEIGHT : 0);

/** A question mark in a round badge, in screen pixels centred on (x, y): an alert guard lost you and is searching. */
export function drawQuestion(g: Graphics, x: number, y: number, colour: number, s = 1): void {
  g.circle(x, y, 11 * s).fill({ color: colour }).stroke({ width: 2 * s, color: 0x111111, alpha: 0.8 });
  g.moveTo(x - 4 * s, y - 3 * s).bezierCurveTo(x - 4 * s, y - 9 * s, x + 5 * s, y - 9 * s, x + 4.5 * s, y - 3.5 * s)
    .bezierCurveTo(x + 4 * s, y - 0.5 * s, x, y - 0.5 * s, x, y + 2.5 * s)
    .stroke({ width: 2.5 * s, color: 0x111111, cap: 'round' });
  g.circle(x, y + 6 * s, 1.6 * s).fill(0x111111);
}

/** An ear in a round badge, in screen pixels centred on (x, y): a guard heard you. */
export function drawEar(g: Graphics, x: number, y: number, colour: number, s = 1): void {
  g.circle(x, y, 11 * s).fill({ color: colour }).stroke({ width: 2 * s, color: 0x111111, alpha: 0.8 });
  // The outer rim: a C open to the left, with the lobe curling in at the bottom.
  g.moveTo(x - 3 * s, y - 4 * s).bezierCurveTo(x - 2 * s, y - 9 * s, x + 6 * s, y - 9 * s, x + 6 * s, y - 2 * s)
    .bezierCurveTo(x + 6 * s, y + 2 * s, x + 2 * s, y + 3 * s, x + 2 * s, y + 6 * s)
    .bezierCurveTo(x + 2 * s, y + 9 * s, x - 3 * s, y + 9 * s, x - 3 * s, y + 6 * s)
    .stroke({ width: 2.5 * s, color: 0x111111, cap: 'round' });
  // The inner fold.
  g.moveTo(x - 0.5 * s, y - 2 * s).bezierCurveTo(x, y - 5 * s, x + 3.5 * s, y - 4 * s, x + 3 * s, y - 1 * s)
    .stroke({ width: 2 * s, color: 0x111111, cap: 'round' });
}

/** A guard: a dark uniform turned the way it faces, a hat with a brim toward its face, and its shadow. */
function drawGuard(g: Graphics, v: GuardView): void {
  const z = figureZ(v.roof, v.climb);
  if (v.climb == null) groundEllipse(g, v.x, v.y, WALKER_RADIUS, z).fill({ color: 0x000000, alpha: 0.3 });
  drawBox(g, { x: v.x, y: v.y, ux: v.fx, uy: v.fy, halfLength: WALKER_RADIUS, halfWidth: WALKER_RADIUS * 0.9, z0: z, z1: z + 1.6 }, GUARD_COLOUR);
  drawBox(g, { x: v.x + v.fx * 0.12, y: v.y + v.fy * 0.12, ux: v.fx, uy: v.fy, halfLength: WALKER_RADIUS + 0.06, halfWidth: WALKER_RADIUS * 0.85, z0: z + 1.6, z1: z + 1.75 }, GUARD_HAT_COLOUR);
}

/** The horse: a body box along its heading, a head, legs, and the rider on top. */
function drawHorse(g: Graphics, h: ActorPose, flash: number | null, muddiness: number, gz = 0, riderless = false): void {
  const body: Box = { x: h.x - h.hx * 0.15, y: h.y - h.hy * 0.15, ux: h.hx, uy: h.hy, halfLength: 0.75, halfWidth: 0.3, z0: 0.45, z1: 1.15 };
  const head: Box = { x: h.x + h.hx * 0.75, y: h.y + h.hy * 0.75, ux: h.hx, uy: h.hy, halfLength: 0.28, halfWidth: 0.2, z0: 0.9, z1: 1.5 };
  const legs: Box = { ...body, halfLength: 0.6, halfWidth: 0.22, z0: 0, z1: 0.45 };
  const rider: Box = { x: h.x - h.hx * 0.2, y: h.y - h.hy * 0.2, ux: h.hx, uy: h.hy, halfLength: 0.22, halfWidth: 0.22, z0: 1.15, z1: 2.05 };
  for (const b of [body, head, legs, rider]) { b.z0 += gz; b.z1 += gz; }
  const c = flash ?? HORSE_COLOUR;
  drawBox(g, legs, flash ?? mix(shade(c, 0.7), MUDDY_LEGS, muddiness));
  drawBox(g, body, c);
  drawBox(g, head, c);
  if (!riderless) drawBox(g, rider, flash ?? RIDER_COLOUR);
}

/** `groundCover`: scatter grass and scrub over open ground from this seed, or none when null. */
export function createWorldScene(map: MapDef, content: SceneContent, scenery: SceneryDef | null = null, groundCover: number | null = null, warmUp: ((ctx: GraphicsContext) => void) | null = null): WorldScene {
  const root = new Container();
  root.label = 'iso-world';
  // What moves (the horse, the player, cars) sorts in `objects`. Static pieces that sort with
  // them (hills, mesas, boulders, trees) sort once in `land`, drawn under it, with copies over
  // the movers where they cover them (see overdraw.ts).
  const objects = new Container();
  objects.sortableChildren = true;
  // ?landBands=off keeps the land in one band (one render group), as before PR #42 round 2, to compare.
  const land = new DepthBands(urlFlag('landBands') === 'off' ? Infinity : LAND_BAND_DEPTH);
  land.label = 'iso-land';
  land.enableRenderGroup();
  // A generated line made without its tiles streams them chunk by chunk (tiles.ts); the rest decode once.
  const tiles = mapTiles(map, scenery);
  const field = createHeightField(map, tiles);
  // Big maps (the open line) build their static drawing per region as it comes near the view and
  // drop it far behind; the rest build it all here, as before (cells.ts regionSize).
  const region = regionSize(map), lazyDraw = tiles.streamed || region < Math.max(map.size.cols, map.size.rows);
  // Pieces that sort with the movers get copies over them (overdraw.ts); it hears about pieces built and dropped later.
  let overdraw: Overdraw | null = null;
  const sortedHooks = { onBuild: (cs: Chunk[]) => overdraw?.add(cs.map((c) => c.g)), onDrop: (cs: Chunk[]) => overdraw?.remove(cs.map((c) => c.g)) };
  const treeHooks = { onBuild: (gs: Graphics[]) => overdraw?.add(gs), onDrop: (gs: Graphics[]) => overdraw?.remove(gs) };
  const sceneryLayers = scenery ? createSceneryLayers(map, scenery, land, field.raised ? field.surfaceZ : undefined, region, treeHooks, tiles) : null;
  const cover = groundCover === null ? null : createGroundCover(map, groundCover, region, tiles);
  const ground = new Container();
  if (cover) ground.addChild(cover.layer);
  if (sceneryLayers) ground.addChild(sceneryLayers.ground);
  // Raised tiles get their spots and puddles from the height layer, on the slope.
  const { layer: terrain, cull: cullTerrain } = drawTerrain(map, ground, (x, y) => field.corners(x, y).some((z) => z > 0), region, tiles);
  const shadows = new Graphics();
  const floors = new Graphics();
  const markers = new Graphics();
  // Boarding range circles: off until B, which Devlin found clearer in the Phase 1 gate playtest.
  const zoneOverlay = new Graphics();
  zoneOverlay.visible = false;
  const mapOverlay = drawIsoMapOverlay(map);
  mapOverlay.visible = false;
  // Forest tiles are blocked too, but draw as trees on forest floor, not boulders.
  const forest = scenery ? (x: number, y: number) => tiles.forest(x, y) : undefined;
  const heights = createHeightLayer(map, field, land, forest, region, sortedHooks, tiles);
  const rocks = createRocks(map, land, field, forest, region, sortedHooks, tiles);
  const mesas = createMesas(map, field, land, () => rocks.chunks, objects, lazyDraw, sortedHooks);
  const mud = createMud();
  const towns = drawTowns(map, field.raised ? (x, y) => field.surfaceZ(x, y) : undefined);
  root.addChild(terrain, mapOverlay, mud.prints, shadows, floors, towns, land, objects, zoneOverlay, markers, mesas.masks);
  overdraw = new Overdraw(objects, mesas.masks);
  overdraw.add([...heights.chunks, ...rocks.chunks, ...mesas.chunks].map((c) => c.g));
  if (sceneryLayers) overdraw.add(sceneryLayers.trees);
  const dust = createDust(content.boostDust ?? 1);
  objects.addChild(mud.clods, dust.puffs);

  const spans = new Map<string, ReturnType<typeof doorSpans>>();
  const spansOf = (template: string) => { let v = spans.get(template); if (!v) { v = doorSpans(content, template); spans.set(template, v); } return v; };
  const slicePool: Graphics[] = [];
  const horseG = new Graphics();
  const playerG = new Graphics();
  objects.addChild(horseG, playerG);
  // Each pooled slice has its own copy of the hole (a mask serves one object), used inverted.
  const holes: Graphics[] = [], holed: boolean[] = [];
  // The hole around the hidden horse or player, stretched to a point on the car side (`to`) when it shows the gap.
  let hole: { x: number; y: number; to: { x: number; y: number } | null } | null = null;
  // Each pooled piece's own context, for drawing that changes every frame (interiors, guards, glowing slices).
  const owned = new WeakMap<Graphics, GraphicsContext>();
  const piece = (cut = false, own = true) => {
    let g = slicePool[used];
    if (!g) {
      g = new Graphics(); slicePool.push(g); objects.addChild(g);
      // Remember the piece's own context now: it may show shared cached car drawings later.
      owned.set(g, g.context);
      const m = new Graphics(); holes.push(m); holed.push(false); root.addChild(m);
    }
    const m = holes[used]!;
    m.clear();
    if (cut && hole) drawHole(m, hole);
    // setMask ignores a null mask, so an uncut slice drops its mask outright: an empty inverse
    // mask still costs a stencil pass.
    if (cut !== holed[used]) { if (cut) g.setMask({ mask: m, inverse: true }); else g.mask = null; holed[used] = cut; }
    g.visible = true;
    // A slice may be showing a cached car context: draw into the piece's own one instead of clearing that.
    if (own) ownContext(g);
    used++;
    return g;
  };
  const ownContext = (g: Graphics) => {
    const ctx = owned.get(g)!;
    if (g.context !== ctx) { g.context = ctx; g.position.set(0, 0); }
    ctx.clear();
  };
  // Car slice drawings by template, slice, colour, door state and angle (to SLICE_ANGLE_STEP),
  // drawn round the slice centre. Ones unused for a while go once there are too many.
  const sliceCache = new Map<string, { ctx: GraphicsContext; frame: number }>();
  let frameNo = 0;
  const sliceContext = (template: string, s: CarSlice, colour: number, doors: DoorSpan[], shut: boolean): GraphicsContext => {
    const step = SLICE_ANGLE_STEP, k = Math.round(Math.atan2(s.box.uy, s.box.ux) / step);
    const key = `${template}|${s.along0}|${s.along1}|${s.box.halfWidth}|${colour}|${shut ? 1 : 0}|${k}`;
    let e = sliceCache.get(key);
    if (!e) {
      const ctx = new GraphicsContext();
      const box: Box = { ...s.box, x: 0, y: 0, ux: Math.cos(k * step), uy: Math.sin(k * step) };
      drawSliceBody(ctx, s, box, colour, doors, shut);
      sliceCache.set(key, e = { ctx, frame: frameNo });
      if (sliceCache.size > SLICE_CACHE_MAX) {
        for (const [k2, v] of sliceCache) if (frameNo - v.frame > 2) { v.ctx.destroy(); sliceCache.delete(k2); }
      }
    }
    e.frame = frameNo;
    return e.ctx;
  };
  let used = 0;
  let lastFadeSec = 0;

  let culledView: TileBox | null = null, building = false;
  const blockedZone = map.zoneLegend.indexOf('blocked');
  const obstacleTiles: ObstacleTiles = {
    blocked: (x, y) => x >= 0 && y >= 0 && x < tiles.cols && y < tiles.rows && tiles.zone(x, y) === blockedZone,
    forest: (x, y) => tiles.forest(x, y),
    mesa: (x, y) => field.plateauOf(x, y) >= 0,
  };
  return {
    root, mapOverlay, zoneOverlay, tiles,
    groundZ: field.groundZ,
    obstacleAt: (x, y, reach) => obstacleNear(obstacleTiles, x, y, reach),
    update(input) {
      frameNo++;
      // Re-cull only once the view leaves the last culled box, or zooming in leaves it far too big.
      const iv = input.cullView ?? input.view, slack = 2 * (CULL_SNAP + CULL_MARGIN);
      const recull = !culledView || iv.x0 < culledView.x0 || iv.y0 < culledView.y0 || iv.x1 > culledView.x1 || iv.y1 > culledView.y1
        || (!input.zooming && (culledView.x1 - culledView.x0 > iv.x1 - iv.x0 + 2 * slack || culledView.y1 - culledView.y0 > iv.y1 - iv.y0 + 2 * slack));
      if (recull || building) {
        const snap = (v: number, up: boolean) => (up ? Math.ceil(v / CULL_SNAP) : Math.floor(v / CULL_SNAP)) * CULL_SNAP;
        const view = recull || !culledView ? { x0: snap(iv.x0 - CULL_MARGIN, false), y0: snap(iv.y0 - CULL_MARGIN, false), x1: snap(iv.x1 + CULL_MARGIN, true), y1: snap(iv.y1 + CULL_MARGIN, true) } : culledView;
        // Regions near the view but off screen build a few milliseconds' worth a frame; the ones on screen build at once.
        // Only what is on screen now must be built at once; the rest of a zoom's target waits for budget.
        const sv = input.view, must = { x0: sv.x0 - CULL_MARGIN, y0: sv.y0 - CULL_MARGIN, x1: sv.x1 + CULL_MARGIN, y1: sv.y1 + CULL_MARGIN };
        const budget = { until: performance.now() + BUILD_MS_PER_FRAME, must };
        // A view that jumped (the first frame, a switch far away) or is zooming gets its land at once; a sliding
        // one gets it a few bands a frame (DepthBands.flush below), well inside the cull margin.
        const jumped = !culledView || !overlapsBox(culledView, iv) || !!input.zooming;
        culledView = view;
        land.deferred = !jumped;
        building = [cullTerrain(view, budget), cover?.cull(view, budget), sceneryLayers?.cull(view, budget), rocks.cull(view, budget), heights.cull(view, budget), mesas.cull(view, budget)].some(Boolean);
        if (jumped) land.flush();
        land.deferred = true;
        overdraw.refresh();
      }
      if (land.flush(LAND_BANDS_PER_FRAME)) overdraw.refresh();
      // Far out, grass, scrub, bushes and flowers can go (?farDetail=).
      const detail = !(input.zoom !== undefined && input.zoom <= FAR_DETAIL_ZOOM);
      if (cover) cover.layer.visible = detail;
      if (sceneryLayers) sceneryLayers.cover.visible = detail;
      // Triangulate freshly built pieces while the frame's budget lasts, before they come into view.
      if (warmUp && freshlyBuilt.length) {
        const until = performance.now() + WARM_MS_PER_FRAME;
        while (freshlyBuilt.length && performance.now() < until) {
          const g = freshlyBuilt.pop()!;
          if (!g.destroyed) warmUp(g.context);
        }
      } else freshlyBuilt.length = 0;
      // Trees in front of the horse (or you aboard) fade so you stay in view.
      const seen = input.aboard ? { x: input.aboard.x, y: input.aboard.y, z: 1 } : input.horse ? { x: input.horse.x, y: input.horse.y, z: 1 } : null;
      sceneryLayers?.fade(seen, Math.min(0.1, Math.max(0, input.timeSec - lastFadeSec)));
      lastFadeSec = input.timeSec;
      // Cars: every slice is its own sortable child, redrawn at the car's current angle.
      used = 0;
      const horseZ = input.horse ? field.groundZ(input.horse.x, input.horse.y) : 0;
      mud.update({ horse: input.horse, speed: input.horseSpeed, inMud: input.inMud, timeSec: input.timeSec, groundZ: horseZ });
      dust.update({ horse: input.horse, boosting: !!input.boosting, speed: input.horseSpeed, timeSec: input.timeSec, groundZ: horseZ });
      shadows.clear();
      floors.clear();
      // Who to keep in sight: the player aboard, or the horse by its nose, middle and tail.
      const actor = input.aboard ?? input.horse;
      const keep: [number, number][] = [];
      if (input.aboard) keep.push([input.aboard.x, input.aboard.y]);
      else if (input.horse) {
        const h = input.horse;
        for (const k of [-0.8, 0, 0.8]) keep.push([h.x + h.hx * k, h.y + h.hy * k]);
      }
      // Hidden behind any car, they get a hole through every closed slice: a slice whose centre is
      // behind them can still cover the ground around them, so the hole is cut through all of them.
      // Up on a roof or a ladder, the heights to keep in sight are lifted with the player.
      const playerZ = input.aboard ? figureZ(input.aboard.roof, input.aboard.climb) + (input.aboard.lift ?? 0) : 0;
      // Riding on raised ground, they are lifted with the ground under the horse.
      const liftZ = input.aboard ? playerZ : horseZ;
      const keepHeights = liftZ > 0 ? HIDDEN_HEIGHTS.map((h) => h + liftZ) : HIDDEN_HEIGHTS;
      // On a roof, your own train's cars are no taller than you stand, so only other trains can hide you.
      const roofTrain = input.aboard?.roof ? input.aboard.trainId : null;
      const hidden = keep.some(([x, y]) => input.cars.some((car) => car.trainId !== roofTrain && carHides(car, CAR_HEIGHT, x, y, keepHeights, SLICE_TILES)));
      // Behind a mesa, the same round hole goes through the mesa (Devlin, PR #25 playtest).
      const behindMesa = actor !== null && mesas.hides(keep.flatMap(([x, y]) => HIDDEN_HEIGHTS.map((z) => [isoX(x, y), isoY(x, y, liftZ + z)] as const)), depthOf(actor.x, actor.y));
      mesas.cut(behindMesa && actor ? { x: isoX(actor.x, actor.y), y: isoY(actor.x, actor.y, liftZ + 1), r: CUTOUT_RADIUS * TILE_H } : null, actor ? depthOf(actor.x, actor.y) : 0);
      hole = hidden && actor ? { x: isoX(actor.x, actor.y), y: isoY(actor.x, actor.y, 1 + liftZ), to: null } : null;
      // On the far side of the run's train, the hole reaches the car so the ground between shows.
      const gap = input.horse && !input.aboard ? input.gap ?? null : null;
      const gapCar = gap ? input.cars.find((c) => c.trainId === gap.trainId && c.index === gap.index) : undefined;
      if (gap && gapCar && input.horse && gap.distance <= GAP_HOLE_TILES && depthOf(input.horse.x, input.horse.y) < depthOf(gapCar.x, gapCar.y)) {
        const h = input.horse;
        hole = { x: isoX(h.x, h.y), y: isoY(h.x, h.y, 1 + horseZ), to: { x: isoX(gap.x, gap.y), y: isoY(gap.x, gap.y, 0) } };
      }
      const glow = gap && gapCar && gap.distance <= GAP_GLOW_TILES ? 1 - gap.distance / GAP_GLOW_TILES : 0;
      const glowColour = gap && gap.distance <= GAP_DANGER_TILES ? GAP_DANGER_COLOUR : GAP_GLOW_COLOUR;
      if (gap && gapCar && glow > 0) drawGapGlow(floors, gapCar, gap, glow, glowColour);
      const v = input.view, margin = (car: CarPose) => car.halfLength + CAR_HEIGHT + 2;
      input.cars.forEach((car, i) => {
        // Cars off screen are not drawn at all: big-country has several trains.
        const m = margin(car);
        if (car.x < v.x0 - m || car.x > v.x1 + m || car.y < v.y0 - m || car.y > v.y1 + m) return;
        const colour = CAR_COLOURS[carTemplate(content.catalog, car.template).carType] ?? 0x777777;
        const doors = spansOf(car.template);
        const shut = input.closedTrains?.has(car.trainId) ?? false;
        // A soft shadow under the car, offset down-right like the light.
        const shadow = boxCorners({ ...car, x: car.x + 0.5, y: car.y + 0.5, halfWidth: car.halfWidth + 0.4, z0: 0, z1: 0 });
        shadows.poly(isoPoly(shadow)).fill({ color: 0x000000, alpha: 0.22 });
        // Platforms, ledges and the coupling to the next car of the same train.
        if (content.outside) drawCarOutside(floors, car, content.outside, input.cars[i + 1]?.trainId === car.trainId);
        // Ladders up each end (sneaking PR 3), each sorting on its own so the car hides the far one.
        const rc = content.roof;
        if (rc?.enabled && (content.outside?.platformDepthTiles ?? 0) > 0) {
          for (const end of ['front', 'rear'] as const) {
            if (rc.ladderEnds !== 'both' && rc.ladderEnds !== end) continue;
            if (rc.hasLadder && !rc.hasLadder(car.trainId, car.index, end)) continue;
            const g = piece();
            drawLadder(g, car, end, rc.ladderRow, CAR_HEIGHT);
            const a = end === 'front' ? car.halfLength + 0.1 : -car.halfLength - 0.1;
            g.zIndex = depthOf(car.x + car.ux * a, car.y + car.uy * a);
          }
        }
        // The car you are in is drawn open: no roof, its cells as low boxes and its loot, so you show inside it.
        // Up on its roof or on its ladder, it stays closed and you are drawn on it.
        if (input.aboard?.trainId === car.trainId && input.aboard.index === car.index && !input.aboard.roof && input.aboard.climb == null) {
          drawInterior(floors, () => piece(), {
            car, template: carTemplate(content.catalog, car.template), cellTypes: content.cellTypes, items: content.items,
            loot: input.loot, searching: input.searching, inReach: input.inReach, timeSec: input.timeSec,
          });
          return;
        }
        for (const s of carSlices(car)) {
          // Only slices that reach the hole get it: each masked slice is an extra stencil pass.
          const glowing = gap !== null && gapCar === car && glow > 0;
          const g = piece(hole !== null && sliceNearHole(s.box, hole), glowing);
          if (!glowing) {
            // The usual case: the slice's drawing comes from a cache by its shape and angle, so
            // nothing is triangulated or uploaded again; only its position moves.
            g.context = sliceContext(car.template, s, colour, doors, shut);
            g.position.set(isoX(s.box.x, s.box.y), isoY(s.box.x, s.box.y));
            g.zIndex = depthOf(s.box.x, s.box.y);
            continue;
          }
          ownContext(g);
          drawSliceBody(g, s, s.box, colour, doors, shut);
          if (gap && gapCar === car && glow > 0) {
            // The glow on the near wall's bottom edge, where that face is in view.
            const along = (gap.x - car.x) * car.ux + (gap.y - car.y) * car.uy, half = 1 + 3 * glow;
            const a0 = Math.max(s.along0, along - half), a1 = Math.min(s.along1, along + half);
            const side = (gap.x - car.x) * car.uy - (gap.y - car.y) * car.ux >= 0 ? 'left' : 'right';
            const mid = (s.along0 + s.along1) / 2;
            if (a1 > a0) {
              // A faint wash up the wall, and a bright line along the bottom.
              sidePanel(g, s.box, side, a0 - mid, a1 - mid, 0, 0.1 + 0.25 * glow, glowColour, 0.12 + 0.25 * glow);
              sidePanel(g, s.box, side, a0 - mid, a1 - mid, 0, 0.05, glowColour, 0.4 + 0.5 * glow);
            }
          }
          g.zIndex = depthOf(s.box.x, s.box.y);
        }
      });
      for (let i = used; i < slicePool.length; i++) slicePool[i]!.visible = false;

      // The player aboard, walking in the open car.
      playerG.clear();
      playerG.visible = input.aboard !== null;
      if (input.aboard) {
        const p = input.aboard;
        if (input.aboard.climb == null) groundEllipse(playerG, p.x, p.y, WALKER_RADIUS, playerZ).fill({ color: 0x000000, alpha: 0.3 });
        if (input.perfectAge !== null && input.perfectAge < PERFECT_RING_SEC) {
          // A green ring bursting out from the feet.
          const t = input.perfectAge / PERFECT_RING_SEC;
          groundEllipse(playerG, p.x, p.y, 0.4 + t * 2.2, 0.05).stroke({ width: 4, color: PERFECT_COLOUR, alpha: 1 - t });
        }
        // Stumbling: wobble side to side and flash amber; slipping on a roof, wobble harder and flash red.
        const shaky = input.stumbling || !!input.slipping;
        const wobble = shaky ? Math.sin(input.timeSec * (input.slipping ? 30 : 22)) * (input.slipping ? 0.2 : 0.12) : 0;
        const colour = input.slipping && flashOn(input.timeSec) ? HIT_COLOUR : input.stumbling && flashOn(input.timeSec) ? GOOD_COLOUR : PLAYER_COLOUR;
        drawPlayer(playerG, { x: p.x + wobble, y: p.y - wobble }, colour, input.crouched ?? false, playerZ);
        playerG.zIndex = depthOf(p.x, p.y) + (playerZ > CAR_HEIGHT / 2 ? ROOF_DEPTH_BIAS : 0);
      }

      // Guards in the open car, and their sight cones on the floor: faint so you can read where they look, stronger for debug.
      // Cones below on the floor; a roof guard's cone lies on the roofs, drawn over the cars further down.
      const drawCone = (g: Graphics, cone: ConeView) => {
        const col = GUARD_STATE_COLOURS[cone.state];
        const fill = (cone.state === 'unaware' ? 0.14 : 0.26) * (cone.faint ? 0.5 : 1);
        g.poly(isoPoly(cone.points, cone.roof ? CAR_HEIGHT + 0.06 : 0.06)).fill({ color: col, alpha: fill }).stroke({ width: 1, color: col, alpha: cone.faint ? 0.25 : 0.5 });
      };
      for (const cone of input.cones ?? []) if (!cone.roof) drawCone(floors, cone);
      // How far your footsteps carry: a guard inside the ring hears you (on the roof, drawn on it further down).
      const n = input.noise;
      if (n && !n.roof) groundEllipse(floors, n.x, n.y, n.r, 0.07).stroke({ width: 1.5, color: 0xffffff, alpha: n.running ? 0.45 : 0.2 });
      const guardsShown = input.guards ?? [];
      for (const v of guardsShown) {
        const g = piece();
        drawGuard(g, v);
        g.zIndex = depthOf(v.x, v.y) + (figureZ(v.roof, v.climb) > CAR_HEIGHT / 2 ? ROOF_DEPTH_BIAS : 0);
      }

      // The horse: a body box along its heading, a head, and the rider on top.
      horseG.clear();
      horseG.visible = input.horse !== null;
      if (input.horse) {
        const h = input.horse;
        // A crash flashes red, a failed jump's stun white.
        const flash = input.hitAge !== null && flashOn(input.hitAge) ? HIT_COLOUR
          : input.stunned && flashOn(input.timeSec) ? 0xffffff : null;
        // The shadow goes with the horse, so raised ground drawn in front of the shadows layer cannot hide it.
        groundEllipse(horseG, h.x + 0.2, h.y + 0.2, HORSE_RADIUS * 0.9, horseZ).fill({ color: 0x000000, alpha: 0.25 });
        drawHorse(horseG, h, flash, mud.muddiness, horseZ, input.riderless ?? false);
        horseG.zIndex = depthOf(h.x, h.y);
      }

      // Static pieces in front of what moves are copied over it.
      const movers: Mover[] = [];
      const pad = 2;
      for (const car of input.cars) {
        const m = margin(car);
        if (car.x < v.x0 - m || car.x > v.x1 + m || car.y < v.y0 - m || car.y > v.y1 + m) continue;
        // One mover per slice: a long car's screen box is mostly empty ground, and each slice sorts on its own.
        for (const s of carSlices(car)) {
          const mv: Mover = { zIndex: depthOf(s.box.x, s.box.y), minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          for (const [x, y] of boxCorners({ ...s.box, z0: 0, z1: 0 })) {
            const sx = isoX(x, y), top = isoY(x, y, CAR_HEIGHT), bottom = isoY(x, y);
            mv.minX = Math.min(mv.minX, sx - pad); mv.maxX = Math.max(mv.maxX, sx + pad);
            mv.minY = Math.min(mv.minY, top - pad); mv.maxY = Math.max(mv.maxY, bottom + pad);
          }
          movers.push(mv);
        }
      }
      for (const g of [horseG, playerG]) {
        if (!g.visible) continue;
        const b = g.getLocalBounds();
        movers.push({ zIndex: g.zIndex, minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad });
      }
      // Mesa and boulder pieces with the hole cut in them draw in the sorted container, over the static land: what is in front of them is copied over them too.
      movers.push(...mesas.cutPieces());
      overdraw.update(movers);

      // Debug zones: the boarding range around every entry point (B toggles).
      zoneOverlay.clear();
      for (const car of input.cars) {
        if (input.closedTrains?.has(car.trainId)) continue;
        for (const ep of carEntryPoints(car, content.catalog)) groundEllipse(zoneOverlay, ep.x, ep.y, input.rangeTiles);
      }
      zoneOverlay.stroke({ width: 2, color: 0xffffff, alpha: 0.45 });

      markers.clear();
      // Roofs: the committed train flashes gold just after a commit or switch (no lasting
      // highlight, Devlin 2026-10-13), and the one Tab would switch to is outlined pale blue. They
      // draw over the cars, so a train behind another still shows.
      const f = input.focus;
      const flashing = f.switchAge !== null && f.switchAge < SWITCH_FLASH_SEC && flashOn(f.switchAge, 6);
      for (const car of input.cars) {
        const roof = () => isoPoly(boxCorners({ ...car, z0: 0, z1: 0 }), CAR_HEIGHT + 0.02);
        if (car.trainId === f.committed && flashing) markers.poly(roof()).fill({ color: COMMITTED_COLOUR, alpha: 0.55 }).stroke({ width: 4, color: COMMITTED_COLOUR });
        else if (car.trainId === f.candidate) markers.poly(roof()).stroke({ width: 3, color: SWITCH_CANDIDATE_COLOUR, alpha: 0.8 });
      }

      // Up on the roofs: roof guards' cones, your footstep ring, and where a jump would come down.
      for (const cone of input.cones ?? []) if (cone.roof) drawCone(markers, cone);
      if (n?.roof) groundEllipse(markers, n.x, n.y, n.r, CAR_HEIGHT + 0.07).stroke({ width: 1.5, color: 0xffffff, alpha: n.running ? 0.45 : 0.2 });
      const jc = input.jumpCue;
      if (jc) {
        const col = jc.kind === 'roof' ? PERFECT_COLOUR : jc.kind === 'drop' ? GOOD_COLOUR : HIT_COLOUR;
        groundEllipse(markers, jc.x, jc.y, 0.35, jc.z + 0.05).fill({ color: col, alpha: 0.35 }).stroke({ width: 2, color: col, alpha: 0.9 });
      }

      // Guards you see through the doorways of a closed car: cone and figure over its roof.
      for (const cone of input.throughCones ?? []) {
        const col = GUARD_STATE_COLOURS[cone.state];
        const fill = (cone.state === 'unaware' ? 0.14 : 0.26) * (cone.faint ? 0.5 : 1);
        markers.poly(isoPoly(cone.points, 0.06)).fill({ color: col, alpha: fill }).stroke({ width: 1, color: col, alpha: cone.faint ? 0.25 : 0.5 });
      }
      for (const v of input.throughGuards ?? []) drawGuard(markers, v);

      // Above each guard in view: an ear when it just heard you, an amber ● when suspicious, a red ! when alert, a red ? when it lost you.
      for (const v of [...guardsShown, ...(input.throughGuards ?? [])]) {
        if (v.state === 'unaware' && !v.heard) continue;
        const col = GUARD_STATE_COLOURS[v.state];
        const x = isoX(v.x, v.y), y = isoY(v.x, v.y, 2.3 + figureZ(v.roof, v.climb));
        if (v.heard && v.state !== 'alert') drawEar(markers, x, y, GUARD_STATE_COLOURS.suspicious);
        else if (v.searching) drawQuestion(markers, x, y, col);
        else if (v.state === 'alert') {
          markers.roundRect(x - 7, y - 12, 14, 24, 4).fill({ color: col }).stroke({ width: 2, color: 0x111111, alpha: 0.8 });
          markers.rect(x - 1.5, y - 8, 3, 10).fill(0x111111).rect(x - 1.5, y + 5, 3, 3).fill(0x111111);
        } else {
          markers.circle(x, y, 8).fill({ color: col }).stroke({ width: 2, color: 0x111111, alpha: 0.8 });
          markers.circle(x, y, 2.5).fill(0x111111);
        }
      }

      // Entry markers on the riding side of the checked train: dim out of range, a ring when in
      // range at the wrong speed, highlighted when matched. They draw over the cars so a door on
      // the far side still shows.
      const c = input.check;
      if (input.horse && c && input.trainId) {
        for (const car of input.cars) {
          if (car.trainId !== input.trainId) continue;
          for (const ep of carEntryPoints(car, content.catalog)) {
            if (ep.side !== c.side) continue;
            const isNearest = c.car === car.index && c.entry === ep.id;
            const state: BoardingState = isNearest ? c.state : 'too far';
            const col = MARKER_COLOURS[state];
            const x = isoX(ep.x, ep.y), y = isoY(ep.x, ep.y, 1.2);
            if (state === 'eligible') groundEllipse(markers, ep.x, ep.y, input.rangeTiles).fill({ color: col, alpha: 0.28 }).stroke({ width: 3, color: col });
            else if (state !== 'too far') groundEllipse(markers, ep.x, ep.y, input.rangeTiles).stroke({ width: 3, color: col });
            const r = state === 'too far' ? 7 : 11;
            markers.poly([x, y - r * 1.4, x + r, y, x, y + r * 1.4, x - r, y])
              .fill({ color: col, alpha: state === 'too far' ? 0.45 : 1 })
              .stroke({ width: 2, color: 0x111111, alpha: state === 'too far' ? 0.3 : 0.8 });
          }
        }
      }
    },
  };
}
