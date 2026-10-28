// The minimap: the whole map in a corner of the screen, turned the same way as the main view (a
// diamond in iso, flat top-down), with the track, every train, the rider and the part of the
// world on screen. M toggles it. On an open line, far longer than it is wide, it shows a window
// of the line around the rider instead, with a bar under it for where that is along the map.
import { Container, Graphics, Matrix, Sprite, Texture } from 'pixi.js';
import { decodeZones, SOLID_SCENERY, type MapChunk, type MapDef, type SceneryDef, type SceneryKind } from '@train-robber/config';
import type { CarPose } from '@train-robber/sim';
import { forestTiles } from './iso/scenery';
import { TILE_H, TILE_W } from './projection';
import type { MapTiles } from './tiles';

/** Width of the minimap in screen pixels; its height follows the map. */
export const MINIMAP_W = 280;
const MARGIN = 8, TOP = 84, PAD = 6;

const COLOURS: Record<string, string> = { open: '#8fa865', slow: '#9c7d48', blocked: '#7a756c', water: '#6fa6dc', deep: '#2a5a9c' };
const FOREST = '#3f5a2e', BRIDGE = '#8b6a45', TRACK = '#2a1a10';
const TRAIN = 0xffffff, COMMITTED = 0xffb020, RIDER = 0x6bd3ff, TOWN = 0xe8d9a8;
/** On a map more than this many times longer than wide, the minimap shows a window `rows x WINDOW_ASPECT` tiles long. */
const WINDOW_ASPECT = 1.5;

/** Tiles of map the minimap shows across: a window on a long line, else the whole map. */
const spanOf = (cols: number, rows: number) => cols > rows * WINDOW_ASPECT * 2 ? Math.round(rows * WINDOW_ASPECT) : cols;
/**
 * The track's width in tiles: a share of what the minimap shows across. A long line's is set by
 * its window, not its length, so it stays the same on a line of any length (Devlin found it far
 * too wide on a 20,000-tile line, PR #40); a loop's is unchanged.
 */
const trackWidth = (cols: number, rows: number) => Math.max(2, Math.min(cols, spanOf(cols, rows) * 4) / 160);
/** The bar under a windowed minimap: the whole line, with towns, the window and the rider on it (taller after Devlin missed it, PR #34). */
const BAR_H = 12;

export type MinimapMode = 'iso' | 'topdown';

export interface MinimapInput {
  mode: MinimapMode;
  screenWidth: number;
  cars: readonly CarPose[];
  committedTrain: string | null;
  /** The rider: the horse, or the player's place aboard. */
  rider: { x: number; y: number; hx: number; hy: number } | null;
  /** The ground under the screen's corners, in world tiles, clockwise from the top left. */
  view: readonly { x: number; y: number }[];
}

/** One pixel per tile: zones, forest floor, bridges and track. */
function paint(map: MapDef, scenery: SceneryDef | null): HTMLCanvasElement {
  const { cols, rows } = map.size;
  const canvas = document.createElement('canvas');
  canvas.width = cols; canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const grid = decodeZones(map);
  const forest = scenery ? forestTiles(map, scenery) : new Set<number>();
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      const i = y * cols + x, z = grid[i]!, f = forest.has(i);
      let end = x + 1;
      while (end < cols && grid[y * cols + end] === z && forest.has(y * cols + end) === f) end++;
      ctx.fillStyle = f ? FOREST : COLOURS[map.zoneLegend[z]!] ?? COLOURS.open!;
      ctx.fillRect(x, y, end - x, 1);
      x = end;
    }
  }
  if (scenery) {
    ctx.fillStyle = BRIDGE;
    for (const b of scenery.bridges) ctx.fillRect(b.x, b.y, b.w, b.h);
  }
  ctx.strokeStyle = TRACK;
  ctx.lineWidth = trackWidth(cols, rows);
  ctx.lineJoin = 'round';
  for (const r of map.routes) {
    const { x, y } = r.samples;
    ctx.beginPath();
    ctx.moveTo(x[0]!, y[0]!);
    for (let i = 1; i < x.length; i++) ctx.lineTo(x[i]!, y[i]!);
    if (r.closed) ctx.closePath();
    ctx.stroke();
  }
  return canvas;
}

/** A streamed map's minimap has one pixel per this many tiles each way. */
const STREAM_SCALE = 4;
const UNSEEN = '#3b3a33';

/** Draw the track over a part of the canvas (in tiles, drawn at 1/`scale`). */
function strokeTrack(ctx: CanvasRenderingContext2D, map: MapDef, path: Path2D) {
  ctx.strokeStyle = TRACK;
  ctx.lineWidth = trackWidth(map.size.cols, map.size.rows);
  ctx.lineJoin = 'round';
  ctx.stroke(path);
}

