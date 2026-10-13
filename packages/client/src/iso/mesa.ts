// Mesas in the isometric view: raised ground cut off by cliffs (a plateau, see height.ts) drawn
// as a rounded rock with banded sandstone cliffs. Devlin, PR #25 playtest 2026-10-13: the
// tile-shaped cliffs read as blocks, so the outline is smoothed and roughened, the faces get
// strata colours, and a hole is cut through a mesa that hides the horse.
//
// A plateau's outline runs through the middles of its edge tiles' sides, is rounded twice
// (Chaikin) and pushed in and out by smooth noise. Its top is drawn per tile, clipped to the
// outline, and sorts like the ground; each cliff face segment sorts by its own depth, so the
// horse in front of a cliff draws over it and the horse behind is hidden by it.
import { Container, Graphics } from 'pixi.js';
import type { MapDef } from '@train-robber/config';
import { facesViewer, mix, shade } from './draw';
import { hash } from './terrain';
import { depthOf, isoX, isoY, TILE_H } from '../projection';
import { LEVEL_TILES, type HeightField, type Plateau } from './height';

/** Sandstone strata by height, the same on every mesa so the layers line up across the map. */
const STRATA = [0xb86a40, 0xcf9a62, 0xa85a38, 0xd9b07a, 0xc07848, 0x9a5236, 0xd2a06a, 0xb37046];
const BAND = LEVEL_TILES / 2;
const TOP_COLOUR = 0xa98760, CAP_COLOUR = 0xe2c494, SCRUB_COLOUR = 0x5f6a3a;
/** How far the outline wanders in and out, in tiles; it leans inward so cliffs stay off open ground. */
const WANDER = 0.45, WANDER_BIAS = 0.55;

interface V { x: number; y: number; zb: number; zt: number }

export interface MesaLayer {
  /** Sortable pieces; add them to the depth-sorted container. */
  strips: Graphics[];
  /** Masks for the see-through hole; add to the scene (not the sorted container). */
  masks: Container;
  /** Show only pieces that reach the screen band between `top` and `bottom` (unzoomed iso y pixels). */
  cull(top: number, bottom: number): void;
  /** Whether a mesa piece in front of world depth `depth` covers any of these iso pixel points. */
  hides(points: readonly (readonly [number, number])[], depth: number): boolean;
  /** Cut a round hole (iso pixels) through every piece in front of `depth` near it, or clear it with null. */
  cut(hole: { x: number; y: number; r: number } | null, depth: number): void;
}

interface Piece {
  g: Graphics;
  /** Screen polygons for hit tests, and their bounds. */
  polys: number[][];
  minX: number; minY: number; maxX: number; maxY: number;
  mask: Graphics | null;
  masked: boolean;
}

/** Smooth noise in 0..1 over the world, for the outline's wander. */
function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

const lerpV = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, zb: a.zb + (b.zb - a.zb) * t, zt: a.zt + (b.zt - a.zt) * t });

/**
 * The plateau's outlines, each a closed loop through the middles of its boundary sides. Loops run
 * so the outward normal of a step (dx, dy) is (dy, -dx). Outer loops have positive area.
 */
