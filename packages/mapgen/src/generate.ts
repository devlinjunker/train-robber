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
  type MapDef, type MapGenSettings, type SceneryDef, type SceneryKind, type Zone,
} from '@train-robber/config';
import { dcos, dsin, fbm, hash3, hashString, PI, rng } from './dmath';
import { generateTrack, type Vec } from './track';

/** Bump when a change makes the same seed and settings give a different map. */
export const GENERATOR_VERSION = 4;
/** The map id the game uses for a generated map (`?map=gen`). */
export const GENERATED_MAP_ID = 'gen';
/** Levels between neighbours that make a cliff; the higher tile is blocked, as in build-maps. */
const CLIFF_LEVELS = 2;

export interface GeneratedMap {
  map: MapDef;
  scenery: SceneryDef;
  /** Tightest curve, for the checks and the debug panel. */
  minRadiusTiles: number;
  info: { controlPoints: number; trackAttempts: number; rivers: number; trackLength: number; theme: MapTheme; busyness: number };
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

export function generateMap(seed: string, given: MapGenSettings): GeneratedMap {
  const { settings: s, theme, busyness } = applyMix(seed, given);
  const { cols, rows } = s.size;
  const N = cols * rows;
  const salt = (what: string) => hashString(`${seed}/${what}`) & 0xfffff;
  const track = generateTrack(rng(`${seed}/track`), cols, rows, s.track);
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
  const sDist = (a: number, b: number) => { const d = Math.abs(a - b) % L; return Math.min(d, L - d); };

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
    for (let attempt = 0; attempt < 60 && crossings.length < count; attempt++) {
      const i = r.int(0, n - 1);
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
        if (deck[t] || riverDist[t]! <= 3 || dist(t) < minD) continue;
        mesaMask[t] = 1;
      }
    };
    /** A band beside the track from sample `i` for `len` tiles, `gap` to `gap + width` out on `side`, rounded at the ends. */
    const alongTrack = (i: number, len: number, side: number, gap: number, width: number) => {
      const steps = Math.floor(len / spacing);
      for (let k = 0; k <= steps; k++) {
        const j = (i + k) % n, u = (2 * k) / steps - 1;
        const w = width * Math.sqrt(Math.max(0, 1 - u * u * u * u));
        const tg = tangents[j]!;
        for (let o = gap; o <= gap + w; o += 0.5) put(xs[j]! - tg.y * o * side, ys[j]! + tg.x * o * side, gap - 0.5);
      }
    };
    // Cuts: the track runs through a long mesa, cliffs both sides just outside the riding lanes.
    const cuts = r.int(m.cuts[0], m.cuts[1]);
    const used: number[] = [];
    for (let attempt = 0; attempt < 40 && used.length < cuts; attempt++) {
      const i = r.int(0, n - 1);
      const len = r.range(m.cutLengthTiles[0], m.cutLengthTiles[1]);
      const mid = i * spacing + len / 2;
      if (used.some((u) => sDist(u, mid) < len + 40)) continue;
      // Not across a river: every sample in the cut must be well clear of water.
      let wet = false;
      for (let k = 0; k * spacing <= len && !wet; k++) {
        const j = (i + k) % n;
        const t = Math.floor(ys[j]!) * cols + Math.floor(xs[j]!);
        if (riverDist[t]! < 12) wet = true;
      }
      if (wet) continue;
      used.push(mid);
      for (const side of [-1, 1]) alongTrack(i, len, side, m.cutGapTiles, r.range(m.cutDepthTiles[0], m.cutDepthTiles[1]));
      // Both lanes open through the cut: no mud bank or rock line inside it.
      for (let k = -Math.ceil(10 / spacing); k * spacing <= len + 10; k++) stretchOf[(i + k + n) % n] = -1;
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
    heights[t] = level;

    if (x < s.edgeTiles || y < s.edgeTiles || x >= cols - s.edgeTiles || y >= rows - s.edgeTiles) { zones[t] = Z.blocked; continue; }
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
    for (let attempt = 0; attempt < 40; attempt++) {
      const i = r.int(0, n - 1);
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

  // The file names the seed, then the theme and busyness it picked, for the debug panel.
  const source = { file: `gen:${seed} ${theme} ${busyness >= 0 ? '+' : ''}${busyness}`, hash: hashString(`${GENERATOR_VERSION}/${seed}/${JSON.stringify(given)}`).toString(16).padStart(8, '0') };
  const map = MapDefSchema.parse({
    schemaVersion: 1, id: GENERATED_MAP_ID, source, size: { cols, rows },
    zoneLegend: [...ZONES], zones: rle(zones), elevation: rle(heights),
    routes: [route], speedZones: [], markers: { playerSpawn },
  });

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
    } else if (zones[t] === Z.open && dist(t) > s.corridor.laneTiles + 1) {
      const g = fbm(x + 0.5, y + 0.5, s.ground.scaleTiles, sGround) * 2;
      if (hash3(t, 5, sItems) < s.ground.bushesPerTile * g) add('bush', x + 0.15 + 0.7 * hash3(t, 6, sItems), y + 0.15 + 0.7 * hash3(t, 7, sItems), 0.8 + 0.45 * hash3(t, 8, sItems));
      else if (hash3(t, 9, sItems) < s.ground.flowersPerTile * g) add('flowers', x + 0.15 + 0.7 * hash3(t, 10, sItems), y + 0.15 + 0.7 * hash3(t, 11, sItems), 0.8 + 0.45 * hash3(t, 12, sItems));
    }
  }
  const scenery = SceneryDefSchema.parse({ schemaVersion: 1, map: map.id, source, kindLegend: [...SCENERY_KINDS], items, bridges });
  return { map, scenery, minRadiusTiles: track.minRadiusTiles, info: { controlPoints: route.points.length, trackAttempts: track.attempts, rivers: bridges.length, trackLength: route.length, theme, busyness } };
}
