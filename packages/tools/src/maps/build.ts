// `tools build-maps`: Tiled (.tmj) -> MapDef. See "Tiled workflow in detail" in
// docs/technical-design.md. Minimal phase 0 version: terrain, track routes,
// speed zones and markers; scenery layers are ignored for now.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { hashState } from '@train-robber/sim';
import { MapDefSchema, ZONES, decodeZones, type MapDef, type Route, type Zone } from '@train-robber/config';
import { resample, smooth, type Vec } from './curve';

export const SAMPLE_SPACING_TILES = 0.5;
const FLIP_MASK = 0x0fffffff;

interface Prop { name: string; type?: string; value: unknown }
interface TiledObject {
  id: number; name: string; x: number; y: number; width?: number; height?: number;
  point?: boolean; polyline?: Vec[]; polygon?: Vec[]; properties?: Prop[];
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

export interface BuildResult { map: MapDef; warnings: string[]; minRadiusTiles: number }

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
  const zoneOfGid = new Map<number, number>();
  for (const ts of tm.tilesets) {
    let tiles = ts.tiles;
    if (ts.source) {
      const tsText = readSibling(ts.source);
      sourceText += tsText;
      tiles = (JSON.parse(tsText) as TiledTileset).tiles;
    }
    for (const t of tiles ?? []) {
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

  // Routes: one polyline (or polygon, which is closed) per route.
  let minRadiusTiles = Infinity;
  const routes: Route[] = (layer('track', 'objectgroup', true)!.objects ?? []).map((o) => {
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

    const rs = resample(smooth(points, closed), closed, SAMPLE_SPACING_TILES);
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
      if (z === 'blocked' || z === 'water') fail(`route ${id}: sample ${i} at ${p.x.toFixed(2)},${p.y.toFixed(2)} is on a ${z} tile`);
      cols6.x.push(r4(p.x)); cols6.y.push(r4(p.y)); cols6.s.push(r4(rs.s[i]!));
      cols6.tx.push(r6(tangents[i]!.x)); cols6.ty.push(r6(tangents[i]!.y));
      cols6.speedScale.push(speedAt(p));
    });
    // Radius from the turn between consecutive segment tangents.
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const a = tangents[(i - 1 + n) % n]!, b = tangents[i]!;
      const angle = Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y)));
      if (angle > 1e-9) minRadiusTiles = Math.min(minRadiusTiles, rs.spacing / angle);
    }
    return {
      id, closed, smoothing: 'catmull-rom' as const,
      points: points.map((p) => ({ x: r4(p.x), y: r4(p.y) })),
      length: r4(rs.length), spacing: r6(rs.spacing), samples: cols6,
    };
  });
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
    routes,
    speedZones,
    markers,
  });
  if (decodeZones(map).some((z, i) => z !== grid[i])) fail('zone encoding does not round-trip');
  return { map, warnings, minRadiusTiles };
}

export function buildMapFile(path: string): BuildResult {
  return buildMap(basename(path), readFileSync(path, 'utf8'), (name) => readFileSync(join(dirname(path), name), 'utf8'));
}

/** JSON with objects indented and arrays of numbers kept on one line. */
export function stringifyMap(map: MapDef): string {
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
