// Render-only scenery in the isometric view: forest floor under trees, plank bridges, bushes
// and flowers on the ground, and trees that depth-sort against the horse and the cars. Placeholder art in the same flat-shaded style as the cars.
import { Container, Graphics } from 'pixi.js';
import { decodeZones, SOLID_SCENERY, type MapDef, type SceneryDef, type SceneryKind } from '@train-robber/config';
import { drawBox, groundEllipse, isoPoly, shade, oval } from './draw';
import { Cells, cullChunks, type Chunk, type TileBox } from './cells';
import { depthOf, isoX, isoY, TILE_H } from '../projection';

export const FOREST_FLOOR = 0x3f5a2e;
const BRIDGE = 0x8b6a45, BRIDGE_RAIL = 0x5a3d26;
const TREE = 0x3f8a3a, PINE = 0x2c6b45, TRUNK = 0x6b4a2a, BUSH = 0x5f9446;
const FLOWERS = [0xf2a7c8, 0xf6e27a, 0xffffff];
/** Trees in the same diagonal band (x + y) and stretch across it share one depth-sorted Graphics. */
const BAND_TILES = 1, ACROSS_TILES = 6;
/** A lone tree (none other within about this many tiles) is drawn this much bigger. */
const LONE_TILES = 3, LONE_SCALE = 1.4;
/**
 * Trees in front of the horse that cover it fade to this alpha (Devlin, 2026-10-13), easing at
 * FADE_RATE per second.
 */
const FADED_ALPHA = 0.15, FADE_RATE = 8;
/** Bushes and flowers are drawn in square cells of this many tiles. */
const COVER_CELL = 24, FLAT_CELL = 24;

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

/**
 * The flat scenery: forest floor and bridge decks, drawn under the track. In cells and one piece
 * per bridge, so pieces off screen cull; the forest floor is one strip per run of forest tiles.
 */
