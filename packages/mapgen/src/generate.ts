// The procedural map generator (G1 spike): a seed and MapGenSettings in, an ordinary MapDef and
// SceneryDef out, in the same format `tools build-maps` writes from Tiled. Nothing here touches
// the sim; the sim reads the result like any hand-made map.
//
// Order: track loop -> distance to the track for every tile near it -> which side of each stretch
// may hold obstacles -> rivers (each crosses the track once, on a bridge) -> zones from layered
// noise, kept off the cars and out of the open riding lane -> elevation (view only, but cliffs
// block, so it is deterministic too) -> player spawn -> scenery.
import {
  ELEVATION_MAX, MapDefSchema, type MapTheme, SCENERY_KINDS, SceneryDefSchema, ZONES,
  type MapDef, type MapGenSettings, type Route, type SceneryDef, type SceneryKind, type Zone,
} from '@train-robber/config';
import { dcos, dsin, fbm, hash3, hashString, PI, rng } from './dmath';
import { generateLineTrack } from './line';
import { generateTrack, r6, type Track, type Vec } from './track';

/** Bump when a change makes the same seed and settings give a different map. */
export const GENERATOR_VERSION = 4;
/** The map id the game uses for a generated map (`?map=gen`). */
export const GENERATED_MAP_ID = 'gen';
/** The map id of a generated open line (`?map=line`). */
export const LINE_MAP_ID = 'line';
/** Bump when a change makes the same seed and settings give a different open line. */
export const LINE_GENERATOR_VERSION = 2;
/** Levels between neighbours that make a cliff; the higher tile is blocked, as in build-maps. */
const CLIFF_LEVELS = 2;

