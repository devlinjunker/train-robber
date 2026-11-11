// The procedural map generator (G1 spike): a seed and MapGenSettings in, an ordinary MapDef and
// SceneryDef out, in the same format `tools build-maps` writes from Tiled. Nothing here touches
// the sim; the sim reads the result like any hand-made map.
//
// Order: track loop -> distance to the track for every tile near it -> which side of each stretch
// may hold obstacles -> rivers (each crosses the track once, on a bridge) -> zones from layered
// noise, kept off the cars and out of the open riding lane -> elevation (view only, but cliffs
// block, so it is deterministic too) -> player spawn -> scenery.
import {
  CHUNK_TILES, MapDefSchema, type MapTheme, SCENERY_KINDS, SceneryDefSchema, ZONES,
  type MapChunk, type MapChunks, type MapDef, type MapGenSettings, type Route, type SceneryDef,
} from '@train-robber/config';
import { hashString, rng } from './dmath';
import { generateLineTrack } from './line';
import { generateTrack, r6, type Vec } from './track';
import { buildWindow, planWorld, ZONE_INDEX, type WorldPlan, type WorldWindow } from './world';

/** Bump when a change makes the same seed and settings give a different map. */
export const GENERATOR_VERSION = 4;
/** The map id the game uses for a generated map (`?map=gen`). */
export const GENERATED_MAP_ID = 'gen';
/** The map id of a generated open line (`?map=line`). */
export const LINE_MAP_ID = 'line';
/** Bump when a change makes the same seed and settings give a different open line. */
export const LINE_GENERATOR_VERSION = 4;

export interface GeneratedMap {
  /** On an open line, `terrain` builds any chunk of it on demand. */
  map: MapDef & { terrain?: MapChunks };
  scenery: SceneryDef;
  /** Tightest curve, for the checks and the debug panel. */
  minRadiusTiles: number;
  info: { controlPoints: number; trackAttempts: number; rivers: number; trackLength: number; theme: MapTheme; busyness: number; pieces?: number; towns?: number };
}

const clamp01 = (v: number) => Math.max(0, Math.min(0.9999, v));

