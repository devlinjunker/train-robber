// Static ground drawing split into square cells of tiles, so cells off screen can be hidden and
// the GPU only draws what is in view. A whole-map Graphics on big-country is hundreds of
// thousands of vertices a frame, almost all of them off screen.
import { Container, Graphics, type ContainerChild } from 'pixi.js';

/** A box of world tiles. */
export interface TileBox { x0: number; y0: number; x1: number; y1: number }

/** A piece of drawing and the tiles it covers, so pieces off screen can be skipped. */
export interface Chunk extends TileBox { g: Graphics }

/** Show only the chunks that overlap a box of world tiles. */
export function cullChunks(chunks: readonly Chunk[], view: TileBox): void {
  for (const c of chunks) c.g.visible = c.x1 >= view.x0 && c.x0 <= view.x1 && c.y1 >= view.y0 && c.y0 <= view.y1;
}

/** Graphics per square cell of `size` tiles, made on first use. */
export class Cells {
  private readonly cells = new Map<number, { g: Graphics; cx: number; cy: number }>();
  constructor(private readonly size = 24, private readonly margin = 1) {}

  /** The Graphics for the cell holding world point (x, y). */
  at(x: number, y: number): Graphics {
    const cx = Math.floor(x / this.size), cy = Math.floor(y / this.size), k = cy * 100000 + cx;
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, c = { g: new Graphics(), cx, cy });
    return c.g;
  }

  /** Run `fn` on every cell, e.g. to fill the shapes drawn into them. */
  each(fn: (g: Graphics) => void): this {
    for (const c of this.cells.values()) fn(c.g);
    return this;
  }

  /** The cells as chunks, their boxes grown by `margin` tiles for drawing that pokes out. */
  chunks(): Chunk[] {
    const s = this.size, m = this.margin;
    return [...this.cells.values()].map(({ g, cx, cy }) => ({ g, x0: cx * s - m, y0: cy * s - m, x1: (cx + 1) * s + m, y1: (cy + 1) * s + m }));
  }
}

/**
 * Sortable pieces of static drawing for the depth-sorted objects container, one Graphics per sort
 * depth and stretch of ACROSS tiles along it (x - y), each with the box of tiles it draws over.
 * Pieces off screen leave the container (see cullSorted), so the GPU draws and Pixi sorts only
 * what is in view; a whole diagonal row of the map is mostly off screen.
 */
export class SortedCells {
  private readonly cells = new Map<string, Chunk>();
  constructor(private readonly label: string, private readonly across = 16, private readonly margin = 2) {}

  /**
   * The Graphics for sort depth `zIndex` holding world point (x, y), grown to cover it. `lift` is
   * how high (tiles) the drawing there stands: it reaches that far further up the screen.
   */
  at(zIndex: number, x: number, y: number, lift = 0): Graphics {
    const k = `${zIndex}:${Math.floor((x - y) / this.across)}`;
    let c = this.cells.get(k);
    if (!c) {
      const g = new Graphics();
      g.label = `${this.label}-${zIndex}`;
      g.zIndex = zIndex;
      this.cells.set(k, c = { g, x0: x, y0: y, x1: x, y1: y });
    }
    c.x0 = Math.min(c.x0, x - lift); c.y0 = Math.min(c.y0, y - lift);
    c.x1 = Math.max(c.x1, x); c.y1 = Math.max(c.y1, y);
    return c.g;
  }

  /** The pieces with their boxes grown by the margin, back to front. */
  chunks(): Chunk[] {
    const m = this.margin;
    return [...this.cells.values()]
      .map((c) => ({ g: c.g, x0: c.x0 - m, y0: c.y0 - m, x1: c.x1 + m, y1: c.y1 + m }))
      .sort((a, b) => a.g.zIndex - b.g.zIndex);
  }
}

/** Put the chunks that overlap a box of world tiles into `container`, and take the rest out. */
export function cullSorted(chunks: readonly Chunk[], view: TileBox, container: Container): void {
  for (const c of chunks) {
    const on = c.x1 >= view.x0 && c.x0 <= view.x1 && c.y1 >= view.y0 && c.y0 <= view.y1;
    if (on && !c.g.parent) container.addChild(c.g);
    else if (!on && c.g.parent) container.removeChild(c.g);
  }
}

/**
 * Maps with more tiles than this build their static drawing in regions as they come into view and
 * drop them once far away (G3: a 4,000-tile open line built whole took about 5 GB). Smaller maps,
 * every hand-made one included, build everything at load in one region, as before.
 */