export interface GeneratedMap {
  map: MapDef;
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

const Z = Object.fromEntries(ZONES.map((z, i) => [z, i])) as Record<Zone, number>;
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
  const w = buildWorld(seed, s, { cols, rows, track, closed: true, trackScale: 1, areaScale: 1, spawnAlong: null, towns: null });
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

/**
 * An open line across a long map (`?map=line`, G3): the track grows piece by piece from the west
 * edge to the east one (see line.ts), and the same terrain rules as the loop apply along it. Rivers,
 * cuts and ridges beside the track come in proportion to its length, free-standing ridges to the
 * map's area. One or two town spots get a marker and a flat clearing beside the track.
 */
export function generateLine(seed: string, given: MapGenSettings): GeneratedMap {
  const mixed = applyMix(seed, given);
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
  const built = buildWorld(seed, s, { cols, rows, track, closed: false, trackScale, areaScale, spawnAlong: l.spawnAlong, towns: l.towns });
  // `west`: the same line mirrored, so trains run right to left.
  const west = l.direction === 'west';
  const w = west ? mirrorWorld(built, cols, rows) : built;
  const route = west ? mirrorRoute(track.route, cols) : track.route;
  const source = { file: `line:${seed} ${theme} ${busyness >= 0 ? '+' : ''}${busyness}`, hash: hashString(`line${LINE_GENERATOR_VERSION}/${GENERATOR_VERSION}/${seed}/${JSON.stringify(lineSettings(given))}`).toString(16).padStart(8, '0') };
  const markers: Record<string, Vec> = { playerSpawn: w.playerSpawn };
  for (const t of w.towns) markers[t.id] = { x: t.x, y: t.y };
  const map = MapDefSchema.parse({
    schemaVersion: 1, id: LINE_MAP_ID, source, size: { cols, rows },
    zoneLegend: [...ZONES], zones: rle(w.zones), elevation: rle(w.heights),
    routes: [route], speedZones: [], towns: w.towns, markers,
    openLine: { headwayTiles: l.trainHeadwayTiles, ...(l.trainHeadwaySpreadTiles > 0 ? { headwaySpreadTiles: Math.min(l.trainHeadwaySpreadTiles, l.trainHeadwayTiles * 0.9) } : {}) },
  });
  const scenery = SceneryDefSchema.parse({ schemaVersion: 1, map: map.id, source, kindLegend: [...SCENERY_KINDS], items: w.items, bridges: w.bridges });
  return {
    map, scenery, minRadiusTiles: track.minRadiusTiles,
    info: { controlPoints: track.route.points.length, trackAttempts: 1, rivers: w.bridges.length, trackLength: track.route.length, theme, busyness, pieces: track.pieces, towns: w.towns.length },
  };
}

/** x to cols - x across the map: zones, heights, scenery, towns and spawn (a town's side flips with the mirror). */
function mirrorWorld(w: World, cols: number, rows: number): World {
  const flip = (a: Uint8Array) => {
    const out = new Uint8Array(a.length);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out[y * cols + x] = a[y * cols + cols - 1 - x]!;
    return out;
  };
  const mx = (x: number) => r4(cols - x);
  return {
    zones: flip(w.zones), heights: flip(w.heights),
    items: { ...w.items, x: w.items.x.map(mx) },
    bridges: w.bridges.map((b) => ({ ...b, x: r4(cols - b.x - b.w) })),
    playerSpawn: { x: mx(w.playerSpawn.x), y: w.playerSpawn.y },
    towns: w.towns.map((t) => ({ ...t, x: mx(t.x), side: (t.side === 1 ? -1 : 1) as 1 | -1 })),
  };
}

/** The route mirrored the same way; it keeps its direction of travel, so it now runs west. */
function mirrorRoute(r: Route, cols: number): Route {
  const mx = (x: number) => r4(cols - x);
  return {
    ...r,
    points: r.points.map((p) => ({ x: mx(p.x), y: p.y })),
    samples: { ...r.samples, x: r.samples.x.map(mx), tx: r.samples.tx.map((t) => r6(-t) + 0) },
  };
}

interface WorldOpts {
  cols: number; rows: number; track: Track;
  /** A loop wraps distances along the track; an open line runs off both ends of the map. */
  closed: boolean;
  /** How many loops' worth of track and of map area this is: placement attempts scale with them. */
  trackScale: number; areaScale: number;
  /** The player starts between these fractions of the way along the track; null anywhere. */
  spawnAlong: readonly [number, number] | null;
  towns: MapGenSettings['line']['towns'] | null;
}

type Town = NonNullable<MapDef['towns']>[number];

interface World {
  zones: Uint8Array; heights: Uint8Array;
  items: { kind: number[]; x: number[]; y: number[]; size: number[] };
  bridges: SceneryDef['bridges'];
  playerSpawn: Vec;
  towns: Town[];
}

/** Terrain, spawn and scenery round a track: shared by the loop and the open line. */
function buildWorld(seed: string, s: MapGenSettings, o: WorldOpts): World {
  const { cols, rows, track, closed } = o;
  const N = cols * rows;
  const salt = (what: string) => hashString(`${seed}/${what}`) & 0xfffff;
  const { route } = track;
  const xs = route.samples.x, ys = route.samples.y;
  const tangents = track.tangents;
  const n = xs.length;
  const L = route.length;
  const spacing = route.spacing;

  // Distance from each tile centre to the nearest sample, within a band round the track.
  const band = Math.ceil(Math.max(
    s.corridor.laneTiles, s.lakes.trackGapTiles, s.rivers.trackGapTiles + s.rivers.widthTiles[1],
    s.hills.trackGapTiles + s.hills.maxLevel * s.hills.tilesPerLevel, s.spawnDistanceTiles,
  )) + 2;
  const d2 = new Float64Array(N).fill(Infinity);
  const near = new Int32Array(N).fill(-1);
  for (let i = 0; i < n; i++) {
    const px = xs[i]!, py = ys[i]!;
    const x0 = Math.max(0, Math.floor(px - band)), x1 = Math.min(cols - 1, Math.floor(px + band));
    const y0 = Math.max(0, Math.floor(py - band)), y1 = Math.min(rows - 1, Math.floor(py + band));
    for (let ty = y0; ty <= y1; ty++) {
      const dy = ty + 0.5 - py;
      for (let tx = x0; tx <= x1; tx++) {
        const dx = tx + 0.5 - px;
        const dd = dx * dx + dy * dy;
        const t = ty * cols + tx;
        if (dd < d2[t]!) { d2[t] = dd; near[t] = i; }
      }
    }
  }
  const dist = (t: number) => (near[t]! < 0 ? Infinity : Math.sqrt(d2[t]!));
  /** +1 or -1: which side of the track the tile is on (+1 is the checks' side +1, right of travel on screen). */
  const sideOf = (t: number) => {
    const i = near[t]!;
    const x = t % cols, y = (t - x) / cols;
    const tg = tangents[i]!;
    return tg.x * (y + 0.5 - ys[i]!) - tg.y * (x + 0.5 - xs[i]!) >= 0 ? 1 : -1;
  };
  const distAt = (p: Vec) => {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    return x < 0 || y < 0 || x >= cols || y >= rows ? Infinity : dist(y * cols + x);
  };

  // Stretches: each keeps its obstacles on one side (or has none), with both sides open between.
  // Some lay a strip of mud or a broken line of rocks along their obstacle side, as on the extra maps.
  interface Stretch { side: number; strip: number | null; inner: number; outer: number }
  const stretches: Stretch[] = [];
  const stretchOf = new Int32Array(n).fill(-1);
  {
    const r = rng(`${seed}/corridor`);
    const c = s.corridor;
    const gap = c.switchGapTiles;
    let pos = gap / 2;
    while (pos < L - gap) {
      const len = r.range(c.stretchTiles[0], c.stretchTiles[1]);
      const side = r.next() < c.bothOpenChance ? 0 : r.next() < 0.5 ? -1 : 1;
      const roll = r.next();
      const strip = side === 0 || roll >= c.stripChance ? null : r.next() < 0.5 ? Z.slow : Z.blocked;
      const inner = c.carClearTiles + r.range(0, 1.5);
      stretches.push({ side, strip, inner, outer: inner + r.range(c.stripWidthTiles[0], c.stripWidthTiles[1]) });
      const end = Math.min(pos + len, L - gap / 2);
      for (let i = Math.ceil(pos / spacing); i < n && i * spacing < end; i++) stretchOf[i] = stretches.length - 1;
      pos = end + gap;
    }
  }
  const stretchAt = (t: number): Stretch | null => (near[t]! < 0 || stretchOf[near[t]!]! < 0 ? null : stretches[stretchOf[near[t]!]!]!);
  const sDist = closed ? (a: number, b: number) => { const d = Math.abs(a - b) % L; return Math.min(d, L - d); } : (a: number, b: number) => Math.abs(a - b);
  /** Sample `j` on a loop wraps; on an open line it is -1 past either end. */
  const wrapIdx = (j: number) => (closed ? ((j % n) + n) % n : j < 0 || j >= n ? -1 : j);
  /** A loop's samples are all on the map; a line's run off both ends, so picks keep 40 tiles in. */
  const inMap = (i: number) => closed || (xs[i]! >= 40 && xs[i]! < cols - 40);

  // Rivers: each crosses the track once, square to it where the track runs along x or y, on a bridge.
  const river = new Uint8Array(N); // 0 dry, 1 water, 2 deep
  const riverDist = new Float64Array(N).fill(Infinity); // distance past the river's edge, for hills
  const deck = new Uint8Array(N);
  const bridges: SceneryDef['bridges'] = [];
  {
    const r = rng(`${seed}/rivers`);
    const count = r.int(s.rivers.count[0], s.rivers.count[1]);
    const crossings: number[] = [];
    // Fords: shallow places every so often along a river, where the deep middle can be waded.
    const fords: { x: number; y: number; radius: number }[] = [];
    const stamp = (p: Vec, half: number) => {
      const reach = half + s.hills.maxLevel * s.hills.tilesPerLevel + 1;
      const x0 = Math.max(0, Math.floor(p.x - reach)), x1 = Math.min(cols - 1, Math.floor(p.x + reach));
      const y0 = Math.max(0, Math.floor(p.y - reach)), y1 = Math.min(rows - 1, Math.floor(p.y + reach));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const t = ty * cols + tx;
          const dd = Math.sqrt((tx + 0.5 - p.x) * (tx + 0.5 - p.x) + (ty + 0.5 - p.y) * (ty + 0.5 - p.y));
          if (dd - half < riverDist[t]!) riverDist[t] = dd - half;
          if (dd < half) river[t] = Math.max(river[t]!, dd < half - 1.2 && half >= 2 ? 2 : 1);
        }
      }
    };
    for (let attempt = 0; attempt < 60 * Math.max(1, Math.ceil(o.trackScale)) && crossings.length < count; attempt++) {
      const i = r.int(0, n - 1);
      if (!inMap(i)) continue;
      const tg = tangents[i]!;
      const alongX = Math.abs(tg.x) >= 0.97, alongY = Math.abs(tg.y) >= 0.97;
      if (!alongX && !alongY) continue;
      if (crossings.some((c) => sDist(c * spacing, i * spacing) < s.rivers.spacingTiles)) continue;
      crossings.push(i);
      const half = r.range(s.rivers.widthTiles[0], s.rivers.widthTiles[1]) / 2;
      const c = { x: xs[i]!, y: ys[i]! };
      for (const dir of [1, -1]) {
        let heading = alongX ? (dir > 0 ? PI / 2 : -PI / 2) : dir > 0 ? 0 : PI;
        let bend = 0;
        const p = { ...c };
        const len = r.range(s.rivers.lengthTiles[0], s.rivers.lengthTiles[1]);
        let k = 0, ended = false, nextFord = r.range(s.rivers.fordSpacingTiles[0], s.rivers.fordSpacingTiles[1]);
        stamp(p, half);
        for (; k < len; k++) {
          if (k >= nextFord) { fords.push({ x: p.x, y: p.y, radius: Math.max(s.rivers.fordWidthTiles / 2, half) }); nextFord = k + r.range(s.rivers.fordSpacingTiles[0], s.rivers.fordSpacingTiles[1]); }
          if (k > s.rivers.straightTiles) {
            bend += (r.next() - 0.5) * s.rivers.meander;
            bend = Math.max(-s.rivers.meander, Math.min(s.rivers.meander, bend));
            heading += bend;
          }
          const next = { x: p.x + dcos(heading), y: p.y + dsin(heading) };
          if (next.x < -half || next.y < -half || next.x > cols + half || next.y > rows + half) { ended = true; break; }
          if (k > s.rivers.straightTiles && distAt(next) < s.rivers.trackGapTiles + half) { ended = true; break; }
          p.x = next.x; p.y = next.y;
          stamp(p, half);
        }
        // A river that runs its length inland ends in a pond, kept clear of the track.
        if (!ended) {
          const room = distAt(p) - s.rivers.trackGapTiles;
          const radius = Math.min(r.range(half * 2, half * 4), room);
          if (radius > half) {
            for (let a = -radius + half; a <= radius - half; a += 1) {
              for (let b = -radius + half; b <= radius - half; b += 1) {
                if (a * a + b * b <= (radius - half) * (radius - half)) stamp({ x: p.x + a, y: p.y + b }, half);
              }
            }
          }
        }
      }
      // The deck: every river tile under the cars near this crossing, as a rectangle painted open.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let t = 0; t < N; t++) {
        if (!river[t] || near[t]! < 0 || d2[t]! >= s.corridor.carClearTiles * s.corridor.carClearTiles) continue;
        if (sDist(near[t]! * spacing, i * spacing) > 30) continue;
        const x = t % cols, y = (t - x) / cols;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      if (minX === Infinity) continue;
      if (alongX) { minX -= 1; maxX += 1; } else { minY -= 1; maxY += 1; }
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (x >= 0 && y >= 0 && x < cols && y < rows) deck[y * cols + x] = 1;
      bridges.push({ x: minX, y: minY, w: maxX + 1 - minX, h: maxY + 1 - minY, along: alongX ? 'x' : 'y' });
      // No mud or rocks either side near a bridge: the lanes there are the river.
      for (let j = 0; j < n; j++) if (sDist(j * spacing, i * spacing) < half + 16) stretchOf[j] = -1;
    }
    for (const f of fords) {
      const x0 = Math.max(0, Math.floor(f.x - f.radius)), x1 = Math.min(cols - 1, Math.floor(f.x + f.radius));
      const y0 = Math.max(0, Math.floor(f.y - f.radius)), y1 = Math.min(rows - 1, Math.floor(f.y + f.radius));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const t = ty * cols + tx;
          if (river[t] === 2 && (tx + 0.5 - f.x) * (tx + 0.5 - f.x) + (ty + 0.5 - f.y) * (ty + 0.5 - f.y) <= f.radius * f.radius) river[t] = 1;
        }
      }
    }
  }

  // Town spots (open line only): a flat clearing beside the track, clear of rivers, with both lanes
  // open past it. Hills ramp down to the clearing and nothing grows in it.
  const towns: Town[] = [];
  if (o.towns) {
    const c = o.towns, r = rng(`${seed}/towns`);
    const count = r.int(c.count[0], c.count[1]);
    const reach = c.gapTiles + c.clearingRadiusTiles;
    for (let attempt = 0; attempt < 40 && towns.length < count; attempt++) {
      const i = Math.round(r.range(c.along[0], c.along[1]) * (n - 1));
      if (!inMap(i) || towns.some((t) => Math.abs(t.d - i * spacing) < c.minGapTiles)) continue;
      const first: 1 | -1 = r.next() < 0.5 ? -1 : 1;
      for (const side of [first, first === 1 ? -1 : 1] as const) {
        const tg = tangents[i]!;
        const x = xs[i]! - tg.y * reach * side, y = ys[i]! + tg.x * reach * side;
        if (y < c.clearingRadiusTiles + s.edgeTiles + 2 || y > rows - c.clearingRadiusTiles - s.edgeTiles - 2) continue;
        // Clear of every river and bridge, with room to spare.
        let wet = false;
        for (let dy = -c.clearingRadiusTiles - 4; dy <= c.clearingRadiusTiles + 4 && !wet; dy++) {
          for (let dx = -c.clearingRadiusTiles - 4; dx <= c.clearingRadiusTiles + 4 && !wet; dx++) {
            const tx = Math.floor(x + dx), ty = Math.floor(y + dy);
            if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
            const t = ty * cols + tx;
            if (river[t] || deck[t]) wet = true;
          }
        }
        if (wet) continue;
        towns.push({ id: `town${towns.length + 1}`, route: route.id, d: r4(i * spacing), x: r4(x), y: r4(y), side, radiusTiles: c.clearingRadiusTiles });
        // Both lanes open along the station.
        for (let j = 0; j < n; j++) if (Math.abs(j - i) * spacing < reach + 30) stretchOf[j] = -1;
        break;
      }
    }
    towns.sort((a, b) => a.d - b.d);
    towns.forEach((t, k) => { t.id = `town${k + 1}`; });
  }
  /** Tiles from the edge of the nearest town clearing (negative inside), or Infinity with none. */
  const townGap = (cx: number, cy: number) => {
    let best = Infinity;
    for (const t of towns) best = Math.min(best, Math.sqrt((cx - t.x) * (cx - t.x) + (cy - t.y) * (cy - t.y)) - t.radiusTiles);
    return best;
  };

  // Long mesas, stamped as shapes on top of the noise clumps: free-standing ridges, ridges that run
  // beside the track, and cuts where the track runs through a long mesa between two cliff walls.
  const mesaMask = new Uint8Array(N);
  {
    const m = s.mesas, r = rng(`${seed}/mesas`);
    const put = (x: number, y: number, minD: number) => {
      const tx = Math.floor(x), ty = Math.floor(y);
      for (const [ax, ay] of [[tx, ty], [tx + 1, ty], [tx, ty + 1]] as const) {
        if (ax < 0 || ay < 0 || ax >= cols || ay >= rows) continue;
        const t = ay * cols + ax;
        if (deck[t] || riverDist[t]! <= 3 || dist(t) < minD || townGap(ax + 0.5, ay + 0.5) < 4) continue;
        mesaMask[t] = 1;
      }
    };
    /** A band beside the track from sample `i` for `len` tiles, `gap` to `gap + width` out on `side`, rounded at the ends. */
    const alongTrack = (i: number, len: number, side: number, gap: number, width: number) => {
      const steps = Math.floor(len / spacing);
      for (let k = 0; k <= steps; k++) {
        const j = wrapIdx(i + k), u = (2 * k) / steps - 1;
        if (j < 0) break;
        const w = width * Math.sqrt(Math.max(0, 1 - u * u * u * u));
        const tg = tangents[j]!;
        for (let o = gap; o <= gap + w; o += 0.5) put(xs[j]! - tg.y * o * side, ys[j]! + tg.x * o * side, gap - 0.5);
      }
    };
    // Cuts: the track runs through a long mesa, cliffs both sides just outside the riding lanes.
    const cuts = r.int(m.cuts[0], m.cuts[1]);
    const used: number[] = [];
    for (let attempt = 0; attempt < 40 * Math.max(1, Math.ceil(o.trackScale)) && used.length < cuts; attempt++) {
      const i = r.int(0, n - 1);
      const len = r.range(m.cutLengthTiles[0], m.cutLengthTiles[1]);
      const mid = i * spacing + len / 2;
      if (used.some((u) => sDist(u, mid) < len + 40)) continue;
      // Not across a river or a town: every sample in the cut must be well clear of water and on the map.
      let wet = false;
      for (let k = 0; k * spacing <= len && !wet; k++) {
        const j = wrapIdx(i + k);
        if (j < 0 || !inMap(j)) { wet = true; break; }
        const t = Math.floor(ys[j]!) * cols + Math.floor(xs[j]!);
        if (riverDist[t]! < 12 || townGap(xs[j]!, ys[j]!) < 30) wet = true;
      }
      if (wet) continue;
      used.push(mid);
      for (const side of [-1, 1]) alongTrack(i, len, side, m.cutGapTiles, r.range(m.cutDepthTiles[0], m.cutDepthTiles[1]));
      // Both lanes open through the cut: no mud bank or rock line inside it.
      for (let k = -Math.ceil(10 / spacing); k * spacing <= len + 10; k++) { const j = wrapIdx(i + k); if (j >= 0) stretchOf[j] = -1; }
    }
    // Ridges that run beside the track, further out.
    const beside = r.int(m.besideTrack[0], m.besideTrack[1]);
    for (let k = 0; k < beside; k++) {
      alongTrack(r.int(0, n - 1), r.range(m.ridgeLengthTiles[0], m.ridgeLengthTiles[1]), r.next() < 0.5 ? -1 : 1,
        r.range(m.besideGapTiles[0], m.besideGapTiles[1]), r.range(m.ridgeWidthTiles[0], m.ridgeWidthTiles[1]));
    }
    // Free-standing ridges: a gently bending line of rock anywhere clear of the track.
    const ridges = r.int(m.ridges[0], m.ridges[1]);
    for (let k = 0; k < ridges; k++) {
      let x = r.range(0, cols), y = r.range(0, rows), heading = r.next() * 2 * PI, bend = 0;
      const len = r.range(m.ridgeLengthTiles[0], m.ridgeLengthTiles[1]), half = r.range(m.ridgeWidthTiles[0], m.ridgeWidthTiles[1]) / 2;
      for (let step = 0; step < len; step++) {
        const u = (2 * step) / len - 1, w = half * Math.sqrt(Math.max(0, 1 - u * u * u * u));
        for (let a = -w; a <= w; a += 0.5) put(x - dsin(heading) * a, y + dcos(heading) * a, m.trackGapTiles);
        bend = Math.max(-0.03, Math.min(0.03, bend + (r.next() - 0.5) * 0.02));
        heading += bend;
        x += dcos(heading); y += dsin(heading);
      }
    }
  }

  // Zones and elevation.
  const zones = new Uint8Array(N);
  const heights = new Uint8Array(N);
  const forest = new Uint8Array(N);
  const sMud = salt('mud'), sRock = salt('rocks'), sForest = salt('forest'), sLake = salt('lakes'), sHill = salt('hills'), sStrip = salt('strips'), sMesa = salt('mesas'), sMesaTop = salt('mesa-tops');
  for (let t = 0; t < N; t++) {
    const x = t % cols, y = (t - x) / cols;
    const cx = x + 0.5, cy = y + 0.5;
    const d = dist(t);
    // Hills: quantised noise, held at 0 near the track and rivers and ramped up a level per few tiles.
    const hn = fbm(cx, cy, s.hills.scaleTiles, sHill);
    let level = hn > s.hills.threshold ? Math.floor(((hn - s.hills.threshold) / (1 - s.hills.threshold)) * (s.hills.maxLevel + 1)) : 0;
    level = Math.min(level, s.hills.maxLevel, ELEVATION_MAX);
    // Lakes lie in hollows: no hills where the lake noise is near its threshold.
    const lake = fbm(cx, cy, s.lakes.scaleTiles, sLake);
    if (lake > s.lakes.threshold - 0.04) level = 0;
    if (d < Infinity) level = Math.min(level, Math.max(0, Math.floor((d - s.hills.trackGapTiles) / s.hills.tilesPerLevel)));
    level = Math.min(level, Math.max(0, Math.floor(riverDist[t]! / s.hills.tilesPerLevel)));
    if (deck[t]) level = 0;
    const toTown = towns.length ? townGap(cx, cy) : Infinity;
    if (toTown < Infinity) level = Math.min(level, Math.max(0, Math.floor(toTown / s.hills.tilesPerLevel)));
    heights[t] = level;

    // A line enters and leaves through the west and east edges, so only a loop blocks those.
    if ((closed && (x < s.edgeTiles || x >= cols - s.edgeTiles)) || y < s.edgeTiles || y >= rows - s.edgeTiles) { zones[t] = Z.blocked; continue; }
    if (toTown < 0) { zones[t] = Z.open; continue; }
    // Mesas: sandstone plateaus that rise by a cliff all round (drawn by iso/mesa.ts), on rock.
    if ((mesaMask[t] || (fbm(cx, cy, s.mesas.scaleTiles, sMesa) > s.mesas.threshold && d > s.mesas.trackGapTiles)) && riverDist[t]! > 3 && lake <= s.lakes.threshold - 0.04) {
      const [lo, hi] = s.mesas.topLevels;
      heights[t] = Math.min(hi, lo + Math.floor(fbm(cx, cy, 40, sMesaTop) * (hi - lo + 1)));
      zones[t] = Z.blocked;
      continue;
    }
    if (deck[t] || d < s.corridor.carClearTiles) { zones[t] = Z.open; continue; }
    if (river[t]) { zones[t] = river[t] === 2 && d >= s.corridor.laneTiles + 1 ? Z.deep : Z.water; continue; }
    const st = stretchAt(t);
    const obstacleSide = st !== null && st.side !== 0 && st.side === sideOf(t);
    if (d < s.corridor.laneTiles && !obstacleSide) { zones[t] = Z.open; continue; }
    if (obstacleSide && st.strip !== null && d >= st.inner && d < st.outer) {
      // Rocks come as a broken line, mud as a solid bank.
      if (st.strip === Z.slow || fbm(cx, cy, 3, sStrip) > 0.45) { zones[t] = st.strip; continue; }
    }
    if (lake > s.lakes.threshold && d > s.lakes.trackGapTiles) {
      zones[t] = lake > s.lakes.deepThreshold && d > s.lakes.trackGapTiles + 2 ? Z.deep : Z.water;
      continue;
    }
    if (fbm(cx, cy, s.forest.scaleTiles, sForest) > s.forest.threshold) { zones[t] = Z.blocked; forest[t] = 1; continue; }
    if (fbm(cx, cy, s.rocks.scaleTiles, sRock) > s.rocks.threshold) { zones[t] = Z.blocked; continue; }
    zones[t] = fbm(cx, cy, s.mud.scaleTiles, sMud) > s.mud.threshold ? Z.slow : Z.open;
  }
  // Cliffs: the top of a two-level drop is blocked, as build-maps does for Tiled maps.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = y * cols + x, h = heights[t]!;
      if (h < CLIFF_LEVELS) continue;
      if ((x > 0 && h - heights[t - 1]! >= CLIFF_LEVELS) || (x < cols - 1 && h - heights[t + 1]! >= CLIFF_LEVELS)
        || (y > 0 && h - heights[t - cols]! >= CLIFF_LEVELS) || (y < rows - 1 && h - heights[t + cols]! >= CLIFF_LEVELS)) zones[t] = Z.blocked;
    }
  }

  // Spawn: on the open side of a stretch, spawnDistanceTiles out, with a clear path to the track.
  const spawn = (() => {
    const r = rng(`${seed}/spawn`);
    const pathTiles = (i: number, side: number) => {
      const tg = tangents[i]!;
      const out: number[] = [];
      for (let k = 0; k <= s.spawnDistanceTiles; k += 0.5) {
        for (const w of [-1, 0, 1]) {
          const px = xs[i]! - tg.y * k * side + tg.x * w, py = ys[i]! + tg.x * k * side + tg.y * w;
          out.push(Math.floor(py) * cols + Math.floor(px));
        }
      }
      return out;
    };
    let first: { i: number; side: number } | null = null;
    const [lo, hi] = o.spawnAlong ? [Math.round(o.spawnAlong[0] * (n - 1)), Math.round(o.spawnAlong[1] * (n - 1))] : [0, n - 1];
    for (let attempt = 0; attempt < 40; attempt++) {
      const i = r.int(lo, hi);
      const st = stretchOf[i]! < 0 ? null : stretches[stretchOf[i]!]!;
      const side = !st || st.side === 0 ? (r.next() < 0.5 ? -1 : 1) : -st.side;
      first ??= { i, side };
      if (pathTiles(i, side).every((t) => zones[t] === Z.open)) return { i, side };
    }
    // Clear a three-tile path from the first pick instead.
    for (const t of pathTiles(first!.i, first!.side)) { zones[t] = Z.open; forest[t] = 0; }
    return first!;
  })();
  const tg = tangents[spawn.i]!;
  const playerSpawn = {
    x: r4(Math.floor(xs[spawn.i]! - tg.y * s.spawnDistanceTiles * spawn.side) + 0.5),
    y: r4(Math.floor(ys[spawn.i]! + tg.x * s.spawnDistanceTiles * spawn.side) + 0.5),
  };

  // Scenery (render only): trees on forest tiles, bushes and flowers scattered on open ground.
  const items = { kind: [] as number[], x: [] as number[], y: [] as number[], size: [] as number[] };
  const add = (kind: SceneryKind, x: number, y: number, size: number) => {
    items.kind.push(SCENERY_KINDS.indexOf(kind)); items.x.push(r4(x)); items.y.push(r4(y)); items.size.push(r4(size));
  };
  const sItems = salt('scenery'), sGround = salt('ground');
  for (let t = 0; t < N; t++) {
    const x = t % cols, y = (t - x) / cols;
    if (forest[t] && zones[t] === Z.blocked) {
      if (hash3(t, 0, sItems) >= s.forest.treesPerTile) continue;
      add(hash3(t, 1, sItems) < s.forest.pineShare ? 'pine' : 'tree', x + 0.15 + 0.7 * hash3(t, 2, sItems), y + 0.15 + 0.7 * hash3(t, 3, sItems), 0.8 + 0.45 * hash3(t, 4, sItems));
    } else if (zones[t] === Z.open && dist(t) > s.corridor.laneTiles + 1 && !(towns.length && townGap(x + 0.5, y + 0.5) < 2)) {
      const g = fbm(x + 0.5, y + 0.5, s.ground.scaleTiles, sGround) * 2;
      if (hash3(t, 5, sItems) < s.ground.bushesPerTile * g) add('bush', x + 0.15 + 0.7 * hash3(t, 6, sItems), y + 0.15 + 0.7 * hash3(t, 7, sItems), 0.8 + 0.45 * hash3(t, 8, sItems));
      else if (hash3(t, 9, sItems) < s.ground.flowersPerTile * g) add('flowers', x + 0.15 + 0.7 * hash3(t, 10, sItems), y + 0.15 + 0.7 * hash3(t, 11, sItems), 0.8 + 0.45 * hash3(t, 12, sItems));
    }
  }
  return { zones, heights, items, bridges, playerSpawn, towns };
}
