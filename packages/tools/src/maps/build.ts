// `tools build-maps`: Tiled (.tmj) -> MapDef. See "Tiled workflow in detail" in
// docs/technical-design.md. Terrain, optional elevation, track routes, speed zones and markers
// go into the MapDef; `scenery*` layers go into a separate render-only SceneryDef the sim never reads.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { hashState } from '@train-robber/sim';
import {
  ELEVATION_MAX, MapDefSchema, SCENERY_KINDS, SOLID_SCENERY, SceneryDefSchema, ZONES, decodeElevation, decodeZones,
  type MapDef, type Route, type SceneryDef, type SceneryKind, type Zone,
} from '@train-robber/config';
import { resample, resampleFixed, smooth, type Vec } from './curve';

export const SAMPLE_SPACING_TILES = 0.5;
/** Levels between neighbours that make a cliff rather than a slope you can ride up. */
export const CLIFF_LEVELS = 2;
/**
 * The track and this many tiles either side of it must be at elevation 0: rails and cars on raised
 * ground are not drawn yet, and a car is 3 tiles either side of the rails and swings wider on curves.
 */
export const TRACK_FLAT_TILES = 6;
const FLIP_MASK = 0x0fffffff;

interface Prop { name: string; type?: string; value: unknown }
interface TiledObject {
  id: number; name: string; x: number; y: number; width?: number; height?: number;
  point?: boolean; ellipse?: boolean; polyline?: Vec[]; polygon?: Vec[]; properties?: Prop[]; type?: string; class?: string;
}
interface TiledLayer {
  name: string; type: 'tilelayer' | 'objectgroup' | 'group' | 'imagelayer';
  width?: number; height?: number; data?: number[] | string; encoding?: string; compression?: string;
  objects?: TiledObject[]; layers?: TiledLayer[];
}
interface TiledTileset { firstgid: number; source?: string; name?: string; tiles?: { id: number; properties?: Prop[] }[] }
interface TiledMap {
  orientation: string; infinite: boolean; width: number; height: number;
  tilewidth: number; tileheight: number; layers: TiledLayer[]; tilesets: TiledTileset[];
}

export interface BuildResult {
  map: MapDef;
  /** The render-only scenery, or null when the file has no `scenery` layers. */
  scenery: SceneryDef | null;
  warnings: string[];
  minRadiusTiles: number;
}

/** Items per tile an area scatters when it sets no `density`. */
export const DEFAULT_DENSITY: Record<SceneryKind, number> = { tree: 0.6, pine: 0.6, bush: 0.06, flowers: 0.06 };

export class MapError extends Error {
  constructor(file: string, detail: string) { super(`${file}: ${detail}`); this.name = 'MapError'; }
}

const prop = (props: Prop[] | undefined, name: string) => props?.find((p) => p.name === name)?.value;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

function flatten(layers: TiledLayer[]): TiledLayer[] {
  return layers.flatMap((l) => (l.type === 'group' ? flatten(l.layers ?? []) : [l]));
}

function tileData(layer: TiledLayer, fail: (m: string) => never): number[] {
  if (Array.isArray(layer.data)) return layer.data;
  if (typeof layer.data !== 'string' || layer.encoding !== 'base64') fail(`layer ${layer.name}: unsupported tile encoding ${layer.encoding ?? 'none'}`);
  let bytes: Buffer = Buffer.from(layer.data, 'base64');
  if (layer.compression === 'zlib') bytes = inflateSync(bytes);
  else if (layer.compression === 'gzip') bytes = gunzipSync(bytes);
  else if (layer.compression) fail(`layer ${layer.name}: unsupported compression ${layer.compression} (use zlib, gzip or none)`);
  const out: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i += 4) out.push(bytes.readUInt32LE(i));
  return out;
}