export const LAZY_AREA_TILES = 800 * 400;
/** Side of a lazily built region, in tiles: a multiple of the 24-tile cells and 2-tile boulder cells. */
export const REGION_TILES = 48;

/** The edge of a region in tiles for a map this size: REGION_TILES on a big map, else the whole map. */
export function regionSize(map: { size: { cols: number; rows: number } }): number {
  const { cols, rows } = map.size;
  return cols * rows > LAZY_AREA_TILES ? REGION_TILES : Math.max(cols, rows);
}

/**
 * How far along a depth row (x - y, tiles) one sorted piece reaches. Lazily built regions hold
 * one piece per depth row per layer, since every piece in the static land layer is repacked by Pixi
 * whenever any piece comes or goes (G5 perf: about 4,900 pieces at 0.25x zoom took 40-75 ms);
 * maps built whole keep pieces 32 tiles across so ones off screen still drop out.
 */
export function sortedAcross(map: { size: { cols: number; rows: number } }, region: number): number {
  return region < Math.max(map.size.cols, map.size.rows) ? 2 * region : 32;
}

/** A piece of a layer that is built when it comes near the view: `box` is the tiles its drawing can reach. */
export interface LazyUnit { box: TileBox; build(): Chunk[] }

/**
 * Graphics built since the scene last warmed them up: Pixi triangulates a Graphics the first
 * time it is drawn, and a fresh region's pieces all coming into view in one frame made that
 * frame stutter, so the scene triangulates them a few at a time first (worldScene warmUp).
 */
export const freshlyBuilt: Graphics[] = [];

/**
 * A deadline (performance.now() ms) shared by every layer's building in one frame, and the box
 * that must be built at once whatever the deadline (the view when not given).
 */
export interface BuildBudget { until: number; must?: TileBox }

const overlaps = (a: TileBox, b: TileBox) => a.x1 >= b.x0 && a.x0 <= b.x1 && a.y1 >= b.y0 && a.y0 <= b.y1;
const grow = (b: TileBox, m: number): TileBox => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });

/**
 * Units of drawing built on demand: those overlapping the view are built at once, those within
 * `prefetch` tiles of it while the frame's budget lasts (nearest first), and built ones further
 * than `drop` tiles away are destroyed. `onBuild` and `onDrop` hear about chunks coming and going.
 */
export class LazyChunks {
  private readonly built = new Map<LazyUnit, Chunk[]>();
  private list: Chunk[] = [];
  constructor(
    private readonly units: readonly LazyUnit[],
    private readonly hooks: { onBuild?(chunks: Chunk[]): void; onDrop?(chunks: Chunk[]): void } = {},
    private readonly prefetch = 24,
    private readonly drop = 72,
  ) {}

  /** Every chunk built so far. */
  get chunks(): readonly Chunk[] { return this.list; }

  /** Build every unit now (small maps, and tests). */
  buildAll(): this {
    for (const u of this.units) if (!this.built.has(u)) this.add(u);
    return this;
  }

  /** Build and drop for this view; true while units near it are still waiting for budget. */
  update(view: TileBox, budget: BuildBudget = { until: Infinity }): boolean {
    let changed = false;
    for (const [u, chunks] of this.built) {
      if (overlaps(u.box, grow(view, this.drop))) continue;
      this.built.delete(u);
      this.hooks.onDrop?.(chunks);
      for (const c of chunks) { c.g.parent?.removeChild(c.g); c.g.destroy({ context: true }); }
      changed = true;
    }
    const near = grow(view, this.prefetch), cx = (view.x0 + view.x1) / 2, cy = (view.y0 + view.y1) / 2;
    const todo = this.units.filter((u) => !this.built.has(u) && overlaps(u.box, near));
    const dist = (u: LazyUnit) => Math.max(0, u.box.x0 - cx, cx - u.box.x1) + Math.max(0, u.box.y0 - cy, cy - u.box.y1);
    todo.sort((a, b) => dist(a) - dist(b));
    let waiting = false;
    for (const u of todo) {
      if (!overlaps(u.box, budget.must ?? view) && performance.now() > budget.until) { waiting = true; continue; }
      this.add(u, false);
      changed = true;
    }
    if (changed) this.list = [...this.built.values()].flat();
    return waiting;
  }

  private add(u: LazyUnit, refresh = true): void {
    const chunks = u.build();
    for (const c of chunks) freshlyBuilt.push(c.g);
    this.built.set(u, chunks);
    this.hooks.onBuild?.(chunks);
    if (refresh) this.list = [...this.built.values()].flat();
  }
}

