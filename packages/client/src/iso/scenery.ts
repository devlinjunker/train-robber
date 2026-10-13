// Render-only scenery in the isometric view: forest floor under trees, plank bridges, bushes
// and flowers on the ground, and trees that depth-sort against the horse and the cars. Placeholder art in the same flat-shaded style as the cars.
import { Container, Graphics } from 'pixi.js';
import { decodeZones, SOLID_SCENERY, type MapDef, type SceneryDef, type SceneryKind } from '@train-robber/config';
import { drawBox, groundEllipse, isoPoly, shade } from './draw';
import { depthOf, isoX, isoY, TILE_H } from '../projection';

export const FOREST_FLOOR = 0x3f5a2e;
const BRIDGE = 0x8b6a45, BRIDGE_RAIL = 0x5a3d26;
const TREE = 0x3f8a3a, PINE = 0x2c6b45, TRUNK = 0x6b4a2a, BUSH = 0x5f9446;
const FLOWERS = [0xf2a7c8, 0xf6e27a, 0xffffff];
/** Trees in the same diagonal band (x + y) and stretch across it share one depth-sorted Graphics. */
const BAND_TILES = 1, ACROSS_TILES = 16;
/** Bushes and flowers are drawn in square cells of this many tiles. */
const COVER_CELL = 24;

/** A piece of scenery and the tiles it covers, so pieces off screen can be skipped. */
export interface Chunk { g: Graphics; x0: number; y0: number; x1: number; y1: number }

/** Show only the chunks that overlap a box of world tiles. */
export function cullChunks(chunks: readonly Chunk[], view: { x0: number; y0: number; x1: number; y1: number }): void {
  for (const c of chunks) c.g.visible = c.x1 >= view.x0 && c.x0 <= view.x1 && c.y1 >= view.y0 && c.y0 <= view.y1;
}

/** Group item indices by a key, keeping each group's tile bounds. */
function group(indices: readonly number[], x: readonly number[], y: readonly number[], key: (i: number) => number) {
  const out = new Map<number, { items: number[]; x0: number; y0: number; x1: number; y1: number }>();
  for (const i of indices) {
    const k = key(i);
    let gr = out.get(k);
    if (!gr) out.set(k, gr = { items: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    gr.items.push(i);
    gr.x0 = Math.min(gr.x0, x[i]! - 1); gr.y0 = Math.min(gr.y0, y[i]! - 1);
    gr.x1 = Math.max(gr.x1, x[i]! + 1); gr.y1 = Math.max(gr.y1, y[i]! + 1);
  }
  return out;
}

/**
 * Rock tiles that read as forest: those holding a tree or next to one. Trees are scattered
 * rather than one per tile, so the neighbours keep gaps in a forest from showing bare rock.
 */
export function forestTiles(map: MapDef, scenery: SceneryDef): Set<number> {
  const { cols, rows } = map.size;
  const grid = decodeZones(map);
  const blocked = map.zoneLegend.indexOf('blocked');
  const out = new Set<number>();
  const { kind, x, y } = scenery.items;
  for (let i = 0; i < kind.length; i++) {
    if (!SOLID_SCENERY.has(scenery.kindLegend[kind[i]!]!)) continue;
    const tx = Math.floor(x[i]!), ty = Math.floor(y[i]!);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = tx + dx, ny = ty + dy;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && grid[ny * cols + nx] === blocked) out.add(ny * cols + nx);
      }
    }
  }
  return out;
}