/** Compile one Tiled map. `readSibling` loads external tilesets relative to the map. */
export function buildMap(file: string, text: string, readSibling: (name: string) => string): BuildResult {
  const fail = (m: string): never => { throw new MapError(file, m); };
  const tm = JSON.parse(text) as TiledMap;
  if (tm.orientation !== 'orthogonal') fail(`orientation must be orthogonal, got ${tm.orientation}`);
  if (tm.infinite) fail('map must be fixed size, not infinite');
  const cols = tm.width, rows = tm.height, tw = tm.tilewidth, th = tm.tileheight;
  const warnings: string[] = [];
  let sourceText = text;

  const layers = flatten(tm.layers);
  const layer = (name: string, type: TiledLayer['type'], required: boolean) => {
    const l = layers.find((x) => x.name === name);
    if (!l) return required ? fail(`missing layer "${name}"`) : undefined;
    if (l.type !== type) fail(`layer "${name}" must be a ${type}, got ${l.type}`);
    return l;
  };

  // Terrain: gid -> zone through the tileset's `zone` property. Unpainted tiles are open.
  // Elevation: gid -> level through the `elevation` property. Unpainted tiles are level 0.
  const zoneOfGid = new Map<number, number>();
  const levelOfGid = new Map<number, number>();
  for (const ts of tm.tilesets) {
    let tiles = ts.tiles;
    if (ts.source) {
      const tsText = readSibling(ts.source);
      sourceText += tsText;
      tiles = (JSON.parse(tsText) as TiledTileset).tiles;
    }
    for (const t of tiles ?? []) {
      const level = prop(t.properties, 'elevation');
      if (level !== undefined) {
        if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > ELEVATION_MAX) fail(`tileset ${ts.source ?? ts.name}: tile ${t.id} elevation must be a whole number 0 to ${ELEVATION_MAX}`);
        levelOfGid.set(ts.firstgid + t.id, level as number);
      }
      const z = prop(t.properties, 'zone');
      if (z === undefined) continue;
      const idx = ZONES.indexOf(z as Zone);
      if (idx < 0) fail(`tileset ${ts.source ?? ts.name}: tile ${t.id} has unknown zone "${String(z)}"`);
      zoneOfGid.set(ts.firstgid + t.id, idx);
    }
  }
  const terrain = layer('terrain', 'tilelayer', true)!;
  const gids = tileData(terrain, fail);
  if (gids.length !== cols * rows) fail(`terrain has ${gids.length} tiles, map is ${cols} x ${rows}`);
  const grid = new Uint8Array(cols * rows);
  gids.forEach((raw, i) => {
    const gid = raw & FLIP_MASK;
    if (gid === 0) return;
    const z = zoneOfGid.get(gid);
    if (z === undefined) fail(`terrain tile at ${i % cols},${Math.floor(i / cols)} (gid ${gid}) has no zone property`);
    grid[i] = z!;
  });
  // Elevation, then cliffs: a tile two or more levels above a neighbour is the top of a cliff,
  // so it is blocked and the horse cannot ride off the edge (the sim has no height).
  const elevationLayer = layer('elevation', 'tilelayer', false);
  const heights = new Uint8Array(cols * rows);
  if (elevationLayer) {
    const eg = tileData(elevationLayer, fail);
    if (eg.length !== cols * rows) fail(`elevation has ${eg.length} tiles, map is ${cols} x ${rows}`);
    eg.forEach((raw, i) => {
      const gid = raw & FLIP_MASK;
      if (gid === 0) return;
      const level = levelOfGid.get(gid);
      if (level === undefined) fail(`elevation tile at ${i % cols},${Math.floor(i / cols)} (gid ${gid}) has no elevation property`);
      heights[i] = level!;
    });
    const blocked = ZONES.indexOf('blocked');
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const h = heights[y * cols + x]!;
        const drop = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const nx = x + dx!, ny = y + dy!;
          return nx >= 0 && ny >= 0 && nx < cols && ny < rows && h - heights[ny * cols + nx]! >= CLIFF_LEVELS;
        });
        if (drop) grid[y * cols + x] = blocked;
      }
    }
  }
  const elevation: [number, number][] = [];
  for (const h of heights) {
    const last = elevation[elevation.length - 1];
    if (last && last[1] === h) last[0]++;
    else elevation.push([1, h]);
  }

  const zones: [number, number][] = [];
  for (const z of grid) {
    const last = zones[zones.length - 1];
    if (last && last[1] === z) last[0]++;
    else zones.push([1, z]);
  }

  const toTiles = (p: Vec): Vec => ({ x: p.x / tw, y: p.y / th });
  const inside = (p: Vec) => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows;
  const zoneAt = (p: Vec): Zone => ZONES[grid[Math.floor(p.y) * cols + Math.floor(p.x)]!]!;

  // Speed zones: rectangles with speedScale in (0, 1].
  const speedZones = (layer('speedZones', 'objectgroup', false)?.objects ?? []).map((o) => {
    const scale = prop(o.properties, 'speedScale');
    if (typeof scale !== 'number' || !(scale > 0 && scale <= 1)) fail(`speed zone ${o.id}: speedScale must be a number in (0, 1]`);
    return { x: r4(o.x / tw), y: r4(o.y / th), w: r4((o.width ?? 0) / tw), h: r4((o.height ?? 0) / th), speedScale: scale as number };
  });
  const speedAt = (p: Vec) => speedZones.reduce((m, z) =>
    p.x >= z.x && p.x < z.x + z.w && p.y >= z.y && p.y < z.y + z.h ? Math.min(m, z.speedScale) : m, 1);

  // Routes: one polyline (or polygon, which is closed) per route, or services joined from
  // segments (polylines with a `segment` property) that meet at junctions.
  let minRadiusTiles = Infinity;
  const trains: { type: string; route: string; d: number }[] = [];
  const bake = (id: string, closed: boolean, points: Vec[], rs: { length: number; spacing: number; points: Vec[]; s: number[] }, o: TiledObject, legs?: Route['legs']): Route => {
    const n = rs.points.length;
    const cols6 = { x: [] as number[], y: [] as number[], s: [] as number[], tx: [] as number[], ty: [] as number[], speedScale: [] as number[] };
    const tangents: Vec[] = [];
    for (let i = 0; i < n; i++) {
      const a = rs.points[i]!;
      const [from, to] = i + 1 < n ? [a, rs.points[i + 1]!] : closed ? [a, rs.points[0]!] : [rs.points[i - 1]!, a];
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      tangents.push({ x: (to.x - from.x) / len, y: (to.y - from.y) / len });
    }
    rs.points.forEach((p, i) => {
      if (!inside(p)) fail(`route ${id}: sample ${i} at ${p.x.toFixed(2)},${p.y.toFixed(2)} is outside the map`);
      const z = zoneAt(p);
      if (z === 'blocked' || z === 'water' || z === 'deep') fail(`route ${id}: sample ${i} at ${p.x.toFixed(2)},${p.y.toFixed(2)} is on a ${z} tile`);
      if (elevationLayer) {
        for (let dy = -TRACK_FLAT_TILES; dy <= TRACK_FLAT_TILES; dy++) {
          for (let dx = -TRACK_FLAT_TILES; dx <= TRACK_FLAT_TILES; dx++) {
            const tx = Math.floor(p.x) + dx, ty = Math.floor(p.y) + dy;
            if (tx < 0 || ty < 0 || tx >= cols || ty >= rows || heights[ty * cols + tx] === 0) continue;
            fail(`route ${id}: sample ${i} at ${p.x.toFixed(2)},${p.y.toFixed(2)} is within ${TRACK_FLAT_TILES} tiles of raised ground at ${tx},${ty}; keep the track on level 0`);
          }
        }
      }
      cols6.x.push(r4(p.x)); cols6.y.push(r4(p.y)); cols6.s.push(r4(rs.s[i]!));
      cols6.tx.push(r6(tangents[i]!.x)); cols6.ty.push(r6(tangents[i]!.y));
      cols6.speedScale.push(speedAt(p));
    });
    // Radius from the turn between consecutive segment tangents, over the local step length.
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const a = tangents[(i - 1 + n) % n]!, b = tangents[i]!;
      const angle = Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y)));
      const step = i + 1 < n ? rs.s[i + 1]! - rs.s[i]! : rs.length - rs.s[i]!;
      if (angle > 1e-9) minRadiusTiles = Math.min(minRadiusTiles, Math.min(rs.spacing, step) / angle);
    }
    // Optional `trains` (how many) and `trainType` (default blank): spaced evenly round the route.
    const count = prop(o.properties, 'trains');
    if (count !== undefined) {
      if (!Number.isInteger(count) || (count as number) < 0) fail(`route ${id}: trains must be a whole number`);
      const type = String(prop(o.properties, 'trainType') ?? 'blank');
      const offset = Number(prop(o.properties, 'trainOffset') ?? 0);
      for (let k = 0; k < (count as number); k++) trains.push({ type, route: id, d: r4(((rs.length * k) / (count as number) + offset) % rs.length) });
    }
    return {
      id, closed, smoothing: 'catmull-rom' as const,
      points: points.map((p) => ({ x: r4(p.x), y: r4(p.y) })),
      length: r4(rs.length), spacing: r6(rs.spacing), samples: cols6,
      ...(legs ? { legs } : {}),
    };
  };

  const trackObjects = layer('track', 'objectgroup', true)!.objects ?? [];
  const routes: Route[] = trackObjects.filter((o) => prop(o.properties, 'segment') === undefined).map((o) => {
    const line = o.polyline ?? o.polygon;
    const id = String(prop(o.properties, 'route') ?? o.name ?? '') || fail(`track object ${o.id}: set a "route" property`);
    if (!line) fail(`route ${id}: must be a polyline`);
    const closed = o.polygon ? true : prop(o.properties, 'closed') === true;
    const points = line!.map((p) => toTiles({ x: o.x + p.x, y: o.y + p.y }));
    if (points.length < (closed ? 3 : 2)) fail(`route ${id}: needs at least ${closed ? 3 : 2} points`);
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length]!;
      if ((i + 1 < points.length || closed) && p.x === q.x && p.y === q.y) fail(`route ${id}: point ${i} repeats the next point`);
    });
    return bake(id, closed, points, resample(smooth(points, closed), closed, SAMPLE_SPACING_TILES), o);
  });

  const { junctions, services } = buildServices(trackObjects, layer('services', 'objectgroup', false)?.objects ?? [], toTiles, fail);
  for (const sv of services) routes.push(bake(sv.id, true, sv.points, sv.rs, sv.object, sv.legs));
  const ids = routes.map((r) => r.id);
  if (new Set(ids).size !== ids.length) fail(`duplicate route ids: ${ids.join(', ')}`);

  // Markers: point objects by name. The player spawn must be on an open tile.
  const markers: Record<string, Vec> = {};
  for (const o of layer('markers', 'objectgroup', true)!.objects ?? []) {
    if (!o.name) { warnings.push(`marker ${o.id} has no name and is ignored`); continue; }
    markers[o.name] = { x: r4(o.x / tw), y: r4(o.y / th) };
  }
  for (const name of ['playerSpawn']) {
    const m = markers[name] ?? fail(`missing marker "${name}"`);
    if (!inside(m)) fail(`marker ${name} is outside the map`);
    if (zoneAt(m) !== 'open') fail(`marker ${name} is on a ${zoneAt(m)} tile, not open`);
  }

  const map = MapDefSchema.parse({
    schemaVersion: 1,
    id: basename(file).replace(/\.tmj$/, ''),
    source: { file: basename(file), hash: hashState(sourceText) },
    size: { cols, rows },
    zoneLegend: [...ZONES],
    zones,
    ...(elevationLayer ? { elevation } : {}),
    routes,
    speedZones,
    ...(junctions.length ? { junctions } : {}),
    ...(trains.length ? { trains } : {}),
    markers,
  });
  if (decodeZones(map).some((z, i) => z !== grid[i])) fail('zone encoding does not round-trip');
  if (decodeElevation(map).some((h, i) => h !== heights[i])) fail('elevation encoding does not round-trip');
  const sceneryLayers = layers.filter((l) => l.name.startsWith('scenery'));
  const scenery = sceneryLayers.length ? buildScenery(map, sceneryLayers, zoneAt, { tw, th }, fail) : null;
  return { map, scenery, warnings, minRadiusTiles };
}

