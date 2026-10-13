// Static ground drawing split into square cells of tiles, so cells off screen can be hidden and
// the GPU only draws what is in view. A whole-map Graphics on big-country is hundreds of
// thousands of vertices a frame, almost all of them off screen.
import { Graphics } from 'pixi.js';

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
