// Static drawing that sorts with moving things (hills, mesas, boulders, trees) lives in its own
// render group under everything that moves, so Pixi packs its geometry once instead of every
// frame: in the sorted objects container it was repacked whenever the horse or a car moved, which
// cost more than everything else in a frame. Where a static piece is in front of a moving thing
// and overlaps it on screen, a copy of the piece clipped to that thing's screen box is drawn in the
// sorted objects container, so it still covers the thing. Every static piece in front of the thing
// and over that box gets its copy, so the copies stack in the same order as the originals.
import { Graphics, GraphicsContext, Polygon, type Container } from 'pixi.js';

/**
 * What an unused copy's mask draws. Pixi draws a Graphics again once it stops being a mask, so a
 * mask still sharing a hole's context would show as a white disc (Devlin, PR #25 playtest).
 */
const NO_HOLE = new GraphicsContext();

/** Something that moves: its sort depth and its box on screen, in iso pixels. */
export interface Mover { zIndex: number; minX: number; minY: number; maxX: number; maxY: number }

type Style = { color: number; alpha: number };
interface Shape { pts: number[]; closed: boolean; fill: Style | null; stroke: (Style & { width: number }) | null; minX: number; minY: number; maxX: number; maxY: number }
interface Static { g: Graphics; shapes: Shape[] | null; minX: number; minY: number; maxX: number; maxY: number }

/** Shapes and their styles from a Graphics made of polygons and polylines. */
function shapesOf(g: Graphics): Shape[] {
  const out: Shape[] = [];
  for (const ins of g.context.instructions) {
    if (ins.action !== 'fill' && ins.action !== 'stroke') continue;
    const style = ins.data.style as { color: number; alpha: number; width?: number };
    for (const prim of ins.data.path.shapePath.shapePrimitives) {
      if (!(prim.shape instanceof Polygon)) continue;
      const pts = prim.shape.points;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]!); maxX = Math.max(maxX, pts[i]!);
        minY = Math.min(minY, pts[i + 1]!); maxY = Math.max(maxY, pts[i + 1]!);
      }
      const pad = ins.action === 'stroke' ? (style.width ?? 1) : 0;
      out.push({
        pts, closed: ins.action === 'fill' || prim.shape.closePath,
        fill: ins.action === 'fill' ? { color: style.color, alpha: style.alpha } : null,
        stroke: ins.action === 'stroke' ? { color: style.color, alpha: style.alpha, width: style.width ?? 1 } : null,
        minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad,
      });
    }
  }
  return out;
}

/** A polygon (flat x, y list) clipped to a box. */
export function clipPolygon(pts: readonly number[], x0: number, y0: number, x1: number, y1: number): number[] {
  let out = pts.slice();
  const edges: [(x: number, y: number) => number][] = [[(x) => x - x0], [(x) => x1 - x], [(_, y) => y - y0], [(_, y) => y1 - y]];
  for (const [d] of edges) {
    const input = out;
    out = [];
    const n = input.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = input[i * 2]!, ay = input[i * 2 + 1]!, bx = input[((i + 1) % n) * 2]!, by = input[((i + 1) % n) * 2 + 1]!;
      const da = d(ax, ay), db = d(bx, by);
      if (da >= 0) out.push(ax, ay);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push(ax + (bx - ax) * t, ay + (by - ay) * t); }
    }
    if (out.length < 6) return [];
  }
  return out;
}

/** A line segment clipped to a box (Liang–Barsky), or null when it misses. */
function clipSegment(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): number[] | null {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as const) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; t0 = Math.max(t0, r); } else { if (r < t0) return null; t1 = Math.min(t1, r); }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}

export class Overdraw {
  private readonly statics: Static[] = [];
  private live: Static[] = [];
  private readonly pool: { g: Graphics; mask: Graphics; masked: boolean }[] = [];

  /** Copies go in `objects`; masks for copies of holed pieces go in `masks`. */
  constructor(private readonly objects: Container, private readonly masks: Container) {}

  /** Static pieces to copy where they cover a mover. */
  add(gs: readonly Graphics[]): void {
    for (const g of gs) {
      const b = g.getLocalBounds();
      this.statics.push({ g, shapes: null, minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
    }
  }

  /** Note which static pieces are on screen; call after culling. */
  refresh(): void {
    this.live = this.statics.filter((s) => s.g.parent && s.g.visible);
  }

  /** Draw this frame's copies over the movers. */
  update(movers: readonly Mover[]): void {
    let used = 0;
    for (const m of movers) {
      for (const s of this.live) {
        if (s.g.zIndex <= m.zIndex || s.maxX < m.minX || s.minX > m.maxX || s.maxY < m.minY || s.minY > m.maxY) continue;
        s.shapes ??= shapesOf(s.g);
        let slot = this.pool[used];
        if (!slot) {
          slot = { g: new Graphics(), mask: new Graphics(NO_HOLE), masked: false };
          slot.g.label = 'overdraw';
          this.pool.push(slot);
          this.objects.addChild(slot.g);
          this.masks.addChild(slot.mask);
        }
        used++;
        const g = slot.g;
        g.clear();
        g.visible = true;
        g.zIndex = s.g.zIndex;
        g.alpha = s.g.alpha;
        for (const sh of s.shapes) {
          if (sh.maxX < m.minX || sh.minX > m.maxX || sh.maxY < m.minY || sh.minY > m.maxY) continue;
          if (sh.fill) {
            const pts = clipPolygon(sh.pts, m.minX, m.minY, m.maxX, m.maxY);
            if (pts.length) g.poly(pts).fill(sh.fill);
          } else if (sh.stroke) {
            const n = sh.pts.length / 2, segs = sh.closed ? n : n - 1;
            for (let i = 0; i < segs; i++) {
              const j = (i + 1) % n;
              const c = clipSegment(sh.pts[i * 2]!, sh.pts[i * 2 + 1]!, sh.pts[j * 2]!, sh.pts[j * 2 + 1]!, m.minX, m.minY, m.maxX, m.maxY);
              if (c) g.moveTo(c[0]!, c[1]!).lineTo(c[2]!, c[3]!);
            }
            g.stroke(sh.stroke);
          }
        }
        // A piece with the hole cut through it (mesas, boulders) gets the same hole.
        const hole = s.g.mask as Graphics | undefined;
        if (hole) {
          if (slot.mask.context !== hole.context) slot.mask.context = hole.context;
          if (!slot.masked) { g.setMask({ mask: slot.mask, inverse: true }); slot.masked = true; }
        } else if (slot.masked) { g.mask = null; slot.mask.context = NO_HOLE; slot.masked = false; }
      }
    }
    for (let i = used; i < this.pool.length; i++) {
      const slot = this.pool[i]!;
      if (!slot.g.visible) continue;
      slot.g.visible = false;
      slot.g.clear();
      if (slot.masked) { slot.g.mask = null; slot.mask.context = NO_HOLE; slot.masked = false; }
    }
  }
}
