// Static ground drawing split into square cells of tiles, so cells off screen can be hidden and
// the GPU only draws what is in view. A whole-map Graphics on big-country is hundreds of
// thousands of vertices a frame, almost all of them off screen.
import { Graphics, type Container } from 'pixi.js';

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