/** The flat scenery: forest floor and bridge decks. Drawn under the track. */
export function drawSceneryFlat(map: MapDef, scenery: SceneryDef): Graphics {
  const g = new Graphics();
  g.label = 'iso-scenery-flat';
  const { cols } = map.size;

  for (const t of forestTiles(map, scenery)) {
    const tx = t % cols, ty = (t - tx) / cols;
    g.poly(isoPoly([[tx, ty], [tx + 1, ty], [tx + 1, ty + 1], [tx, ty + 1]]));
  }
  g.fill(FOREST_FLOOR);

  // Bridges: a deck with planks across the way you cross, and a dark edge on the two sides.
  for (const b of scenery.bridges) {
    const corners: [number, number][] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    g.poly(isoPoly(corners, 0.02)).fill(BRIDGE);
    if (b.along === 'x') {
      for (let x = b.x + 0.5; x < b.x + b.w; x += 0.5) g.moveTo(isoX(x, b.y), isoY(x, b.y, 0.02)).lineTo(isoX(x, b.y + b.h), isoY(x, b.y + b.h, 0.02));
    } else {
      for (let y = b.y + 0.5; y < b.y + b.h; y += 0.5) g.moveTo(isoX(b.x, y), isoY(b.x, y, 0.02)).lineTo(isoX(b.x + b.w, y), isoY(b.x + b.w, y, 0.02));
    }
    g.stroke({ width: 1, color: shade(BRIDGE, 0.75) });
    const sides = b.along === 'x' ? [[0, 1], [3, 2]] : [[0, 3], [1, 2]];
    for (const [i, j] of sides) {
      const [ax, ay] = corners[i!]!, [ex, ey] = corners[j!]!;
      g.moveTo(isoX(ax, ay), isoY(ax, ay, 0.02)).lineTo(isoX(ex, ey), isoY(ex, ey, 0.02));
    }
    g.stroke({ width: 4, color: BRIDGE_RAIL });
  }

  return g;
}

/** Ground cover: bushes are low mounds, flowers a few dots. In cells, so off-screen cells cull. */
export function drawSceneryCover(scenery: SceneryDef): Chunk[] {
  const { kind, x, y, size } = scenery.items;
  const cover: number[] = [];
  for (let i = 0; i < kind.length; i++) if (!SOLID_SCENERY.has(scenery.kindLegend[kind[i]!]!)) cover.push(i);
  const cells = group(cover, x, y, (i) => Math.floor(y[i]! / COVER_CELL) * 100000 + Math.floor(x[i]! / COVER_CELL));
  return [...cells.values()].map(({ items, ...box }) => {
    const g = new Graphics();
    for (const i of items) drawCover(g, scenery.kindLegend[kind[i]!]!, x[i]!, y[i]!, size[i]!, i);
    return { g, ...box };
  });
}

function drawCover(g: Graphics, k: SceneryKind, px: number, py: number, s: number, i: number): void {
  if (k === 'bush') {
    groundEllipse(g, px + 0.15, py + 0.15, 0.35 * s).fill({ color: 0x000000, alpha: 0.18 });
    g.ellipse(isoX(px, py), isoY(px, py, 0.25 * s), 13 * s, 9 * s).fill(BUSH);
    g.ellipse(isoX(px, py) - 3 * s, isoY(px, py, 0.32 * s), 7 * s, 5 * s).fill(shade(BUSH, 1.2));
  } else if (k === 'flowers') {
    // A clump of five blooms round a centre, each with a darker heart.
    for (let j = 0; j < 5; j++) {
      const a = (j / 5) * Math.PI * 2 + i, d = j === 0 ? 0 : 0.28 * s;
      const fx = px + Math.cos(a) * d, fy = py + Math.sin(a) * d;
      g.circle(isoX(fx, fy), isoY(fx, fy, 0.08), 4 * s).fill(FLOWERS[(i + j) % FLOWERS.length]!);
      g.circle(isoX(fx, fy), isoY(fx, fy, 0.08), 1.5 * s).fill(0xd08a2a);
    }
  }
}