export function drawSceneryFlat(map: MapDef, scenery: SceneryDef): Chunk[] {
  const { cols, rows } = map.size;
  const forest = forestTiles(map, scenery), floor = new Cells(FLAT_CELL);
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      if (!forest.has(y * cols + x)) { x++; continue; }
      const stop = Math.min(cols, (Math.floor(x / FLAT_CELL) + 1) * FLAT_CELL);
      let end = x + 1;
      while (end < stop && forest.has(y * cols + end)) end++;
      floor.at(x, y).poly(isoPoly([[x, y], [end, y], [end, y + 1], [x, y + 1]]));
      x = end;
    }
  }
  floor.each((g) => { g.label = 'iso-scenery-flat'; g.fill(FOREST_FLOOR); });
  const out = floor.chunks();

  // Bridges: a deck with planks across the way you cross, and a dark edge on the two sides.
  for (const b of scenery.bridges) {
    const g = new Graphics();
    g.label = 'iso-bridge';
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
    out.push({ g, x0: b.x - 1, y0: b.y - 1, x1: b.x + b.w + 1, y1: b.y + b.h + 1 });
  }

  return out;
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
    oval(g, isoX(px, py), isoY(px, py, 0.25 * s), 13 * s, 9 * s).fill(BUSH);
    oval(g, isoX(px, py) - 3 * s, isoY(px, py, 0.32 * s), 7 * s, 5 * s).fill(shade(BUSH, 1.2));
  } else if (k === 'flowers') {
    // A clump of five blooms round a centre, each with a darker heart.
    for (let j = 0; j < 5; j++) {
      const a = (j / 5) * Math.PI * 2 + i, d = j === 0 ? 0 : 0.28 * s;
      const fx = px + Math.cos(a) * d, fy = py + Math.sin(a) * d;
      oval(g, isoX(fx, fy), isoY(fx, fy, 0.08), 4 * s).fill(FLOWERS[(i + j) % FLOWERS.length]!);
      oval(g, isoX(fx, fy), isoY(fx, fy, 0.08), 1.5 * s).fill(0xd08a2a);
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
    oval(g, cx, cy, r).fill(shade(TREE, 0.85));
    oval(g, cx - r * 0.25, cy - r * 0.25, r * 0.7).fill(TREE);
    oval(g, cx - r * 0.4, cy - r * 0.4, r * 0.3).fill(shade(TREE, 1.2));
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
  // A tree with no other within LONE_TILES stands alone in open country: drawn bigger, so it reads
  // as an obstacle before you hit it (Devlin, 2026-10-13: single trees were hard to see).
  const near = new Map<number, number>();
  const cellKey = (cx: number, cy: number) => cy * 100000 + cx;
  for (const i of trees) {
    const k = cellKey(Math.floor(x[i]! / LONE_TILES), Math.floor(y[i]! / LONE_TILES));
    near.set(k, (near.get(k) ?? 0) + 1);
  }
  const lone = (i: number) => {
    const cx = Math.floor(x[i]! / LONE_TILES), cy = Math.floor(y[i]! / LONE_TILES);
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += near.get(cellKey(cx + dx, cy + dy)) ?? 0;
    return n === 1;
  };
  return [...groups.values()].map(({ items, ...box }) => {
    const g = new Graphics();
    g.zIndex = (band(items[0]!) + 0.5) * BAND_TILES;
    for (const i of items) drawTree(g, scenery.kindLegend[kind[i]!]!, x[i]!, y[i]!, size[i]! * (lone(i) ? LONE_SCALE : 1));
    // Canopies stand up to about 3 tiles tall, which reaches about 6 tiles up the screen.
    return { g, ...box, x0: box.x0 - 4, y0: box.y0 - 4 };
  });
}

/** All of a map's scenery for the iso scene. */
export interface SceneryLayers {
  /** Forest floor and bridges, then bushes and flowers: goes under the track. */
  ground: Container;
  /** The tree groups, sorted pieces for `objects`. */
  trees: Graphics[];
  /**
   * Hide what is outside a box of world tiles. Tree groups on screen join the depth-sorted
   * `objects` container and leave it when they go off screen, so it only sorts what is drawn.
   */
  cull(view: TileBox): void;
  /**
   * Fade the tree groups in front of a point (the horse, or the player aboard), at world (x, y)
   * and screen height z tiles, that cover it on screen; `dt` in seconds. Null fades nothing.
   */
  fade(at: { x: number; y: number; z: number } | null, dt: number): void;
}

export function createSceneryLayers(map: MapDef, scenery: SceneryDef, objects: Container): SceneryLayers {
  const ground = new Container();
  ground.label = 'iso-scenery-ground';
  const flat = drawSceneryFlat(map, scenery), cover = [...flat, ...drawSceneryCover(scenery)];
  ground.addChild(...cover.map((c) => c.g));
  const trees = drawTrees(scenery).map((t) => ({ ...t, bounds: t.g.getLocalBounds().rectangle.clone() }));
  return {
    ground,
    trees: trees.map((t) => t.g),
    fade(at, dt) {
      const px = at && isoX(at.x, at.y), py = at && isoY(at.x, at.y, at.z), depth = at && depthOf(at.x, at.y);
      const k = 1 - Math.exp(-FADE_RATE * dt);
      for (const t of trees) {
        if (!t.g.parent) continue;
        const b = t.bounds;
        // Covers it: in front (deeper), and its drawing spans the point with a little room.
        const covers = at !== null && t.g.zIndex > depth! && px! > b.x - 24 && px! < b.x + b.width + 24 && py! > b.y - 24 && py! < b.y + b.height;
        const target = covers ? FADED_ALPHA : 1;
        if (t.g.alpha !== target) t.g.alpha = Math.abs(t.g.alpha - target) < 0.01 ? target : t.g.alpha + (target - t.g.alpha) * k;
      }
    },
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