/** The map's theme and busyness (see MapGenSchema `mix`), applied to the noise thresholds. */
export function applyMix(seed: string, s: MapGenSettings): { settings: MapGenSettings; theme: MapTheme; busyness: number } {
  const r = rng(`${seed}/mix`);
  const theme = s.mix.themes[r.int(0, s.mix.themes.length - 1)]!;
  const busyness = Math.round(r.range(s.mix.busyness[0], s.mix.busyness[1]) * 1000) / 1000;
  const shift = (t: number, mine: MapTheme) => clamp01(t - busyness + (theme === 'balanced' ? 0 : theme === mine ? -s.mix.boost : s.mix.damp));
  const lakes = shift(s.lakes.threshold, 'water');
  return {
    theme, busyness,
    settings: {
      ...s,
      mud: { ...s.mud, threshold: shift(s.mud.threshold, 'mud') },
      rocks: { ...s.rocks, threshold: shift(s.rocks.threshold, 'rocks') },
      forest: { ...s.forest, threshold: shift(s.forest.threshold, 'forest') },
      lakes: { ...s.lakes, threshold: lakes, deepThreshold: clamp01(s.lakes.deepThreshold + lakes - s.lakes.threshold) },
      rivers: theme === 'water' ? { ...s.rivers, count: [Math.min(6, s.rivers.count[0] + 1), Math.min(6, s.rivers.count[1] + 1)] } : s.rivers,
      mesas: {
        ...s.mesas, threshold: shift(s.mesas.threshold, 'mesas'),
        ...(theme === 'mesas' ? { ridges: [s.mesas.ridges[0] + 1, s.mesas.ridges[1] + 1] as [number, number] } : {}),
      },
    },
  };
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

function rle(values: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

/** The loop's settings without the open line's, so adding line settings leaves loop hashes alone. */
function loopSettings(given: MapGenSettings): Omit<MapGenSettings, 'line'> {
  const rest: Partial<MapGenSettings> = { ...given };
  delete rest.line;
  return rest as Omit<MapGenSettings, 'line'>;
}

/** A closed loop map (`?map=gen`). */
export function generateMap(seed: string, given: MapGenSettings): GeneratedMap {
  const { settings: s, theme, busyness } = applyMix(seed, given);
  const { cols, rows } = s.size;
  const track = generateTrack(rng(`${seed}/track`), cols, rows, s.track);
  const plan = planWorld(seed, s, { cols, rows, track, closed: true, trackScale: 1, areaScale: 1, spawnAlong: null, towns: null });
  const whole = buildWindow(plan, 0, 0, cols, rows);
  const w = { zones: whole.zones, heights: whole.heights, items: sceneryOf(whole), bridges: plan.bridges, playerSpawn: plan.playerSpawn };
  // The file names the seed, then the theme and busyness it picked, for the debug panel.
  const source = { file: `gen:${seed} ${theme} ${busyness >= 0 ? '+' : ''}${busyness}`, hash: hashString(`${GENERATOR_VERSION}/${seed}/${JSON.stringify(loopSettings(given))}`).toString(16).padStart(8, '0') };
  const map = MapDefSchema.parse({
    schemaVersion: 1, id: GENERATED_MAP_ID, source, size: { cols, rows },
    zoneLegend: [...ZONES], zones: rle(w.zones), elevation: rle(w.heights),
    routes: [track.route], speedZones: [], markers: { playerSpawn: w.playerSpawn },
  });
  const scenery = SceneryDefSchema.parse({ schemaVersion: 1, map: map.id, source, kindLegend: [...SCENERY_KINDS], items: w.items, bridges: w.bridges });
  return { map, scenery, minRadiusTiles: track.minRadiusTiles, info: { controlPoints: track.route.points.length, trackAttempts: track.attempts, rivers: w.bridges.length, trackLength: track.route.length, theme, busyness } };
}

/** Scale a count range, keeping a range that was above zero able to roll at least its own share. */
const scaleRange = ([a, b]: readonly [number, number], f: number): [number, number] => [Math.round(a * f), Math.max(Math.round(a * f), Math.round(b * f))];

/** The settings a line is built from: all but the loop's track, so tuning loops leaves line hashes alone. */
function lineSettings(given: MapGenSettings): Omit<MapGenSettings, 'track'> {
  const rest: Partial<MapGenSettings> = { ...given };
  delete rest.track;
  return rest as Omit<MapGenSettings, 'track'>;
}

/** A window's scenery without the tile order. */
function sceneryOf(w: WorldWindow): SceneryDef['items'] {
  const { kind, x, y, size } = w.items;
  return { kind, x, y, size };
}

/** A built chunk, with the east-map tile index of each scenery item so whole-map scenery keeps the G3 order. */
type LineChunk = MapChunk & { order: number[] };

/**
 * The chunks of an open line, built on demand from its plan and kept in a small cache (oldest
 * dropped first). `direction: west` builds the mirrored window of the east line.
 */
class LineChunks implements MapChunks {
  readonly tiles = CHUNK_TILES;
  private cache = new Map<number, LineChunk>();
  /** Chunks built so far, for the measurements. */
  built = 0;
  constructor(private readonly plan: WorldPlan, private readonly west: boolean, private readonly keep = 96) {}

  chunk(cx: number, cy: number): LineChunk {
    const key = cy * 100_003 + cx;
    const have = this.cache.get(key);
    if (have) { this.cache.delete(key); this.cache.set(key, have); return have; }
    const made = this.build(cx, cy);
    this.cache.set(key, made);
    if (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value!);
    return made;
  }

  private build(cx: number, cy: number): LineChunk {
    const T = this.tiles, { cols, rows } = this.plan;
    const zones = new Uint8Array(T * T).fill(ZONE_INDEX.blocked), heights = new Uint8Array(T * T);
    const out: LineChunk = { cx, cy, zones, heights, scenery: { kind: [], x: [], y: [], size: [] }, order: [] };
    const x0 = cx * T, y0 = cy * T;
    const w = Math.min(T, cols - x0), h = Math.min(T, rows - y0);
    if (cx < 0 || cy < 0 || w <= 0 || h <= 0) return out;
    this.built++;
    const ex0 = this.west ? cols - x0 - w : x0;
    const win = buildWindow(this.plan, ex0, y0, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = y * w + (this.west ? w - 1 - x : x);
        zones[y * T + x] = win.zones[from]!; heights[y * T + x] = win.heights[from]!;
      }
    }
    const it = win.items;
    out.scenery = { kind: it.kind, x: this.west ? it.x.map((v) => r4(cols - v)) : it.x, y: it.y, size: it.size };
    out.order = it.order;
    return out;
  }

  /** Not part of the map file. */
  toJSON(): undefined { return undefined; }
}

/** Every tile and scenery item of the map, chunk by chunk; scenery in tile order, as one whole-map pass lays it. */
function wholeMap(cols: number, rows: number, chunks: LineChunks): { zones: [number, number][]; elevation: [number, number][]; items: SceneryDef['items'] } {
  const T = CHUNK_TILES;
  const zones = new Uint8Array(cols * rows), heights = new Uint8Array(cols * rows);
  const all: { order: number; k: number; x: number; y: number; size: number }[] = [];
  for (let cy = 0; cy * T < rows; cy++) {
    for (let cx = 0; cx * T < cols; cx++) {
      const c = chunks.chunk(cx, cy), w = Math.min(T, cols - cx * T);
      for (let y = 0; y < T && cy * T + y < rows; y++) {
        zones.set(c.zones.subarray(y * T, y * T + w), (cy * T + y) * cols + cx * T);
        heights.set(c.heights.subarray(y * T, y * T + w), (cy * T + y) * cols + cx * T);
      }
      c.order.forEach((order, i) => all.push({ order, k: c.scenery.kind[i]!, x: c.scenery.x[i]!, y: c.scenery.y[i]!, size: c.scenery.size[i]! }));
    }
  }
  all.sort((a, b) => a.order - b.order);
  return { zones: rle(zones), elevation: rle(heights), items: { kind: all.map((a) => a.k), x: all.map((a) => a.x), y: all.map((a) => a.y), size: all.map((a) => a.size) } };
}

/**
 * An open line across a long map (`?map=line`, G3): the track grows piece by piece from the west
 * edge to the east one (see line.ts), and the same terrain rules as the loop apply along it. Rivers,
 * cuts and ridges beside the track come in proportion to its length, free-standing ridges to the
 * map's area. One or two town spots get a marker and a flat clearing beside the track.
 *
 * G4: the tiles come in chunks (`map.terrain`), each built from the seed, the settings and its
 * position alone. With `whole` (the default) the map also carries every tile as `zones` and
 * `elevation`, and the scenery lists every item, built chunk by chunk; without it the map has
 * neither and the scenery only its bridges, so nothing is built until a chunk is asked for.
 */
export function generateLine(seed: string, given: MapGenSettings, opts: { whole?: boolean } = {}): GeneratedMap {
  const whole = opts.whole ?? true;
  // With stretches (G10a) each stretch sets its own mix, so the line as a whole picks no theme.
  const stretchesOn = given.line.stretches.enabled;
  const mixed = stretchesOn ? { settings: given, theme: 'balanced' as MapTheme, busyness: 0 } : applyMix(seed, given);
  const { theme, busyness } = mixed;
  const l = given.line;
  const cols = l.lengthTiles, rows = l.widthTiles;
  const track = generateLineTrack(seed, l, cols, rows);
  const trackScale = track.route.length / l.featureTilesPerLoop;
  const areaScale = (cols * rows) / (given.size.cols * given.size.rows);
  const m = mixed.settings;
  const s: MapGenSettings = {
    ...m,
    rivers: { ...m.rivers, count: scaleRange(m.rivers.count, trackScale) },
    mesas: { ...m.mesas, cuts: scaleRange(m.mesas.cuts, trackScale), besideTrack: scaleRange(m.mesas.besideTrack, trackScale), ridges: scaleRange(m.mesas.ridges, areaScale) },
  };
  const plan = planWorld(seed, s, { cols, rows, track, closed: false, trackScale, areaScale, spawnAlong: l.spawnAlong, towns: l.towns, stretches: l.stretches, setPieces: l.setPieces, horseshoes: track.horseshoes });
  applyTrackSpeed(plan, track.route, l.setPieces);
  // `west`: the same line mirrored, so trains run right to left.
  const west = l.direction === 'west';
  const mx = (x: number) => r4(cols - x);
  const route = west ? mirrorRoute(track.route, cols) : track.route;
  const towns = west ? plan.towns.map((t) => ({ ...t, x: mx(t.x), side: (t.side === 1 ? -1 : 1) as 1 | -1 })) : plan.towns.map((t) => ({ ...t }));
  const playerSpawn = west ? { x: mx(plan.playerSpawn.x), y: plan.playerSpawn.y } : plan.playerSpawn;
  const bridges = west ? plan.bridges.map((b) => ({ ...b, x: r4(cols - b.x - b.w) })) : plan.bridges;
  const settings = lineSettings(given);
  const version = `line${LINE_GENERATOR_VERSION}/${GENERATOR_VERSION}`;
  const source = { file: stretchesOn ? `line:${seed} stretches` : `line:${seed} ${theme} ${busyness >= 0 ? '+' : ''}${busyness}`, hash: hashString(`${version}/${seed}/${JSON.stringify(settings)}`).toString(16).padStart(8, '0') };
  const markers: Record<string, Vec> = { playerSpawn };
  for (const t of towns) markers[t.id] = { x: t.x, y: t.y };
  const stretches = plan.stretchPlan ? lineStretches(plan, route.id, west) : undefined;
  const pieces = plan.setPieces.length ? lineSetPieces(plan, route.id, west) : undefined;
  const rims = plan.canyons.length ? plan.canyons.map((c) => ({
    route: route.id, d0: r4(c.i0 * plan.spacing), d1: r4(c.i1 * plan.spacing),
    // Mirrored, the same ground lies on the other side of travel.
    side: (west ? -c.side : c.side) as 1 | -1, inner: c.inner, outer: r4(c.outer), rampTiles: r4(c.ramp * plan.spacing),
  })) : undefined;
  const terrain = new LineChunks(plan, west);
  const built = whole ? wholeMap(cols, rows, terrain) : null;
  const parsed = MapDefSchema.parse({
    schemaVersion: 1, id: LINE_MAP_ID, source, size: { cols, rows },
    zoneLegend: [...ZONES], ...(built ? { zones: built.zones, elevation: built.elevation } : {}),
    routes: [route], speedZones: [], towns, ...(stretches ? { stretches } : {}), ...(pieces ? { setPieces: pieces } : {}), ...(rims ? { rims } : {}), markers,
    openLine: { headwayTiles: l.trainHeadwayTiles, ...(l.trainHeadwaySpreadTiles > 0 ? { headwaySpreadTiles: Math.min(l.trainHeadwaySpreadTiles, l.trainHeadwayTiles * 0.9) } : {}) },
    generated: { generator: LINE_MAP_ID, version, seed, settings, chunkTiles: CHUNK_TILES },
  });
  const map = Object.assign(parsed, { terrain });
  const items = built?.items ?? { kind: [], x: [], y: [], size: [] };
  const scenery = SceneryDefSchema.parse({ schemaVersion: 1, map: map.id, source, kindLegend: [...SCENERY_KINDS], items, bridges });
  return {
    map, scenery, minRadiusTiles: track.minRadiusTiles,
    info: { controlPoints: track.route.points.length, trackAttempts: 1, rivers: plan.bridges.length, trackLength: track.route.length, theme, busyness, pieces: track.pieces, towns: towns.length },
  };
}

/** Where a stretch's sign stands: this far along into it, this far out from the track. */
const SIGN_ALONG_TILES = 12, SIGN_OUT_TILES = 5.5;

/** The map's stretches (see MapDef `stretches`), mirrored on a west line; signs stand on the left of travel. */
function lineStretches(plan: WorldPlan, routeId: string, west: boolean): NonNullable<MapDef['stretches']> {
  const { cols, xs, ys, tangents, spacing, n } = plan;
  const inMap = (i: number) => xs[i]! >= 20 && xs[i]! < cols - 20;
  return plan.stretchPlan!.list.map((st) => {
    // The first sample on the map past its start (the first stretch starts off the map).
    let i = Math.min(n - 1, st.i0 + Math.round(SIGN_ALONG_TILES / spacing));
    while (i < n - 1 && !inMap(i)) i++;
    const tg = tangents[i]!;
    const sx = xs[i]! + tg.y * SIGN_OUT_TILES, sy = ys[i]! - tg.x * SIGN_OUT_TILES;
    const x0 = Math.max(0, st.x0), x1 = Math.min(cols, st.x1);
    return {
      id: `stretch${st.index + 1}`, name: st.name, profile: st.profileId, pace: st.profile.pace, route: routeId,
      d0: r4(st.d0), d1: r4(st.d1),
      x0: r4(west ? cols - x1 : x0), x1: r4(west ? cols - x0 : x1),
      // Mirrored, travel runs west, so the left of travel flips with it and stays on the left.
      sign: west ? { x: r4(cols - (xs[i]! - tg.y * SIGN_OUT_TILES)), y: r4(ys[i]! + tg.x * SIGN_OUT_TILES) } : { x: r4(sx), y: r4(sy) },
    };
  });
}

/**
 * Trains slow on set pieces (G10b): to the grade's speedScale on a grade and the horseshoe's round a
 * bend, easing down and back up over the grade's rampTiles at each end. Writes the route's samples.
 */
function applyTrackSpeed(plan: WorldPlan, route: Route, c: MapGenSettings['line']['setPieces']): void {
  const sc = route.samples.speedScale;
  if (!sc || !plan.setPieces.length) return;
  const ramp = Math.max(1, Math.round(c.grade.rampTiles / plan.spacing));
  for (const q of plan.setPieces) {
    const low = q.kind === 'grade' ? c.grade.speedScale : q.kind === 'horseshoe' ? c.horseshoe.speedScale : 1;
    if (low >= 1) continue;
    for (let i = Math.max(0, q.i0 - ramp); i <= Math.min(sc.length - 1, q.i1 + ramp); i++) {
      const out = i < q.i0 ? (q.i0 - i) / ramp : i > q.i1 ? (i - q.i1) / ramp : 0;
      const u = 1 - out, eased = u * u * (3 - 2 * u);
      sc[i] = Math.min(sc[i]!, r4(1 - (1 - low) * eased));
    }
  }
}

/** Set pieces' signs stand this far before them along the track, this far out on the left of travel. */
const PIECE_SIGN_BEFORE_TILES = 24;
/** A set piece's box reaches this far past its track, so its banner shows as you come up to it. */
const PIECE_BOX_PAD_TILES = 30;

/** The map's set pieces (see MapDef `setPieces`), mirrored on a west line. */
function lineSetPieces(plan: WorldPlan, routeId: string, west: boolean): NonNullable<MapDef['setPieces']> {
  const { cols, xs, ys, tangents, spacing, n } = plan;
  const mx = (x: number) => r4(west ? cols - x : x);
  return plan.setPieces.map((q, k) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = q.i0; i <= q.i1; i++) { x0 = Math.min(x0, xs[i]!); x1 = Math.max(x1, xs[i]!); y0 = Math.min(y0, ys[i]!); y1 = Math.max(y1, ys[i]!); }
    const i = Math.max(0, Math.min(n - 1, q.i0 - Math.round(PIECE_SIGN_BEFORE_TILES / spacing)));
    const tg = tangents[i]!;
    // Left of travel on the east line is (ty, -tx); mirrored, the left flips with travel.
    const sx = xs[i]! + (west ? -1 : 1) * tg.y * SIGN_OUT_TILES, sy = ys[i]! - (west ? -1 : 1) * tg.x * SIGN_OUT_TILES;
    const bx0 = mx(x0 - PIECE_BOX_PAD_TILES), bx1 = mx(x1 + PIECE_BOX_PAD_TILES);
    return {
      id: `piece${k + 1}`, kind: q.kind, name: q.name, route: routeId, d0: r4(q.i0 * spacing), d1: r4(q.i1 * spacing),
      box: { x0: Math.min(bx0, bx1), x1: Math.max(bx0, bx1), y0: r4(y0 - PIECE_BOX_PAD_TILES), y1: r4(y1 + PIECE_BOX_PAD_TILES) },
      sign: { x: mx(sx), y: r4(sy) },
    };
  });
}

/** The route mirrored x to cols - x; it keeps its direction of travel, so it now runs west. */
function mirrorRoute(r: Route, cols: number): Route {
  const mx = (x: number) => r4(cols - x);
  return {
    ...r,
    points: r.points.map((p) => ({ x: mx(p.x), y: p.y })),
    samples: { ...r.samples, x: r.samples.x.map(mx), tx: r.samples.tx.map((t) => r6(-t) + 0) },
  };
}