/** A small integer hash for scattering; the build is deterministic, so it uses no Math.random. */
function hash01(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Even-odd test of a point against a closed polygon. */
function inPolygon(p: Vec, poly: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Scenery objects: a point is one item; a rectangle, ellipse or polygon scatters items over the
 * tiles inside it (solid kinds only on `blocked` tiles, the rest only on open ground); a
 * `bridge` rectangle is drawn as it is. The kind is the object's class
 * (type) or a `kind` property; an area may list several kinds, comma separated.
 */
function buildScenery(
  map: MapDef, layers: TiledLayer[], zoneAt: (p: Vec) => Zone, px: { tw: number; th: number },
  fail: (m: string) => never,
): SceneryDef {
  const { cols, rows } = map.size;
  const items = { kind: [] as number[], x: [] as number[], y: [] as number[], size: [] as number[] };
  const bridges: SceneryDef['bridges'] = [];
  const fits = (kind: SceneryKind, z: Zone) => (SOLID_SCENERY.has(kind) ? z === 'blocked' : z === 'open');
  const add = (kind: SceneryKind, x: number, y: number, size: number) => {
    items.kind.push(SCENERY_KINDS.indexOf(kind)); items.x.push(r4(x)); items.y.push(r4(y)); items.size.push(r4(size));
  };
  for (const layer of layers) {
    if (layer.type !== 'objectgroup') fail(`layer "${layer.name}" must be an objectgroup, got ${layer.type}`);
    for (const o of layer.objects ?? []) {
      const where = `${layer.name} object ${o.id}`;
      const raw = String(prop(o.properties, 'kind') ?? o.type ?? o.class ?? '');
      if (!raw) fail(`${where}: set its class or a "kind" property`);
      const x = o.x / px.tw, y = o.y / px.th, w = (o.width ?? 0) / px.tw, h = (o.height ?? 0) / px.th;
      const isRect = !o.point && !o.ellipse && !o.polygon && !o.polyline && w > 0 && h > 0;
      if (raw === 'bridge') {
        if (!isRect) fail(`${where}: a bridge must be a rectangle`);
        const r = { x: r4(x), y: r4(y), w: r4(w), h: r4(h) };
        const along = prop(o.properties, 'along') ?? (w >= h ? 'x' : 'y');
        if (along !== 'x' && along !== 'y') fail(`${where}: along must be "x" or "y"`);
        for (let ty = Math.floor(y); ty < y + h; ty++) {
          for (let tx = Math.floor(x); tx < x + w; tx++) {
            const z = zoneAt({ x: Math.min(cols - 1, tx), y: Math.min(rows - 1, ty) });
            if (z === 'blocked' || z === 'water' || z === 'deep') fail(`${where}: bridge covers a ${z} tile at ${tx},${ty}; paint the deck open`);
          }
        }
        bridges.push({ ...r, along });
        continue;
      }
      const kinds = raw.split(',').map((k) => k.trim()) as SceneryKind[];
      for (const k of kinds) if (!SCENERY_KINDS.includes(k)) fail(`${where}: unknown kind "${k}" (use ${[...SCENERY_KINDS, 'bridge'].join(', ')})`);
      const size = prop(o.properties, 'size');
      if (size !== undefined && !(typeof size === 'number' && size > 0)) fail(`${where}: size must be a positive number`);
      if (o.point) {
        if (kinds.length !== 1) fail(`${where}: a point is one item, so give it one kind`);
        const k = kinds[0]!;
        if (x < 0 || y < 0 || x >= cols || y >= rows) fail(`${where}: outside the map`);
        const z = zoneAt({ x, y });
        if (!fits(k, z)) fail(`${where}: a ${k} at ${x.toFixed(1)},${y.toFixed(1)} is on a ${z} tile; ${SOLID_SCENERY.has(k) ? 'paint it blocked' : 'it needs open ground'}`);
        add(k, x, y, (size as number | undefined) ?? 1);
        continue;
      }
      // An area: a polygon, an ellipse or a rectangle.
      const poly = o.polygon?.map((p) => ({ x: (o.x + p.x) / px.tw, y: (o.y + p.y) / px.th }));
      if (o.polyline) fail(`${where}: use a polygon, rectangle or ellipse for an area, not a polyline`);
      if (!poly && !(w > 0 && h > 0)) fail(`${where}: an area needs a size`);
      const inside = (p: Vec) => poly ? inPolygon(p, poly)
        : o.ellipse ? ((p.x - x - w / 2) / (w / 2)) ** 2 + ((p.y - y - h / 2) / (h / 2)) ** 2 <= 1
          : p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;
      const density = prop(o.properties, 'density');
      if (density !== undefined && !(typeof density === 'number' && density > 0 && density <= 4)) fail(`${where}: density must be a number in (0, 4]`);
      const bx = poly ? poly.map((p) => p.x) : [x, x + w], by = poly ? poly.map((p) => p.y) : [y, y + h];
      const x0 = Math.max(0, Math.floor(Math.min(...bx))), x1 = Math.min(cols, Math.ceil(Math.max(...bx)));
      const y0 = Math.max(0, Math.floor(Math.min(...by))), y1 = Math.min(rows, Math.ceil(Math.max(...by)));
      for (let ty = y0; ty < y1; ty++) {
        for (let tx = x0; tx < x1; tx++) {
          if (!inside({ x: tx + 0.5, y: ty + 0.5 })) continue;
          const z = zoneAt({ x: tx, y: ty });
          const cell = ty * cols + tx;
          const k = kinds[Math.floor(hash01(o.id, cell, 1) * kinds.length)]!;
          if (!fits(k, z)) continue;
          const d = (density as number | undefined) ?? DEFAULT_DENSITY[k];
          const n = Math.floor(d) + (hash01(o.id, cell, 2) < d % 1 ? 1 : 0);
          for (let i = 0; i < n; i++) {
            add(k, tx + 0.15 + 0.7 * hash01(o.id, cell, 3 + i * 3), ty + 0.15 + 0.7 * hash01(o.id, cell, 4 + i * 3),
              ((size as number | undefined) ?? 1) * (0.8 + 0.45 * hash01(o.id, cell, 5 + i * 3)));
          }
        }
      }
    }
  }
  return SceneryDefSchema.parse({ schemaVersion: 1, map: map.id, source: map.source, kindLegend: [...SCENERY_KINDS], items, bridges });
}

/** Segment ends this close together meet at one junction. */
const JUNCTION_SNAP_TILES = 0.5;
/** How far a segment's first or last chord may point away from its junction's shared tangent. */
const JUNCTION_MAX_DEGREES = 25;

interface Segment { id: string; points: Vec[]; from: string; to: string; rs: { length: number; points: Vec[]; s: number[] } }

/**
 * Segments and services: find where segment ends meet, give each junction one tangent, bake
 * each segment once along it, and join each service's segments into one closed route.
 */
function buildServices(track: TiledObject[], serviceObjects: TiledObject[], toTiles: (p: Vec) => Vec, fail: (m: string) => never) {
  const raw = track.filter((o) => prop(o.properties, 'segment') !== undefined).map((o) => {
    const id = String(prop(o.properties, 'segment'));
    if (!o.polyline || o.polyline.length < 2) fail(`segment ${id}: must be an open polyline with at least 2 points`);
    return { id, points: o.polyline!.map((p) => toTiles({ x: o.x + p.x, y: o.y + p.y })) };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (new Set(raw.map((r) => r.id)).size !== raw.length) fail(`duplicate segment ids: ${raw.map((r) => r.id).join(', ')}`);
  if (!raw.length && !serviceObjects.length) return { junctions: [], services: [] };
  if (!raw.length) fail('a services layer needs segments on the track layer');

  // Junctions: cluster segment ends, then snap every end onto its junction.
  const js: { id: string; x: number; y: number; ends: { seg: number; end: 'start' | 'end' }[] }[] = [];
  raw.forEach((r, seg) => {
    for (const end of ['start', 'end'] as const) {
      if (r.points.length < 2) continue;
      const p = end === 'start' ? r.points[0]! : r.points[r.points.length - 1]!;
      let j = js.find((q) => Math.hypot(q.x - p.x, q.y - p.y) <= JUNCTION_SNAP_TILES);
      if (!j) { j = { id: `j${js.length + 1}`, x: r4(p.x), y: r4(p.y), ends: [] }; js.push(j); }
      j.ends.push({ seg, end });
    }
  });
  const unit = (a: Vec, b: Vec): Vec => { const l = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
  const junctions = js.map((j) => {
    if (j.ends.length < 2) fail(`segment ${raw[j.ends[0]!.seg]!.id}: its ${j.ends[0]!.end} at ${j.x},${j.y} meets no other segment`);
    // Shared tangent: the trunk's direction where one track splits in two or two join into
    // one; otherwise the arriving and leaving chords that line up best.
    const dirs = j.ends.map(({ seg, end }) => {
      const pts = raw[seg]!.points;
      return end === 'start' ? unit(pts[0]!, pts[1]!) : unit(pts[pts.length - 2]!, pts[pts.length - 1]!);
    });
    const ins = j.ends.flatMap((e, i) => (e.end === 'end' ? [i] : [])), outs = j.ends.flatMap((e, i) => (e.end === 'start' ? [i] : []));
    if (!ins.length || !outs.length) fail(`junction ${j.id} at ${j.x},${j.y}: track only ${ins.length ? 'arrives' : 'leaves'} there; a junction needs track in and out`);
    let sx = 0, sy = 0;
    if (ins.length === 1 || outs.length === 1) {
      const trunk = dirs[ins.length === 1 ? ins[0]! : outs[0]!]!;
      sx = trunk.x; sy = trunk.y;
    } else {
      let bestDot = -2;
      for (const ia of ins) for (const ib of outs) {
        const da = dirs[ia]!, db = dirs[ib]!, dot = da.x * db.x + da.y * db.y;
        if (dot > bestDot) { bestDot = dot; sx = da.x + db.x; sy = da.y + db.y; }
      }
    }
    const len = Math.hypot(sx, sy);
    if (len < 1e-9) fail(`junction ${j.id} at ${j.x},${j.y}: its segments point in opposite directions`);
    const t = { x: sx / len, y: sy / len };
    j.ends.forEach(({ seg, end }, k) => {
      const deg = (Math.acos(Math.min(1, dirs[k]!.x * t.x + dirs[k]!.y * t.y)) * 180) / Math.PI;
      if (deg > JUNCTION_MAX_DEGREES) fail(`junction ${j.id} at ${j.x},${j.y}: segment ${raw[seg]!.id} ${end === 'start' ? 'leaves' : 'arrives'} ${deg.toFixed(0)} degrees off the junction's direction (max ${JUNCTION_MAX_DEGREES}); line its ${end === 'start' ? 'second' : 'second-last'} point up with the track`);
    });
    return { id: j.id, x: j.x, y: j.y, tx: r6(t.x), ty: r6(t.y) };
  });
  const junctionOf = (seg: number, end: 'start' | 'end') => js.findIndex((j) => j.ends.some((e) => e.seg === seg && e.end === end));

  const segments = new Map<string, Segment>();
  raw.forEach((r, seg) => {
    const a = junctionOf(seg, 'start'), b = junctionOf(seg, 'end');
    const ja = junctions[a]!, jb = junctions[b]!;
    const pts = [{ x: ja.x, y: ja.y }, ...r.points.slice(1, -1), { x: jb.x, y: jb.y }];
    // Phantom points beyond each end: the neighbouring point mirrored across the junction's
    // tangent and through the junction. The curve then passes through the junction exactly
    // along its tangent, bending toward the segment's own points.
    const phantom = (j: { x: number; y: number; tx: number; ty: number }, nb: Vec): Vec => {
      const dx = nb.x - j.x, dy = nb.y - j.y;
      const a = dx * j.tx + dy * j.ty, b = -dx * j.ty + dy * j.tx;
      return { x: j.x - a * j.tx - b * j.ty, y: j.y - a * j.ty + b * j.tx };
    };
    const ends = { before: phantom(ja, pts[1]!), after: phantom(jb, pts[pts.length - 2]!) };
    segments.set(r.id, { id: r.id, points: pts, from: ja.id, to: jb.id, rs: resampleFixed(smooth(pts, false, ends), SAMPLE_SPACING_TILES) });
  });

  const used = new Set<string>();
  const services = serviceObjects.map((o) => {
    const id = String(prop(o.properties, 'route') ?? o.name ?? '') || fail(`service object ${o.id}: set a "route" property`);
    const path = String(prop(o.properties, 'path') ?? '').split(/[\s,]+/).filter(Boolean);
    if (!path.length) fail(`service ${id}: set a "path" property listing its segments in order`);
    if (path.some((p) => p.endsWith('<'))) fail(`service ${id}: running a segment backwards (<) is not supported yet`);
    if (new Set(path).size !== path.length) fail(`service ${id}: a segment appears twice in its path`);
    const legs: NonNullable<Route['legs']> = [];
    const pts: Vec[] = [], samples: Vec[] = [], s: number[] = [];
    let start = 0;
    path.forEach((sid, i) => {
      for (const p of path) if (!segments.has(p)) fail(`service ${id}: no segment ${p}`);
      const seg = segments.get(sid)!;
      const prev = segments.get(path[(i - 1 + path.length) % path.length]!)!;
      if (prev.to !== seg.from) fail(`service ${id}: segment ${prev.id} ends at ${prev.to} but ${seg.id} starts at ${seg.from}`);
      used.add(sid);
      legs.push({ segment: sid, start: r4(start), length: r4(seg.rs.length), from: seg.from, to: seg.to });
      pts.push(...seg.points.slice(0, -1));
      samples.push(...seg.rs.points);
      s.push(...seg.rs.s.map((v) => v + start));
      start += seg.rs.length;
    });
    return { id, object: o, points: pts, legs, rs: { length: start, spacing: SAMPLE_SPACING_TILES, points: samples, s } };
  });
  for (const id of segments.keys()) if (!used.has(id)) fail(`segment ${id}: no service runs on it`);
  return { junctions, services };
}

export function buildMapFile(path: string): BuildResult {
  return buildMap(basename(path), readFileSync(path, 'utf8'), (name) => readFileSync(join(dirname(path), name), 'utf8'));
}

/** JSON with objects indented and arrays of numbers kept on one line. */
export function stringifyMap(map: MapDef | SceneryDef): string {
  const fmt = (v: unknown, ind: string): string => {
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== 'object' || (Array.isArray(x) && x.every((y) => typeof y !== 'object')))) return JSON.stringify(v);
      return `[\n${v.map((x) => ind + '  ' + fmt(x, ind + '  ')).join(',\n')}\n${ind}]`;
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.every(([, x]) => typeof x !== 'object')) return JSON.stringify(v);
      return `{\n${entries.map(([k, x]) => `${ind}  ${JSON.stringify(k)}: ${fmt(x, ind + '  ')}`).join(',\n')}\n${ind}}`;
    }
    return JSON.stringify(v);
  };
  return fmt(map, '') + '\n';
}
