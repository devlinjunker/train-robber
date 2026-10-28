// The map's tiles for drawing (G5): the zone, level and forest of any tile, and the scenery in any
// box. A hand-made map or loop is decoded whole once, as before. A generated line that carries
// its chunks (`terrain`, see @train-robber/config MapChunks) and no `zones` is streamed: tiles are
// read from chunks built as they are first needed, and the least recently used chunks are dropped
// once more than `keep` are held, so a line of any length takes about the same memory.
import { SOLID_SCENERY, decodeElevation, decodeZones, type MapChunk, type MapChunks, type MapDef, type SceneryDef, type SceneryKind } from '@train-robber/config';

/** Scenery items, columnar as in SceneryDef. */
export type Items = SceneryDef['items'];

export interface TileBoxLike { x0: number; y0: number; x1: number; y1: number }

export interface MapTiles {
  readonly cols: number;
  readonly rows: number;
  /** True for a generated line read chunk by chunk. */
  readonly streamed: boolean;
  /** Legend index (MapDef.zoneLegend) of tile (x, y), which must be on the map. */
  zone(x: number, y: number): number;
  /** Elevation level of tile (x, y), which must be on the map. */
  level(x: number, y: number): number;
  /** Whether tile (x, y) reads as forest: blocked, holding a tree or next to one (scenery.ts forestTiles). False off the map. */
  forest(x: number, y: number): boolean;
  /** The scenery items standing in a box of tiles [x0, x1) x [y0, y1), in map order, as a SceneryDef with only those items. */
  sceneryIn(box: TileBoxLike): SceneryDef | null;
  /** Chunks built so far and held now (streamed only). */
  readonly stats: { built: number; held: number };
  /** Hear about each chunk the first time it is read (streamed only), e.g. to paint the minimap. */
  onChunk(fn: (c: MapChunk) => void): void;
}

/** Tiles of a whole decoded map. */
class WholeTiles implements MapTiles {
  readonly streamed = false;
  readonly cols: number; readonly rows: number;
  readonly stats = { built: 0, held: 0 };
  private readonly zones: Uint8Array;
  private readonly levels: Uint8Array;
  private forestSet: Set<number> | null = null;
  constructor(private readonly map: MapDef, private readonly scenery: SceneryDef | null) {
    this.cols = map.size.cols; this.rows = map.size.rows;
    this.zones = decodeZones(map);
    this.levels = decodeElevation(map);
  }
  zone(x: number, y: number): number { return this.zones[y * this.cols + x]!; }
  level(x: number, y: number): number { return this.levels[y * this.cols + x]!; }
  forest(x: number, y: number): boolean {
    if (!this.scenery) return false;
    this.forestSet ??= forestOf(this.cols, this.rows, (x, y) => this.zone(x, y), this.map.zoneLegend.indexOf('blocked'), this.scenery, { x0: 0, y0: 0, x1: this.cols, y1: this.rows });
    return this.forestSet.has(y * this.cols + x);
  }
  sceneryIn(box: TileBoxLike): SceneryDef | null {
    if (!this.scenery) return null;
    const { kind, x, y, size } = this.scenery.items;
    const out: Items = { kind: [], x: [], y: [], size: [] };
    for (let i = 0; i < kind.length; i++) {
      if (x[i]! < box.x0 || x[i]! >= box.x1 || y[i]! < box.y0 || y[i]! >= box.y1) continue;
      out.kind.push(kind[i]!); out.x.push(x[i]!); out.y.push(y[i]!); out.size.push(size[i]!);
    }
    return { ...this.scenery, items: out };
  }
  onChunk(): void {}
}

/**
 * Forest tiles in a box (indices y * cols + x): blocked tiles holding a solid scenery item or next
 * to one. `scenery` must hold every item within a tile of the box.
 */
export function forestOf(cols: number, rows: number, zone: (x: number, y: number) => number, blocked: number, scenery: SceneryDef, box: TileBoxLike): Set<number> {
  const out = new Set<number>();
  const { kind, x, y } = scenery.items;
  for (let i = 0; i < kind.length; i++) {
    if (!SOLID_SCENERY.has(scenery.kindLegend[kind[i]!]! as SceneryKind)) continue;
    const tx = Math.floor(x[i]!), ty = Math.floor(y[i]!);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = tx + dx, ny = ty + dy;
        if (nx < box.x0 || ny < box.y0 || nx >= box.x1 || ny >= box.y1) continue;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && zone(nx, ny) === blocked) out.add(ny * cols + nx);
      }
    }
  }
  return out;
}

interface Held { chunk: MapChunk; forest: Uint8Array | null }