/**
 * A streamed map (tiles.ts) at one pixel per STREAM_SCALE tiles: dark until a chunk is first
 * built for the view, then painted in, so it fills in as the line is ridden.
 */
function streamedPaint(map: MapDef, tiles: MapTiles, scenery: SceneryDef | null) {
  const { cols, rows } = map.size, S = STREAM_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(cols / S); canvas.height = Math.ceil(rows / S);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = UNSEEN;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const path = new Path2D();
  for (const r of map.routes) {
    const { x, y } = r.samples;
    path.moveTo(x[0]!, y[0]!);
    for (let i = 1; i < x.length; i++) path.lineTo(x[i]!, y[i]!);
    if (r.closed) path.closePath();
  }
  // The whole track from the start, so the line ahead shows before its ground is painted in.
  ctx.save();
  ctx.scale(1 / S, 1 / S);
  strokeTrack(ctx, map, path);
  ctx.restore();
  const blocked = map.zoneLegend.indexOf('blocked');
  const queue: MapChunk[] = [];
  const done = new Set<number>();
  tiles.onChunk((c) => queue.push(c));
  const paintChunk = (c: MapChunk) => {
    const key = c.cy * 100_003 + c.cx;
    if (done.has(key) || c.cx < 0 || c.cy < 0) return;
    done.add(key);
    const T = c.zones.length ** 0.5, bx = c.cx * T, by = c.cy * T;
    // Forest: blocked tiles under or next to a tree, from this chunk's own trees.
    const forest = new Uint8Array(T * T);
    c.scenery.kind.forEach((k, i) => {
      if (!scenery || !SOLID_SCENERY.has(scenery.kindLegend[k]! as SceneryKind)) return;
      const tx = Math.floor(c.scenery.x[i]!) - bx, ty = Math.floor(c.scenery.y[i]!) - by;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (x >= 0 && y >= 0 && x < T && y < T && c.zones[y * T + x] === blocked) forest[y * T + x] = 1;
      }
    });
    // Each pixel is the tile at its middle.
    for (let py = 0; py < T / S; py++) {
      for (let px = 0; px < T / S; px++) {
        const i = (py * S + (S >> 1)) * T + px * S + (S >> 1);
        ctx.fillStyle = forest[i] ? FOREST : COLOURS[map.zoneLegend[c.zones[i]!]!] ?? COLOURS.open!;
        ctx.fillRect(bx / S + px, by / S + py, 1, 1);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx / S, by / S, T / S, T / S);
    ctx.clip();
    ctx.scale(1 / S, 1 / S);
    if (scenery) {
      ctx.fillStyle = BRIDGE;
      for (const b of scenery.bridges) ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    strokeTrack(ctx, map, path);
    ctx.restore();
  };
  return {
    canvas,
    /** Paint chunks built since the last call; true when any were. */
    flush(): boolean {
      if (!queue.length) return false;
      for (const c of queue.splice(0)) paintChunk(c);
      return true;
    },
  };
}

export interface Minimap {
  root: Container;
  update(input: MinimapInput): void;
}

export function createMinimap(map: MapDef, scenery: SceneryDef | null, tiles?: MapTiles): Minimap {
  const { cols, rows } = map.size;
  const root = new Container();
  root.label = 'minimap';
  const panel = new Graphics();
  const streamed = tiles?.streamed ? streamedPaint(map, tiles, scenery) : null;
  // Pixels per tile each way on the painted canvas.
  const scale = streamed ? STREAM_SCALE : 1;
  const texture = Texture.from(streamed ? streamed.canvas : paint(map, scenery));
  const ground = new Sprite(texture);
  const marks = new Graphics();
  const frame = new Container();
  // Long maps show a window that follows the rider, clipped to its edges.
  const span = spanOf(cols, rows);
  const windowed = span < cols;
  const clip = new Graphics();
  frame.addChild(ground, marks);
  if (windowed) { frame.addChild(clip); frame.mask = clip; }
  const bar = new Graphics();
  const barRider = new Graphics();
  root.addChild(panel, frame, bar, barRider);

  // World tiles to minimap pixels, for both orientations. Iso is the main view's projection
  // scaled down, shifted so the window's left corner (x0, rows) sits at x = 0.
  const isoK = MINIMAP_W / ((span + rows) * (TILE_W / 2));
  const topK = MINIMAP_W / span;
  const size = (mode: MinimapMode) => mode === 'iso' ? { w: MINIMAP_W, h: (span + rows) * (TILE_H / 2) * isoK } : { w: MINIMAP_W, h: rows * topK };
  let x0 = 0;
  const toMap = (mode: MinimapMode, x: number, y: number): [number, number] => mode === 'iso'
    ? [(x - x0 - y + rows) * (TILE_W / 2) * isoK, (x - x0 + y) * (TILE_H / 2) * isoK]
    : [(x - x0) * topK, y * topK];
  let shown: MinimapMode | null = null, shownWidth = -1, shownX0 = -1;

  return {
    root,
    update(input) {
      const { mode } = input;
      const { w, h } = size(mode);
      if (windowed) {
        // Keep the window on the rider, or the middle of the screen, in steps of a tenth of it.
        const at = input.rider?.x ?? (input.view.length ? input.view.reduce((a, p) => a + p.x, 0) / input.view.length : 0);
        const step = Math.max(1, Math.round(span / 10));
        x0 = Math.max(0, Math.min(cols - span, Math.round((at - span / 2) / step) * step));
      }
      if (mode !== shown || input.screenWidth !== shownWidth || x0 !== shownX0) {
        const resized = mode !== shown || input.screenWidth !== shownWidth;
        shown = mode; shownWidth = input.screenWidth; shownX0 = x0;
        // The sprite is one pixel per tile; its matrix is the same linear map as toMap.
        const [ox, oy] = toMap(mode, 0, 0), [ax, ay] = toMap(mode, 1, 0), [bx, by] = toMap(mode, 0, 1);
        ground.setFromMatrix(new Matrix((ax - ox) * scale, (ay - oy) * scale, (bx - ox) * scale, (by - oy) * scale, ox, oy));
        if (windowed) clip.clear().poly([[x0, 0], [x0 + span, 0], [x0 + span, rows], [x0, rows]].flatMap(([x, y]) => toMap(mode, x!, y!))).fill(0xffffff);
        if (resized) {
          root.position.set(input.screenWidth - w - MARGIN - PAD, TOP + PAD);
          const extra = windowed ? BAR_H + PAD + 3 : 0;
          panel.clear().roundRect(-PAD, -PAD, w + PAD * 2, h + PAD * 2 + extra, 6).fill({ color: 0x000000, alpha: 0.55 }).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
        }
        if (windowed) {
          // Where the window is along the whole line, with the towns on it.
          const by0 = h + PAD;
          bar.clear().roundRect(0, by0, w, BAR_H, 3).fill({ color: 0x000000, alpha: 0.5 }).stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
          // The window shaded, then each town a tall sand post.
          bar.rect((x0 / cols) * w, by0, Math.max(2, (span / cols) * w), BAR_H).fill({ color: 0xffffff, alpha: 0.25 }).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
          for (const t of map.towns ?? []) bar.rect((t.x / cols) * w - 2, by0 - 3, 4, BAR_H + 6).fill(TOWN).stroke({ width: 1, color: 0x000000 });
        }
      }

      // New chunks painted in (streamed maps); only while shown, as the update runs only then.
      if (streamed?.flush()) texture.source.update();
      marks.clear();
      // The rider on the bar: a dot that moves along the whole line.
      barRider.clear();
      if (windowed && input.rider) {
        const bx = Math.max(0, Math.min(w, (input.rider.x / cols) * w)), by = h + PAD + BAR_H / 2;
        barRider.circle(bx, by, 5).fill(RIDER).stroke({ width: 1.5, color: 0x000000 });
      }
      // What is on screen.
      if (input.view.length) {
        marks.poly(input.view.flatMap((p) => toMap(mode, p.x, p.y))).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
      }
      // Town spots: a ring round each clearing.
      for (const t of map.towns ?? []) {
        if (windowed && (t.x < x0 - t.radiusTiles || t.x > x0 + span + t.radiusTiles)) continue;
        const [x, y] = toMap(mode, t.x, t.y);
        marks.circle(x, y, 5).fill({ color: TOWN, alpha: 0.9 }).stroke({ width: 1.5, color: 0x000000 });
      }
      // Trains: each car a short stroke along its axis.
      for (const committed of [false, true]) {
        for (const c of input.cars) {
          if ((c.trainId === input.committedTrain) !== committed) continue;
          const [x0, y0] = toMap(mode, c.x - c.ux * c.halfLength, c.y - c.uy * c.halfLength);
          const [x1, y1] = toMap(mode, c.x + c.ux * c.halfLength, c.y + c.uy * c.halfLength);
          marks.moveTo(x0, y0).lineTo(x1, y1);
        }
        marks.stroke({ width: 4, color: committed ? COMMITTED : TRAIN, cap: 'round' });
      }
      // The rider: a dot with a tick for the heading.
      if (input.rider) {
        const r = input.rider;
        const [x, y] = toMap(mode, r.x, r.y), [hx, hy] = toMap(mode, r.x + r.hx * 12, r.y + r.hy * 12);
        marks.moveTo(x, y).lineTo(hx, hy).stroke({ width: 2, color: RIDER });
        marks.circle(x, y, 4).fill(RIDER).stroke({ width: 1.5, color: 0x000000 });
      }
    },
  };
}