/** One tree: a ground shadow, a trunk, and a round canopy or a stack of cones. */
function drawTree(g: Graphics, k: SceneryKind, x: number, y: number, s: number): void {
  groundEllipse(g, x + 0.45 * s, y + 0.45 * s, 0.6 * s).fill({ color: 0x000000, alpha: 0.22 });
  drawBox(g, { x, y, ux: 1, uy: 0, halfLength: 0.1 * s, halfWidth: 0.1 * s, z0: 0, z1: 0.8 * s }, TRUNK);
  const cx = isoX(x, y);
  if (k === 'pine') {
    // Three cones, wider at the bottom, each a lit left half and a shaded right half.
    for (const [z0, z1, half] of [[0.5, 1.9, 0.75], [1.2, 2.6, 0.58], [1.9, 3.2, 0.4]] as const) {
      const yb = isoY(x, y, z0 * s), yt = isoY(x, y, z1 * s), w = half * s * TILE_H;
      g.poly([cx, yt, cx - w, yb, cx, yb + w * 0.25]).fill(shade(PINE, 1.15));
      g.poly([cx, yt, cx, yb + w * 0.25, cx + w, yb]).fill(PINE);
    }
  } else {
    const r = 0.85 * s * TILE_H, cy = isoY(x, y, 1.6 * s);
    g.circle(cx, cy, r).fill(shade(TREE, 0.85));
    g.circle(cx - r * 0.25, cy - r * 0.25, r * 0.7).fill(TREE);
    g.circle(cx - r * 0.4, cy - r * 0.4, r * 0.3).fill(shade(TREE, 1.2));
  }
}

/**
 * Trees grouped by diagonal band and by stretch across it, each group one Graphics with its zIndex
 * at the band's depth, to add to the depth-sorted objects container: the horse and the cars draw in
 * front of trees behind them and behind trees in front of them.
 */
export function drawTrees(scenery: SceneryDef): Chunk[] {
  const { kind, x, y, size } = scenery.items;
  const trees: number[] = [];
  for (let i = 0; i < kind.length; i++) if (SOLID_SCENERY.has(scenery.kindLegend[kind[i]!]!)) trees.push(i);
  // Back to front, so trees in one group overlap correctly.
  trees.sort((a, b) => depthOf(x[a]!, y[a]!) - depthOf(x[b]!, y[b]!));
  const band = (i: number) => Math.floor(depthOf(x[i]!, y[i]!) / BAND_TILES);
  const groups = group(trees, x, y, (i) => band(i) * 100000 + Math.floor((x[i]! - y[i]! + 100000) / ACROSS_TILES));
  return [...groups.values()].map(({ items, ...box }) => {
    const g = new Graphics();
    g.zIndex = (band(items[0]!) + 0.5) * BAND_TILES;
    for (const i of items) drawTree(g, scenery.kindLegend[kind[i]!]!, x[i]!, y[i]!, size[i]!);
    // Canopies stand up to about 3 tiles tall, which reaches about 6 tiles up the screen.
    return { g, ...box, x0: box.x0 - 4, y0: box.y0 - 4 };
  });
}

/** All of a map's scenery for the iso scene. */
export interface SceneryLayers {
  /** Forest floor and bridges, then bushes and flowers: goes under the track. */
  ground: Container;
  /**
   * Hide what is outside a box of world tiles. Tree groups on screen join the depth-sorted
   * `objects` container and leave it when they go off screen, so it only sorts what is drawn.
   */
  cull(view: { x0: number; y0: number; x1: number; y1: number }): void;
}

export function createSceneryLayers(map: MapDef, scenery: SceneryDef, objects: Container): SceneryLayers {
  const ground = new Container();
  ground.label = 'iso-scenery-ground';
  const cover = drawSceneryCover(scenery);
  ground.addChild(drawSceneryFlat(map, scenery), ...cover.map((c) => c.g));
  const trees = drawTrees(scenery);
  return {
    ground,
    cull(view) {
      cullChunks(cover, view);
      for (const t of trees) {
        const on = t.x1 >= view.x0 && t.x0 <= view.x1 && t.y1 >= view.y0 && t.y0 <= view.y1;
        if (on && !t.g.parent) objects.addChild(t.g);
        else if (!on && t.g.parent) objects.removeChild(t.g);
      }
    },
  };
}
