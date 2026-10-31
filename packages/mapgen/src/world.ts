// Terrain, spawn and scenery round a track, in two steps (G4):
//
// 1. `planWorld` lays out everything that is not per tile, from the seed alone: the track's samples
//    in a spatial index, the stretches, the rivers as stamps, the fords, the bridges, the towns, the
//    mesa ridges as stamps, and the player spawn. It never fills a whole-map grid.
// 2. `buildWindow` works out the tiles of any rectangle (zones, heights, forest, scenery) from the
//    plan and the tiles' positions alone, so a chunk can be built without building the map.
//
// A window gives exactly the tiles a whole-map pass gives (the G3 generator did one pass over every
// tile; a test checks the chunks against the whole map). Deterministic maths only (see dmath.ts).
import { ELEVATION_MAX, SCENERY_KINDS, ZONES, type MapGenSettings, type SceneryDef, type SceneryKind, type Zone } from '@train-robber/config';
import { dcos, dsin, fbm, hash3, hashString, PI, rng } from './dmath';
import type { Track, Vec } from './track';

/** Levels between neighbours that make a cliff; the higher tile is blocked, as in build-maps. */
const CLIFF_LEVELS = 2;
const Z = Object.fromEntries(ZONES.map((z, i) => [z, i])) as Record<Zone, number>;
export const ZONE_INDEX = Z;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export interface WorldOpts {
  cols: number; rows: number; track: Track;
  /** A loop wraps distances along the track; an open line runs off both ends of the map. */
  closed: boolean;
  /** How many loops' worth of track and of map area this is: placement attempts scale with them. */
  trackScale: number; areaScale: number;
  /** The player starts between these fractions of the way along the track; null anywhere. */
  spawnAlong: readonly [number, number] | null;
  towns: MapGenSettings['line']['towns'] | null;
}

/** A town's place: a flat clearing beside the track (towns.ts makes it a town). */
export interface TownSpot { id: string; route: string; d: number; x: number; y: number; side: 1 | -1; radiusTiles: number }

interface Stretch { side: number; strip: number | null; inner: number; outer: number }

/** Ids of things filed by the cells (of `cell` tiles) their box touches. */
class CellIndex {
  private cells = new Map<number, number[]>();
  private seen: Int32Array = new Int32Array(0);
  private query = 0;
  count = 0;
  constructor(readonly cell: number) {}
  private static key(bx: number, by: number) { return bx * 100_003 + by; }
  /** File `id` under every cell the tile box [x0, x1] x [y0, y1] touches. */
  add(id: number, x0: number, y0: number, x1: number, y1: number): void {
    const c = this.cell;
    for (let by = Math.floor(y0 / c); by <= Math.floor(y1 / c); by++) {
      for (let bx = Math.floor(x0 / c); bx <= Math.floor(x1 / c); bx++) {
        const k = CellIndex.key(bx, by);
        const list = this.cells.get(k);
        if (list) list.push(id); else this.cells.set(k, [id]);
      }
    }
    this.count = Math.max(this.count, id + 1);
  }
  /** Every id filed under a cell the tile box touches, once each, in ascending order. */
  find(x0: number, y0: number, x1: number, y1: number): number[] {
    if (this.seen.length < this.count) this.seen = new Int32Array(Math.max(this.count, this.seen.length * 2));
    const q = ++this.query;
    const out: number[] = [];
    const c = this.cell;
    for (let by = Math.floor(y0 / c); by <= Math.floor(y1 / c); by++) {
      for (let bx = Math.floor(x0 / c); bx <= Math.floor(x1 / c); bx++) {
        const list = this.cells.get(CellIndex.key(bx, by));
        if (!list) continue;
        for (const id of list) if (this.seen[id] !== q) { this.seen[id] = q; out.push(id); }
      }
    }
    return out.sort((a, b) => a - b);
  }
}