export function plateauOutlines(cols: number, rows: number, k: number, p: Plateau, field: HeightField): V[][] {
  const VC = cols + 1;
  interface E { from: number; to: number; dx: number; dy: number; mid: V; used: boolean }
  const byStart = new Map<number, E[]>();
  for (const i of p.tiles) {
    const x = i % cols, y = (i - x) / cols;
    // Clockwise round the tile on screen: top, right, bottom, left; the outside is (dy, -dx).
    for (const [ax, ay, dx, dy] of [[x, y, 1, 0], [x + 1, y, 0, 1], [x + 1, y + 1, -1, 0], [x, y + 1, 0, -1]] as const) {
      const ox = x + dy, oy = y - dx;
      if (field.plateauOf(ox, oy) === k) continue;
      const mx = ax + dx / 2, my = ay + dy / 2;
      const zt = p.topZ(mx - dy * 0.01, my + dx * 0.01);
      const other = field.plateauOf(ox, oy);
      const below = other < 0 || ox < 0 || oy < 0 || ox >= cols || oy >= rows
        ? field.groundZ(mx, my) : field.plateaus[other]!.topZ(mx + dy * 0.01, my - dx * 0.01);
      const e: E = { from: ay * VC + ax, to: (ay + dy) * VC + ax + dx, dx, dy, mid: { x: mx, y: my, zb: Math.min(below, zt), zt }, used: false };
      const list = byStart.get(e.from);
      if (list) list.push(e); else byStart.set(e.from, [e]);
    }
  }
  const loops: V[][] = [];
  for (const list of byStart.values()) {
    for (const first of list) {
      if (first.used) continue;
      const loop: V[] = [];
      let e: E | undefined = first;
      while (e && !e.used) {
        e.used = true;
        loop.push(e.mid);
        const next: E[] = (byStart.get(e.to) ?? []).filter((n) => !n.used);
        // Where two tiles touch only at a corner, keep turning right so each stays its own loop.
        const prev: E = e;
        e = next.find((n) => n.dx === -prev.dy && n.dy === prev.dx) ?? next[0];
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops.map((loop) => {
    let l = loop;
    for (let pass = 0; pass < 2; pass++) l = l.flatMap((a, i) => { const b = l[(i + 1) % l.length]!; return [lerpV(a, b, 0.25), lerpV(a, b, 0.75)]; });
    // Wander in and out along the normal, with a smooth swell and a little grit.
    return l.map((v, i) => {
      const a = l[(i + l.length - 1) % l.length]!, b = l[(i + 1) % l.length]!;
      const dx = b.x - a.x, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1;
      const off = (noise(v.x * 0.6 + k * 13.1, v.y * 0.6) - WANDER_BIAS) * WANDER + (noise(v.x * 2.2, v.y * 2.2 + k * 7.3) - 0.5) * 0.22 + (hash(Math.round(v.x * 40), Math.round(v.y * 40)) - 0.5) * 0.05;
      return { ...v, x: v.x + (dy / n) * off, y: v.y - (dx / n) * off };
    });
  });
}

const area = (l: V[]) => l.reduce((s, a, i) => { const b = l[(i + 1) % l.length]!; return s + a.x * b.y - b.x * a.y; }, 0) / 2;

/** Clip a polygon to the tile square at (tx, ty) (Sutherland–Hodgman; the square is convex). */
function clipToTile(poly: readonly V[], tx: number, ty: number): V[] {
  let out = poly as V[];
  const edges: [(v: V) => number][] = [[(v) => v.x - tx], [(v) => tx + 1 - v.x], [(v) => v.y - ty], [(v) => ty + 1 - v.y]];
  for (const [inside] of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!, b = input[(i + 1) % input.length]!;
      const da = inside(a), db = inside(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) out.push(lerpV(a, b, da / (da - db)));
    }
  }
  return out;
}

/** `alsoCut`: other sorted pieces (the boulders) that the hole goes through too. */
export function createMesas(map: MapDef, field: HeightField, alsoCut: readonly Graphics[] = []): MesaLayer {
  const masks = new Container();
  masks.label = 'mesa-masks';
  const pieces = new Map<number, Piece>();
  const piece = (zIndex: number): Piece => {
    let p = pieces.get(zIndex);
    if (!p) {
      const g = new Graphics();
      g.label = `mesa-${zIndex}`;
      g.zIndex = zIndex;
      p = { g, polys: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, mask: null, masked: false };
      pieces.set(zIndex, p);
    }
    return p;
  };
  const fill = (p: Piece, pts: number[], color: number | { color: number; alpha: number }, hit = false) => {
    p.g.poly(pts).fill(color);
    if (!hit) return;
    p.polys.push(pts);
    for (let i = 0; i < pts.length; i += 2) {
      p.minX = Math.min(p.minX, pts[i]!); p.maxX = Math.max(p.maxX, pts[i]!);
      p.minY = Math.min(p.minY, pts[i + 1]!); p.maxY = Math.max(p.maxY, pts[i + 1]!);
    }
  };
  const at = (v: { x: number; y: number }, z: number) => [isoX(v.x, v.y), isoY(v.x, v.y, z)];
  const { cols, rows } = map.size;

  field.plateaus.forEach((plateau, k) => {
    const loops = plateauOutlines(cols, rows, k, plateau, field);
    const outer = loops.filter((l) => area(l) > 0);
    // The top: each tile near the plateau, clipped to its outline, sorted like the ground.
    const near = new Set<number>();
    for (const i of plateau.tiles) {
      const x = i % cols, y = (i - x) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= 0 && y + dy >= 0 && x + dx < cols && y + dy < rows) near.add((y + dy) * cols + x + dx);
      }
    }
    for (const i of near) {
      const x = i % cols, y = (i - x) / cols;
      const p = piece(x + y - 0.005);
      // Each mesa's top leans toward a strata colour of its own.
      const tint = mix(TOP_COLOUR, STRATA[Math.floor(hash(k, 101) * STRATA.length)]!, 0.3);
      let interior = true;
      for (let dy = -1; dy <= 1 && interior; dy++) for (let dx = -1; dx <= 1; dx++) if (field.plateauOf(x + dx, y + dy) !== k) { interior = false; break; }
      const parts = interior
        ? [[{ x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 }] as V[]]
        : outer.map((l) => clipToTile(l, x, y)).filter((c) => c.length >= 3);
      for (const part of parts) {
        const z = part.map((v) => plateau.topZ(v.x, v.y));
        // Lit by slope like the ground, with a little tint per tile.
        const zs = [plateau.topZ(x, y), plateau.topZ(x + 1, y), plateau.topZ(x + 1, y + 1), plateau.topZ(x, y + 1)];
        const sx = (zs[1]! + zs[2]! - zs[0]! - zs[3]!) / 2, sy = (zs[3]! + zs[2]! - zs[0]! - zs[1]!) / 2;
        const kk = Math.min(1.25, Math.max(0.75, 1 + 0.6 * (sx + sy))) * (0.94 + 0.12 * hash(x * 7, y * 3));
        fill(p, part.flatMap((v, n) => at(v, z[n]!)), shade(tint, kk), true);
      }
      if (field.plateauOf(x, y) === k && hash(x + 31, y + 7) < 0.3) {
        // A scrub bush now and then on the top.
        const cx = x + 0.3 + 0.4 * hash(y, x + 3), cy = y + 0.3 + 0.4 * hash(x + 5, y), z = plateau.topZ(cx, cy), r = 0.12 + 0.1 * hash(x, y + 11);
        fill(p, [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]].flatMap(([px, py]) => at({ x: px!, y: py! }, z)), SCRUB_COLOUR);
      }
    }

    // Cliff faces toward the viewer, in runs that share a sort depth.
    for (const loop of loops) {
      const n = loop.length;
      const seg = (i: number) => {
        const a = loop[i]!, b = loop[(i + 1) % n]!;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const nx = dy / len, ny = -dx / len;
        const show = facesViewer(nx, ny) && (a.zt - a.zb > 0.02 || b.zt - b.zb > 0.02);
        return { a, b, nx, ny, show, key: Math.floor(depthOf((a.x + b.x) / 2, (a.y + b.y) / 2) * 4) / 4 };
      };
      // Start a run at a hidden segment or a change of depth, so no run wraps round the loop.
      const segs = Array.from({ length: n }, (_, i) => seg(i));
      let i0 = segs.findIndex((s, i) => !s.show || s.key !== segs[(i + n - 1) % n]!.key);
      if (i0 < 0) i0 = 0;
      let run: typeof segs = [];
      const flush = () => {
        if (!run.length) return;
        const p = piece(run[0]!.key);
        const vs = [run[0]!.a, ...run.map((s) => s.b)];
        const lo = Math.min(...vs.map((v) => v.zb)), hi = Math.max(...vs.map((v) => v.zt));
        for (let b = Math.floor(lo / BAND); b * BAND < hi; b++) {
          const z0 = vs.map((v) => Math.min(v.zt, Math.max(v.zb, b * BAND)));
          const z1 = vs.map((v) => Math.min(v.zt, Math.max(v.zb, (b + 1) * BAND)));
          if (z1.every((z, j) => z - z0[j]! < 1e-3)) continue;
          fill(p, [...vs.flatMap((v, j) => at(v, z0[j]!)), ...vs.map((v, j) => at(v, z1[j]!)).reverse().flat()], STRATA[((b % STRATA.length) + STRATA.length) % STRATA.length]!);
        }
        for (const s of run) {
          // Shade by which way it faces, with vertical streaks; a dark foot and a pale cap rock lip.
          const k2 = 0.8 + 0.14 * (s.ny - s.nx) + 0.12 * (hash(Math.round(s.a.x * 16), Math.round(s.a.y * 16)) - 0.5);
          const quad = (za: number, zb: number, wa: number, wb: number) => [...at(s.a, za), ...at(s.b, zb), ...at(s.b, wb), ...at(s.a, wa)];
          fill(p, quad(s.a.zb, s.b.zb, s.a.zt, s.b.zt), k2 < 1 ? { color: 0x000000, alpha: 1 - k2 } : { color: 0xffffff, alpha: k2 - 1 }, true);
          fill(p, quad(s.a.zb, s.b.zb, Math.min(s.a.zt, s.a.zb + 0.3), Math.min(s.b.zt, s.b.zb + 0.3)), { color: 0x000000, alpha: 0.16 });
          fill(p, quad(Math.max(s.a.zb, s.a.zt - 0.12), Math.max(s.b.zb, s.b.zt - 0.12), s.a.zt, s.b.zt), mix(CAP_COLOUR, TOP_COLOUR, 0.25));
        }
        run = [];
      };
      for (let j = 0; j < n; j++) {
        const s = segs[(i0 + j) % n]!;
        if (!s.show) { flush(); continue; }
        if (run.length && run[0]!.key !== s.key) flush();
        run.push(s);
      }
      flush();
    }
  });

  const list = [...pieces.values()].sort((a, b) => a.g.zIndex - b.g.zIndex);
  const cuttable = [...list, ...alsoCut.map((g): Piece => {
    const b = g.getLocalBounds();
    return { g, polys: [], minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, mask: null, masked: false };
  })];
  const margin = 2 * TILE_H;
  const inside = (pts: number[], px: number, py: number) => {
    let c = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const xi = pts[i]!, yi = pts[i + 1]!, xj = pts[j]!, yj = pts[j + 1]!;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  return {
    strips: list.map((p) => p.g),
    masks,
    cull(top, bottom) {
      for (const p of list) p.g.visible = p.maxY + margin >= top && p.minY - margin <= bottom;
    },
    hides(points, depth) {
      for (const p of list) {
        if (p.g.zIndex <= depth || !p.g.visible) continue;
        for (const [px, py] of points) {
          if (px < p.minX || px > p.maxX || py < p.minY || py > p.maxY) continue;
          if (p.polys.some((poly) => inside(poly, px, py))) return true;
        }
      }
      return false;
    },
    cut(hole, depth) {
      for (const p of cuttable) {
        const want = hole !== null && p.g.zIndex > depth && p.g.visible
          && hole.x + hole.r >= p.minX && hole.x - hole.r <= p.maxX && hole.y + hole.r >= p.minY && hole.y - hole.r <= p.maxY;
        if (want && hole) {
          if (!p.mask) { p.mask = new Graphics(); masks.addChild(p.mask); }
          p.mask.clear().circle(hole.x, hole.y, hole.r).fill(0xffffff);
        } else p.mask?.clear();
        if (want !== p.masked) { p.g.setMask({ mask: want ? p.mask : null, inverse: true }); p.masked = want; }
      }
    },
  };
}