/** One unit per region of `size` tiles over the map, each reaching `reach` tiles past its region. */
export function regionUnits(map: { size: { cols: number; rows: number } }, size: number, reach: number, build: (region: TileBox, index: number) => Chunk[]): LazyUnit[] {
  const { cols, rows } = map.size, out: LazyUnit[] = [];
  for (let y0 = 0, i = 0; y0 < rows; y0 += size) {
    for (let x0 = 0; x0 < cols; x0 += size, i++) {
      const region = { x0, y0, x1: Math.min(cols, x0 + size), y1: Math.min(rows, y0 + size) }, index = i;
      out.push({ box: grow(region, reach), build: () => build(region, index) });
    }
  }
  return out;
}

/** Whether world point (x, y) is in a region (half-open, so each point has one region). */
export const inRegion = (r: TileBox, x: number, y: number) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;

/** Add the chunks' Graphics to a container (Pixi's addChild with no arguments throws). */
export function addChunks(into: Container, chunks: readonly Chunk[]): void {
  if (chunks.length) into.addChild(...chunks.map((c) => c.g));
}

/**
 * A depth-sorted layer split into bands of `depth` sort depth (x + y), each its own render group.
 * Children go into their band by zIndex (set it before adding), and bands sort by depth, so the
 * drawing order is the same as one sorted container's. Pixi repacks a render group whole whenever
 * a child comes or goes, so a cull at the top or bottom of the view only repacks the bands there,
 * not the thousands of land pieces on screen (line perf: 25-50 ms headless repacks at 0.25x).
 */
export class DepthBands extends Container {
  private readonly bands = new Map<number, Container>();
  /** Adds and removals waiting for `flush`, by band, while `deferred`. */
  private readonly adds = new Map<number, Set<ContainerChild>>();
  private readonly removes = new Map<number, Set<ContainerChild>>();
  /**
   * While true, adds and removals wait for `flush`, which applies them a few bands a frame, so a
   * cull's repacking spreads over frames instead of landing in one (riding fast while zoomed out).
   */
  deferred = false;
  constructor(private readonly depth = 48) {
    super();
    this.sortableChildren = true;
  }

  private key(c: ContainerChild): number { return Math.floor(c.zIndex / this.depth); }

  private band(k: number): Container {
    let band = this.bands.get(k);
    if (!band) {
      band = new Container();
      band.label = `${this.label}-band-${k}`;
      band.sortableChildren = true;
      band.zIndex = k;
      band.enableRenderGroup();
      this.bands.set(k, band);
      super.addChild(band);
    }
    return band;
  }

  override addChild<U extends ContainerChild[]>(...children: U): U[0] {
    for (const c of children) {
      const k = this.key(c);
      if (!this.deferred) { this.band(k).addChild(c); continue; }
      this.removes.get(k)?.delete(c);
      if (c.parent?.parent === this) continue;
      let set = this.adds.get(k);
      if (!set) this.adds.set(k, set = new Set());
      set.add(c);
    }
    return children[0] as U[0];
  }

  override removeChild<U extends ContainerChild[]>(...children: U): U[0] {
    for (const c of children) {
      const k = this.key(c);
      this.adds.get(k)?.delete(c);
      if (!(c.parent && c.parent.parent === this)) continue;
      if (!this.deferred) { c.parent.removeChild(c); continue; }
      let set = this.removes.get(k);
      if (!set) this.removes.set(k, set = new Set());
      set.add(c);
    }
    return children[0] as U[0];
  }

  /** Whether a child is waiting to be added. */
  pendingAdd(c: ContainerChild): boolean { return this.adds.get(this.key(c))?.has(c) ?? false; }

  /**
   * Apply what is waiting in up to `bands` bands (all of them when not given): bands with pieces
   * to add first, then ones with only removals. True when anything changed.
   */
  flush(bands = Infinity): boolean {
    let done = 0;
    const apply = (k: number) => {
      const add = this.adds.get(k), remove = this.removes.get(k);
      const band = this.band(k);
      if (remove) for (const c of remove) if (c.parent === band) band.removeChild(c);
      if (add) for (const c of add) if (!c.destroyed && !c.parent) band.addChild(c);
      this.adds.delete(k); this.removes.delete(k);
      done++;
    };
    for (const k of [...this.adds.keys()]) { if (done >= bands) break; if (this.adds.get(k)!.size) apply(k); else this.adds.delete(k); }
    for (const k of [...this.removes.keys()]) { if (done >= bands) break; if (this.removes.get(k)!.size) apply(k); else this.removes.delete(k); }
    return done > 0;
  }
}