/** Everything about a world that is not per tile; see the file comment. */
export interface WorldPlan {
  seed: string; s: MapGenSettings; cols: number; rows: number; closed: boolean;
  xs: readonly number[]; ys: readonly number[]; tangents: readonly Vec[]; n: number; spacing: number;
  /** Tiles within this square distance of a sample get their distance to the track. */
  band: number;
  sampleIndex: CellIndex;
  stretches: Stretch[]; stretchOf: Int32Array;
  /** River stamps: a disc of `half` round (x, y); `tag` is the crossing it belongs to. */
  stamps: { x: number[]; y: number[]; half: number[]; tag: number[] }; stampIndex: CellIndex;
  fords: { x: number; y: number; radius: number }[]; fordIndex: CellIndex;
  bridges: SceneryDef['bridges'];
  towns: TownSpot[];
  /** Mesa stamps: each marks up to three tiles from (x, y) that are at least minD from the track. */
  puts: { x: number[]; y: number[]; minD: number[] }; putIndex: CellIndex;
  /** Tiles forced open on the way from the spawn to the track. */
  spawnClear: ReadonlySet<number>;
  playerSpawn: Vec;
  salts: { mud: number; rocks: number; forest: number; lakes: number; hills: number; strips: number; mesas: number; mesaTops: number; scenery: number; ground: number };
}

const SAMPLE_CELL = 16, STAMP_CELL = 32, PUT_CELL = 32;

/** The tiles of a window, row-major; `items` are its scenery, `order` the tile index each sits on. */
export interface WorldWindow {
  x0: number; y0: number; w: number; h: number;
  zones: Uint8Array; heights: Uint8Array;
  items: { kind: number[]; x: number[]; y: number[]; size: number[]; order: number[] };
}

/** Nearest track sample to each tile of a box, as the whole-map pass finds it: only samples within `band` (square) count, ties go to the earlier sample. */
function nearestIn(p: WorldPlan, x0: number, y0: number, w: number, h: number): { d2: Float64Array; near: Int32Array } {
  const d2 = new Float64Array(w * h).fill(Infinity);
  const near = new Int32Array(w * h).fill(-1);
  const { band, xs, ys, cols, rows } = p;
  const x1 = x0 + w - 1, y1 = y0 + h - 1;
  for (const i of p.sampleIndex.find(x0 - band - 1, y0 - band - 1, x1 + band + 1, y1 + band + 1)) {
    const px = xs[i]!, py = ys[i]!;
    const ax = Math.max(x0, 0, Math.floor(px - band)), bx = Math.min(x1, cols - 1, Math.floor(px + band));
    const ay = Math.max(y0, 0, Math.floor(py - band)), by = Math.min(y1, rows - 1, Math.floor(py + band));
    for (let ty = ay; ty <= by; ty++) {
      const dy = ty + 0.5 - py;
      for (let tx = ax; tx <= bx; tx++) {
        const dx = tx + 0.5 - px;
        const dd = dx * dx + dy * dy;
        const t = (ty - y0) * w + (tx - x0);
        if (dd < d2[t]!) { d2[t] = dd; near[t] = i; }
      }
    }
  }
  return { d2, near };
}

/** River depth (0 dry, 1 water, 2 deep) and distance past the river's edge for each tile of a box, from stamps up to crossing `maxTag`; fords applied when `withFords`. */
function riversIn(p: WorldPlan, x0: number, y0: number, w: number, h: number, maxTag = Infinity, withFords = true): { river: Uint8Array; riverDist: Float64Array } {
  const river = new Uint8Array(w * h);
  const riverDist = new Float64Array(w * h).fill(Infinity);
  const { cols, rows, s } = p;
  const x1 = x0 + w - 1, y1 = y0 + h - 1;
  const st = p.stamps;
  for (const k of p.stampIndex.find(x0, y0, x1, y1)) {
    if (st.tag[k]! > maxTag) continue;
    const px = st.x[k]!, py = st.y[k]!, half = st.half[k]!;
    const reach = half + s.hills.maxLevel * s.hills.tilesPerLevel + 1;
    const ax = Math.max(x0, 0, Math.floor(px - reach)), bx = Math.min(x1, cols - 1, Math.floor(px + reach));
    const ay = Math.max(y0, 0, Math.floor(py - reach)), by = Math.min(y1, rows - 1, Math.floor(py + reach));
    for (let ty = ay; ty <= by; ty++) {
      for (let tx = ax; tx <= bx; tx++) {
        const t = (ty - y0) * w + (tx - x0);
        const dd = Math.sqrt((tx + 0.5 - px) * (tx + 0.5 - px) + (ty + 0.5 - py) * (ty + 0.5 - py));
        if (dd - half < riverDist[t]!) riverDist[t] = dd - half;
        if (dd < half) river[t] = Math.max(river[t]!, dd < half - 1.2 && half >= 2 ? 2 : 1);
      }
    }
  }
  if (withFords) {
    for (const k of p.fordIndex.find(x0, y0, x1, y1)) {
      const f = p.fords[k]!;
      const ax = Math.max(x0, 0, Math.floor(f.x - f.radius)), bx = Math.min(x1, cols - 1, Math.floor(f.x + f.radius));
      const ay = Math.max(y0, 0, Math.floor(f.y - f.radius)), by = Math.min(y1, rows - 1, Math.floor(f.y + f.radius));
      for (let ty = ay; ty <= by; ty++) {
        for (let tx = ax; tx <= bx; tx++) {
          const t = (ty - y0) * w + (tx - x0);
          if (river[t] === 2 && (tx + 0.5 - f.x) * (tx + 0.5 - f.x) + (ty + 0.5 - f.y) * (ty + 0.5 - f.y) <= f.radius * f.radius) river[t] = 1;
        }
      }
    }
  }
  return { river, riverDist };
}