/** Tiles read chunk by chunk from a generated line's `terrain`. */
class StreamedTiles implements MapTiles {
  readonly streamed = true;
  readonly cols: number; readonly rows: number;
  readonly stats = { built: 0, held: 0 };
  private readonly T: number;
  private readonly held = new Map<number, Held>();
  private lastKey = NaN;
  private last: Held | null = null;
  private readonly listeners: ((c: MapChunk) => void)[] = [];
  private readonly blocked: number;
  constructor(private readonly map: MapDef, private readonly terrain: MapChunks, private readonly scenery: SceneryDef | null, private readonly keep: number) {
    this.cols = map.size.cols; this.rows = map.size.rows;
    this.T = terrain.tiles;
    this.blocked = map.zoneLegend.indexOf('blocked');
  }
  private get(cx: number, cy: number): Held {
    const key = cy * 100_003 + cx;
    if (key === this.lastKey && this.last) return this.last;
    let h = this.held.get(key);
    if (h) {
      this.held.delete(key); this.held.set(key, h);
    } else {
      h = { chunk: this.terrain.chunk(cx, cy), forest: null };
      this.held.set(key, h);
      this.stats.built++;
      for (const fn of this.listeners) fn(h.chunk);
      if (this.held.size > this.keep) {
        const oldest = this.held.keys().next().value!;
        this.held.delete(oldest);
        if (oldest === this.lastKey) this.last = null;
      }
      this.stats.held = this.held.size;
    }
    this.lastKey = key; this.last = h;
    return h;
  }
  zone(x: number, y: number): number {
    const T = this.T, cx = Math.floor(x / T), cy = Math.floor(y / T);
    return this.get(cx, cy).chunk.zones[(y - cy * T) * T + (x - cx * T)]!;
  }
  level(x: number, y: number): number {
    const T = this.T, cx = Math.floor(x / T), cy = Math.floor(y / T);
    return this.get(cx, cy).chunk.heights[(y - cy * T) * T + (x - cx * T)]!;
  }
  forest(x: number, y: number): boolean {
    if (!this.scenery || x < 0 || y < 0 || x >= this.cols || y >= this.rows) return false;
    const T = this.T, cx = Math.floor(x / T), cy = Math.floor(y / T);
    const h = this.get(cx, cy);
    if (!h.forest) {
      // Trees a tile outside the chunk can make its edge tiles forest, so read the items round it too.
      const box = { x0: cx * T, y0: cy * T, x1: (cx + 1) * T, y1: (cy + 1) * T };
      const items = this.sceneryIn({ x0: box.x0 - 1, y0: box.y0 - 1, x1: box.x1 + 1, y1: box.y1 + 1 })!;
      const set = forestOf(this.cols, this.rows, (a, b) => this.zone(a, b), this.blocked, items, box);
      const mask = new Uint8Array(T * T);
      for (const i of set) { const ix = i % this.cols, iy = (i - ix) / this.cols; mask[(iy - box.y0) * T + (ix - box.x0)] = 1; }
      h.forest = mask;
      // Reading the items may have pushed this chunk out of the cache; it is still the one asked for.
    }
    return h.forest[(y - cy * T) * T + (x - cx * T)] === 1;
  }
  sceneryIn(box: TileBoxLike): SceneryDef | null {
    if (!this.scenery) return null;
    const T = this.T, out: Items = { kind: [], x: [], y: [], size: [] };
    const cx0 = Math.max(0, Math.floor(box.x0 / T)), cx1 = Math.min(Math.ceil(this.cols / T) - 1, Math.floor((box.x1 - 1e-9) / T));
    const cy0 = Math.max(0, Math.floor(box.y0 / T)), cy1 = Math.min(Math.ceil(this.rows / T) - 1, Math.floor((box.y1 - 1e-9) / T));
    // Chunks row by row, items in each in tile order: the order a whole-map pass lays them, within each row of chunks.
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const s = this.get(cx, cy).chunk.scenery;
        for (let i = 0; i < s.kind.length; i++) {
          if (s.x[i]! < box.x0 || s.x[i]! >= box.x1 || s.y[i]! < box.y0 || s.y[i]! >= box.y1) continue;
          out.kind.push(s.kind[i]!); out.x.push(s.x[i]!); out.y.push(s.y[i]!); out.size.push(s.size[i]!);
        }
      }
    }
    return { ...this.scenery, items: out };
  }
  onChunk(fn: (c: MapChunk) => void): void { this.listeners.push(fn); }
}

/** How many chunks a streamed map holds at once: about a screen and a half each way at the widest zoom. */
export const STREAM_KEEP_CHUNKS = 160;

/**
 * The tiles of a map for drawing: streamed from its chunks when it has `terrain` and no `zones`
 * (a generated line made with `whole: false`), else decoded whole. `scenery` gives the bridges
 * (and, for a whole map, the items); a streamed map's items come from its chunks.
 */
export function mapTiles(map: MapDef & { terrain?: MapChunks }, scenery: SceneryDef | null, keep = STREAM_KEEP_CHUNKS): MapTiles {
  return !map.zones && map.terrain ? new StreamedTiles(map, map.terrain, scenery, keep) : new WholeTiles(map, scenery);
}