const onDeck = (p: WorldPlan, tx: number, ty: number) => p.bridges.some((b) => tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h);

/** Tiles from the edge of the nearest town clearing (negative inside), or Infinity with none. */
function townGap(towns: readonly TownSpot[], cx: number, cy: number): number {
  let best = Infinity;
  for (const t of towns) best = Math.min(best, Math.sqrt((cx - t.x) * (cx - t.x) + (cy - t.y) * (cy - t.y)) - t.radiusTiles);
  return best;
}

/** Lay out the world round a track: see the file comment. Same seed, settings and track, same plan. */
export function planWorld(seed: string, s: MapGenSettings, o: WorldOpts): WorldPlan {
  const { cols, rows, track, closed } = o;
  const salt = (what: string) => hashString(`${seed}/${what}`) & 0xfffff;
  const { route } = track;
  const xs = route.samples.x, ys = route.samples.y;
  const tangents = track.tangents;
  const n = xs.length;
  const L = route.length;
  const spacing = route.spacing;
  const band = Math.ceil(Math.max(
    s.corridor.laneTiles, s.lakes.trackGapTiles, s.rivers.trackGapTiles + s.rivers.widthTiles[1],
    s.hills.trackGapTiles + s.hills.maxLevel * s.hills.tilesPerLevel, s.spawnDistanceTiles,
  )) + 2;
  const sampleIndex = new CellIndex(SAMPLE_CELL);
  for (let i = 0; i < n; i++) sampleIndex.add(i, Math.floor(xs[i]!), Math.floor(ys[i]!), Math.floor(xs[i]!), Math.floor(ys[i]!));

  const p: WorldPlan = {
    seed, s, cols, rows, closed, xs, ys, tangents, n, spacing, band, sampleIndex,
    stretches: [], stretchOf: new Int32Array(n).fill(-1),
    stamps: { x: [], y: [], half: [], tag: [] }, stampIndex: new CellIndex(STAMP_CELL),
    fords: [], fordIndex: new CellIndex(STAMP_CELL),
    bridges: [], towns: [],
    puts: { x: [], y: [], minD: [] }, putIndex: new CellIndex(PUT_CELL),
    spawnClear: new Set(), playerSpawn: { x: 0, y: 0 },
    salts: {
      mud: salt('mud'), rocks: salt('rocks'), forest: salt('forest'), lakes: salt('lakes'), hills: salt('hills'), strips: salt('strips'),
      mesas: salt('mesas'), mesaTops: salt('mesa-tops'), scenery: salt('scenery'), ground: salt('ground'),
    },
  };
  const { stretches, stretchOf } = p;

  /** Distance from a tile's centre to the track, as the whole-map pass finds it (Infinity beyond the band or off the map). */
  const distAt = (q: Vec) => {
    const x = Math.floor(q.x), y = Math.floor(q.y);
    if (x < 0 || y < 0 || x >= cols || y >= rows) return Infinity;
    const { d2, near } = nearestIn(p, x, y, 1, 1);
    return near[0]! < 0 ? Infinity : Math.sqrt(d2[0]!);
  };
  const riverDistAt = (x: number, y: number) => riversIn(p, x, y, 1, 1, Infinity, false).riverDist[0]!;

  // Stretches: each keeps its obstacles on one side (or has none), with both sides open between.
  // Some lay a strip of mud or a broken line of rocks along their obstacle side, as on the extra maps.
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
  const sDist = closed ? (a: number, b: number) => { const d = Math.abs(a - b) % L; return Math.min(d, L - d); } : (a: number, b: number) => Math.abs(a - b);
  /** Sample `j` on a loop wraps; on an open line it is -1 past either end. */
  const wrapIdx = (j: number) => (closed ? ((j % n) + n) % n : j < 0 || j >= n ? -1 : j);
  /** A loop's samples are all on the map; a line's run off both ends, so picks keep 40 tiles in. */
  const inMap = (i: number) => closed || (xs[i]! >= 40 && xs[i]! < cols - 40);

  // Rivers: each crosses the track once, square to it where the track runs along x or y, on a bridge.
  {
    const r = rng(`${seed}/rivers`);
    const count = r.int(s.rivers.count[0], s.rivers.count[1]);
    const crossings: number[] = [];
    const reachOf = (half: number) => half + s.hills.maxLevel * s.hills.tilesPerLevel + 1;
    const stamp = (q: Vec, half: number) => {
      const k = p.stamps.x.length, reach = reachOf(half);
      p.stamps.x.push(q.x); p.stamps.y.push(q.y); p.stamps.half.push(half); p.stamps.tag.push(crossings.length - 1);
      p.stampIndex.add(k, Math.max(0, Math.floor(q.x - reach)), Math.max(0, Math.floor(q.y - reach)), Math.min(cols - 1, Math.floor(q.x + reach)), Math.min(rows - 1, Math.floor(q.y + reach)));
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
        const q = { ...c };
        const len = r.range(s.rivers.lengthTiles[0], s.rivers.lengthTiles[1]);
        let k = 0, ended = false, nextFord = r.range(s.rivers.fordSpacingTiles[0], s.rivers.fordSpacingTiles[1]);
        stamp(q, half);
        for (; k < len; k++) {
          if (k >= nextFord) {
            const f = { x: q.x, y: q.y, radius: Math.max(s.rivers.fordWidthTiles / 2, half) };
            p.fordIndex.add(p.fords.length, Math.max(0, Math.floor(f.x - f.radius)), Math.max(0, Math.floor(f.y - f.radius)), Math.min(cols - 1, Math.floor(f.x + f.radius)), Math.min(rows - 1, Math.floor(f.y + f.radius)));
            p.fords.push(f);
            nextFord = k + r.range(s.rivers.fordSpacingTiles[0], s.rivers.fordSpacingTiles[1]);
          }
          if (k > s.rivers.straightTiles) {
            bend += (r.next() - 0.5) * s.rivers.meander;
            bend = Math.max(-s.rivers.meander, Math.min(s.rivers.meander, bend));
            heading += bend;
          }
          const next = { x: q.x + dcos(heading), y: q.y + dsin(heading) };
          if (next.x < -half || next.y < -half || next.x > cols + half || next.y > rows + half) { ended = true; break; }
          if (k > s.rivers.straightTiles && distAt(next) < s.rivers.trackGapTiles + half) { ended = true; break; }
          q.x = next.x; q.y = next.y;
          stamp(q, half);
        }
        // A river that runs its length inland ends in a pond, kept clear of the track.
        if (!ended) {
          const room = distAt(q) - s.rivers.trackGapTiles;
          const radius = Math.min(r.range(half * 2, half * 4), room);
          if (radius > half) {
            for (let a = -radius + half; a <= radius - half; a += 1) {
              for (let b = -radius + half; b <= radius - half; b += 1) {
                if (a * a + b * b <= (radius - half) * (radius - half)) stamp({ x: q.x + a, y: q.y + b }, half);
              }
            }
          }
        }
      }
      // The deck: every river tile under the cars near this crossing, as a rectangle painted open.
      // Only tiles within carClearTiles of a sample within 30 tiles along can count, so look there.
      const reachSamples = Math.ceil(30 / spacing) + 1;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let k = -reachSamples; k <= reachSamples; k++) {
        const j = wrapIdx(i + k);
        if (j < 0) continue;
        bx0 = Math.min(bx0, xs[j]!); bx1 = Math.max(bx1, xs[j]!); by0 = Math.min(by0, ys[j]!); by1 = Math.max(by1, ys[j]!);
      }
      const cc = s.corridor.carClearTiles;
      const wx0 = Math.max(0, Math.floor(bx0 - cc - 1)), wy0 = Math.max(0, Math.floor(by0 - cc - 1));
      const wx1 = Math.min(cols - 1, Math.floor(bx1 + cc + 1)), wy1 = Math.min(rows - 1, Math.floor(by1 + cc + 1));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      if (wx0 <= wx1 && wy0 <= wy1) {
        const w = wx1 - wx0 + 1, h = wy1 - wy0 + 1;
        const { d2, near } = nearestIn(p, wx0, wy0, w, h);
        const { river } = riversIn(p, wx0, wy0, w, h, crossings.length - 1, false);
        for (let t = 0; t < w * h; t++) {
          if (!river[t] || near[t]! < 0 || d2[t]! >= cc * cc) continue;
          if (sDist(near[t]! * spacing, i * spacing) > 30) continue;
          const x = wx0 + (t % w), y = wy0 + Math.floor(t / w);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
      if (minX === Infinity) continue;
      if (alongX) { minX -= 1; maxX += 1; } else { minY -= 1; maxY += 1; }
      p.bridges.push({ x: minX, y: minY, w: maxX + 1 - minX, h: maxY + 1 - minY, along: alongX ? 'x' : 'y' });
      // No mud or rocks either side near a bridge: the lanes there are the river.
      for (let j = 0; j < n; j++) if (sDist(j * spacing, i * spacing) < half + 16) stretchOf[j] = -1;
    }
  }

  // Town spots (open line only): a flat clearing beside the track, clear of rivers, with both lanes
  // open past it. Hills ramp down to the clearing and nothing grows in it.
  const towns = p.towns;
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
        const span = c.clearingRadiusTiles + 4;
        const wx0 = Math.max(0, Math.floor(x - span)), wy0 = Math.max(0, Math.floor(y - span));
        const wx1 = Math.min(cols - 1, Math.floor(x + span)), wy1 = Math.min(rows - 1, Math.floor(y + span));
        let wet = false;
        if (wx0 <= wx1 && wy0 <= wy1) {
          const w = wx1 - wx0 + 1;
          const { river } = riversIn(p, wx0, wy0, w, wy1 - wy0 + 1);
          for (let dy = -span; dy <= span && !wet; dy++) {
            for (let dx = -span; dx <= span && !wet; dx++) {
              const tx = Math.floor(x + dx), ty = Math.floor(y + dy);
              if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
              if (river[(ty - wy0) * w + (tx - wx0)] || onDeck(p, tx, ty)) wet = true;
            }
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

  // Long mesas, stamped as shapes on top of the noise clumps: free-standing ridges, ridges that run
  // beside the track, and cuts where the track runs through a long mesa between two cliff walls.
  // Each stamp is kept; a window marks the tiles it covers that pass the tests in `put`.
  {
    const m = s.mesas, r = rng(`${seed}/mesas`);
    const put = (x: number, y: number, minD: number) => {
      const tx = Math.floor(x), ty = Math.floor(y);
      if (tx + 1 < 0 || ty + 1 < 0 || tx >= cols || ty >= rows) return;
      p.putIndex.add(p.puts.x.length, tx, ty, tx + 1, ty + 1);
      p.puts.x.push(x); p.puts.y.push(y); p.puts.minD.push(minD);
    };
    /** A band beside the track from sample `i` for `len` tiles, `gap` to `gap + width` out on `side`, rounded at the ends. */
    const alongTrack = (i: number, len: number, side: number, gap: number, width: number) => {
      const steps = Math.floor(len / spacing);
      for (let k = 0; k <= steps; k++) {
        const j = wrapIdx(i + k), u = (2 * k) / steps - 1;
        if (j < 0) break;
        const w = width * Math.sqrt(Math.max(0, 1 - u * u * u * u));
        const tg = tangents[j]!;
        for (let off = gap; off <= gap + w; off += 0.5) put(xs[j]! - tg.y * off * side, ys[j]! + tg.x * off * side, gap - 0.5);
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
        if (riverDistAt(Math.floor(xs[j]!), Math.floor(ys[j]!)) < 12 || townGap(towns, xs[j]!, ys[j]!) < 30) wet = true;
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

  // Spawn: on the open side of a stretch, spawnDistanceTiles out, with a clear path to the track.
  const spawn = (() => {
    const r = rng(`${seed}/spawn`);
    const pathTiles = (i: number, side: number) => {
      const tg = tangents[i]!;
      const out: [number, number][] = [];
      for (let k = 0; k <= s.spawnDistanceTiles; k += 0.5) {
        for (const w of [-1, 0, 1]) {
          const px = xs[i]! - tg.y * k * side + tg.x * w, py = ys[i]! + tg.x * k * side + tg.y * w;
          out.push([Math.floor(px), Math.floor(py)]);
        }
      }
      return out;
    };
    const allOpen = (tiles: [number, number][]) => {
      if (tiles.some(([x, y]) => x < 0 || y < 0 || x >= cols || y >= rows)) return false;
      const x0 = Math.min(...tiles.map((q) => q[0])), x1 = Math.max(...tiles.map((q) => q[0]));
      const y0 = Math.min(...tiles.map((q) => q[1])), y1 = Math.max(...tiles.map((q) => q[1]));
      const win = buildWindow(p, x0, y0, x1 - x0 + 1, y1 - y0 + 1, { spawnClear: false, scenery: false });
      return tiles.every(([x, y]) => win.zones[(y - y0) * win.w + (x - x0)] === Z.open);
    };
    let first: { i: number; side: number } | null = null;
    const [lo, hi] = o.spawnAlong ? [Math.round(o.spawnAlong[0] * (n - 1)), Math.round(o.spawnAlong[1] * (n - 1))] : [0, n - 1];
    for (let attempt = 0; attempt < 40; attempt++) {
      const i = r.int(lo, hi);
      const st = stretchOf[i]! < 0 ? null : stretches[stretchOf[i]!]!;
      const side = !st || st.side === 0 ? (r.next() < 0.5 ? -1 : 1) : -st.side;
      first ??= { i, side };
      if (allOpen(pathTiles(i, side))) return { i, side };
    }
    // Clear a three-tile path from the first pick instead.
    p.spawnClear = new Set(pathTiles(first!.i, first!.side).filter(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows).map(([x, y]) => y * cols + x));
    return first!;
  })();
  const tg = tangents[spawn.i]!;
  p.playerSpawn = {
    x: r4(Math.floor(xs[spawn.i]! - tg.y * s.spawnDistanceTiles * spawn.side) + 0.5),
    y: r4(Math.floor(ys[spawn.i]! + tg.x * s.spawnDistanceTiles * spawn.side) + 0.5),
  };
  return p;
}

/**
 * The tiles of the window [x0, x0 + w) x [y0, y0 + h), which must lie on the map: zones, heights
 * and (with `scenery`) the scenery on them. Built from the plan and the tiles' positions alone, so
 * any window gives the same tiles as any other window over them.
 */
export function buildWindow(p: WorldPlan, x0: number, y0: number, w: number, h: number, opts: { spawnClear: boolean; scenery: boolean } = { spawnClear: true, scenery: true }): WorldWindow {
  const { cols, rows, s, closed, xs, ys, tangents, stretches, stretchOf, towns, salts } = p;
  // One tile more all round (inside the map) for the cliff test.
  const ex0 = Math.max(0, x0 - 1), ey0 = Math.max(0, y0 - 1);
  const ex1 = Math.min(cols - 1, x0 + w), ey1 = Math.min(rows - 1, y0 + h);
  const W = ex1 - ex0 + 1, H = ey1 - ey0 + 1, N = W * H;
  const { d2, near } = nearestIn(p, ex0, ey0, W, H);
  const { river, riverDist } = riversIn(p, ex0, ey0, W, H);
  const dist = (t: number) => (near[t]! < 0 ? Infinity : Math.sqrt(d2[t]!));
  const sideOf = (t: number, x: number, y: number) => {
    const i = near[t]!;
    const tg = tangents[i]!;
    return tg.x * (y + 0.5 - ys[i]!) - tg.y * (x + 0.5 - xs[i]!) >= 0 ? 1 : -1;
  };
  const stretchAt = (t: number): Stretch | null => (near[t]! < 0 || stretchOf[near[t]!]! < 0 ? null : stretches[stretchOf[near[t]!]!]!);
  const deck = new Uint8Array(N);
  for (const b of p.bridges) {
    for (let y = Math.max(ey0, b.y); y < Math.min(ey1 + 1, b.y + b.h); y++) {
      for (let x = Math.max(ex0, b.x); x < Math.min(ex1 + 1, b.x + b.w); x++) deck[(y - ey0) * W + (x - ex0)] = 1;
    }
  }
  const gapAt = (cx: number, cy: number) => (towns.length ? townGap(towns, cx, cy) : Infinity);

  // Mesa stamps over the window.
  const mesaMask = new Uint8Array(N);
  for (const k of p.putIndex.find(ex0 - 1, ey0 - 1, ex1, ey1)) {
    const tx = Math.floor(p.puts.x[k]!), ty = Math.floor(p.puts.y[k]!), minD = p.puts.minD[k]!;
    for (const [ax, ay] of [[tx, ty], [tx + 1, ty], [tx, ty + 1]] as const) {
      if (ax < ex0 || ay < ey0 || ax > ex1 || ay > ey1) continue;
      const t = (ay - ey0) * W + (ax - ex0);
      if (deck[t] || riverDist[t]! <= 3 || dist(t) < minD || gapAt(ax + 0.5, ay + 0.5) < 4) continue;
      mesaMask[t] = 1;
    }
  }

  // Zones and elevation.
  const zones = new Uint8Array(N);
  const heights = new Uint8Array(N);
  const forest = new Uint8Array(N);
  for (let t = 0; t < N; t++) {
    const x = ex0 + (t % W), y = ey0 + Math.floor(t / W);
    const cx = x + 0.5, cy = y + 0.5;
    const d = dist(t);
    // Hills: quantised noise, held at 0 near the track and rivers and ramped up a level per few tiles.
    const hn = fbm(cx, cy, s.hills.scaleTiles, salts.hills);
    let level = hn > s.hills.threshold ? Math.floor(((hn - s.hills.threshold) / (1 - s.hills.threshold)) * (s.hills.maxLevel + 1)) : 0;
    level = Math.min(level, s.hills.maxLevel, ELEVATION_MAX);
    // Lakes lie in hollows: no hills where the lake noise is near its threshold.
    const lake = fbm(cx, cy, s.lakes.scaleTiles, salts.lakes);
    if (lake > s.lakes.threshold - 0.04) level = 0;
    if (d < Infinity) level = Math.min(level, Math.max(0, Math.floor((d - s.hills.trackGapTiles) / s.hills.tilesPerLevel)));
    level = Math.min(level, Math.max(0, Math.floor(riverDist[t]! / s.hills.tilesPerLevel)));
    if (deck[t]) level = 0;
    const toTown = gapAt(cx, cy);
    if (toTown < Infinity) level = Math.min(level, Math.max(0, Math.floor(toTown / s.hills.tilesPerLevel)));
    heights[t] = level;

    // A line enters and leaves through the west and east edges, so only a loop blocks those.
    if ((closed && (x < s.edgeTiles || x >= cols - s.edgeTiles)) || y < s.edgeTiles || y >= rows - s.edgeTiles) { zones[t] = Z.blocked; continue; }
    if (toTown < 0) { zones[t] = Z.open; continue; }
    // Mesas: sandstone plateaus that rise by a cliff all round (drawn by iso/mesa.ts), on rock.
    if ((mesaMask[t] || (fbm(cx, cy, s.mesas.scaleTiles, salts.mesas) > s.mesas.threshold && d > s.mesas.trackGapTiles)) && riverDist[t]! > 3 && lake <= s.lakes.threshold - 0.04) {
      const [lo, hi] = s.mesas.topLevels;
      heights[t] = Math.min(hi, lo + Math.floor(fbm(cx, cy, 40, salts.mesaTops) * (hi - lo + 1)));
      zones[t] = Z.blocked;
      continue;
    }
    if (deck[t] || d < s.corridor.carClearTiles) { zones[t] = Z.open; continue; }
    if (river[t]) { zones[t] = river[t] === 2 && d >= s.corridor.laneTiles + 1 ? Z.deep : Z.water; continue; }
    const st = stretchAt(t);
    const obstacleSide = st !== null && st.side !== 0 && st.side === sideOf(t, x, y);
    if (d < s.corridor.laneTiles && !obstacleSide) { zones[t] = Z.open; continue; }
    if (obstacleSide && st.strip !== null && d >= st.inner && d < st.outer) {
      // Rocks come as a broken line, mud as a solid bank.
      if (st.strip === Z.slow || fbm(cx, cy, 3, salts.strips) > 0.45) { zones[t] = st.strip; continue; }
    }
    if (lake > s.lakes.threshold && d > s.lakes.trackGapTiles) {
      zones[t] = lake > s.lakes.deepThreshold && d > s.lakes.trackGapTiles + 2 ? Z.deep : Z.water;
      continue;
    }
    if (fbm(cx, cy, s.forest.scaleTiles, salts.forest) > s.forest.threshold) { zones[t] = Z.blocked; forest[t] = 1; continue; }
    if (fbm(cx, cy, s.rocks.scaleTiles, salts.rocks) > s.rocks.threshold) { zones[t] = Z.blocked; continue; }
    zones[t] = fbm(cx, cy, s.mud.scaleTiles, salts.mud) > s.mud.threshold ? Z.slow : Z.open;
  }

  // The window itself: cliffs (the top of a two-level drop is blocked, as build-maps does for Tiled
  // maps), the spawn path, then scenery.
  const out: WorldWindow = { x0, y0, w, h, zones: new Uint8Array(w * h), heights: new Uint8Array(w * h), items: { kind: [], x: [], y: [], size: [], order: [] } };
  const items = out.items;
  const add = (t: number, kind: SceneryKind, x: number, y: number, size: number) => {
    items.kind.push(SCENERY_KINDS.indexOf(kind)); items.x.push(r4(x)); items.y.push(r4(y)); items.size.push(r4(size)); items.order.push(t);
  };
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const t = (y - ey0) * W + (x - ex0), hgt = heights[t]!;
      let zone = zones[t]!, wood = forest[t]!;
      if (hgt >= CLIFF_LEVELS && ((x > 0 && hgt - heights[t - 1]! >= CLIFF_LEVELS) || (x < cols - 1 && hgt - heights[t + 1]! >= CLIFF_LEVELS)
        || (y > 0 && hgt - heights[t - W]! >= CLIFF_LEVELS) || (y < rows - 1 && hgt - heights[t + W]! >= CLIFF_LEVELS))) zone = Z.blocked;
      const g = y * cols + x;
      if (opts.spawnClear && p.spawnClear.has(g)) { zone = Z.open; wood = 0; }
      const o = (y - y0) * w + (x - x0);
      out.zones[o] = zone; out.heights[o] = hgt;
      if (!opts.scenery) continue;
      // Scenery (render only): trees on forest tiles, bushes and flowers scattered on open ground.
      if (wood && zone === Z.blocked) {
        if (hash3(g, 0, salts.scenery) >= s.forest.treesPerTile) continue;
        add(g, hash3(g, 1, salts.scenery) < s.forest.pineShare ? 'pine' : 'tree', x + 0.15 + 0.7 * hash3(g, 2, salts.scenery), y + 0.15 + 0.7 * hash3(g, 3, salts.scenery), 0.8 + 0.45 * hash3(g, 4, salts.scenery));
      } else if (zone === Z.open && dist(t) > s.corridor.laneTiles + 1 && !(towns.length && townGap(towns, x + 0.5, y + 0.5) < 2)) {
        const gr = fbm(x + 0.5, y + 0.5, s.ground.scaleTiles, salts.ground) * 2;
        if (hash3(g, 5, salts.scenery) < s.ground.bushesPerTile * gr) add(g, 'bush', x + 0.15 + 0.7 * hash3(g, 6, salts.scenery), y + 0.15 + 0.7 * hash3(g, 7, salts.scenery), 0.8 + 0.45 * hash3(g, 8, salts.scenery));
        else if (hash3(g, 9, salts.scenery) < s.ground.flowersPerTile * gr) add(g, 'flowers', x + 0.15 + 0.7 * hash3(g, 10, salts.scenery), y + 0.15 + 0.7 * hash3(g, 11, salts.scenery), 0.8 + 0.45 * hash3(g, 12, salts.scenery));
      }
    }
  }
  return out;
}
