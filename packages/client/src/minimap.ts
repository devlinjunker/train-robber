// The minimap: the whole map in a corner of the screen, turned the same way as the main view (a
// diamond in iso, flat top-down), with the track, every train, the rider and the part of the
// world on screen. M toggles it.
import { Container, Graphics, Matrix, Sprite, Texture } from 'pixi.js';
import { decodeZones, type MapDef, type SceneryDef } from '@train-robber/config';
import type { CarPose } from '@train-robber/sim';
import { forestTiles } from './iso/scenery';
import { TILE_H, TILE_W } from './projection';

/** Width of the minimap in screen pixels; its height follows the map. */
export const MINIMAP_W = 280;
const MARGIN = 8, TOP = 84, PAD = 6;

const COLOURS: Record<string, string> = { open: '#8fa865', slow: '#9c7d48', blocked: '#7a756c', water: '#6fa6dc', deep: '#2a5a9c' };
const FOREST = '#3f5a2e', BRIDGE = '#8b6a45', TRACK = '#2a1a10';
const TRAIN = 0xffffff, COMMITTED = 0xffb020, RIDER = 0x6bd3ff;

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
  ctx.lineWidth = Math.max(2, cols / 160);
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

export interface Minimap {
  root: Container;
  update(input: MinimapInput): void;
}

export function createMinimap(map: MapDef, scenery: SceneryDef | null): Minimap {
  const { cols, rows } = map.size;
  const root = new Container();
  root.label = 'minimap';
  const panel = new Graphics();
  const texture = Texture.from(paint(map, scenery));
  const ground = new Sprite(texture);
  const marks = new Graphics();
  const frame = new Container();
  frame.addChild(ground, marks);
  root.addChild(panel, frame);

  // World tiles to minimap pixels, for both orientations. Iso is the main view's projection
  // scaled down, shifted so the map's left corner (0, rows) sits at x = 0.
  const isoK = MINIMAP_W / ((cols + rows) * (TILE_W / 2));
  const topK = MINIMAP_W / cols;
  const size = (mode: MinimapMode) => mode === 'iso' ? { w: MINIMAP_W, h: (cols + rows) * (TILE_H / 2) * isoK } : { w: MINIMAP_W, h: rows * topK };
  const toMap = (mode: MinimapMode, x: number, y: number): [number, number] => mode === 'iso'
    ? [(x - y + rows) * (TILE_W / 2) * isoK, (x + y) * (TILE_H / 2) * isoK]
    : [x * topK, y * topK];
  let shown: MinimapMode | null = null, shownWidth = -1;

  return {
    root,
    update(input) {
      const { mode } = input;
      const { w, h } = size(mode);
      if (mode !== shown || input.screenWidth !== shownWidth) {
        shown = mode; shownWidth = input.screenWidth;
        // The sprite is one pixel per tile; its matrix is the same linear map as toMap.
        const [ox, oy] = toMap(mode, 0, 0), [ax, ay] = toMap(mode, 1, 0), [bx, by] = toMap(mode, 0, 1);
        ground.setFromMatrix(new Matrix(ax - ox, ay - oy, bx - ox, by - oy, ox, oy));
        root.position.set(input.screenWidth - w - MARGIN - PAD, TOP + PAD);
        panel.clear().roundRect(-PAD, -PAD, w + PAD * 2, h + PAD * 2, 6).fill({ color: 0x000000, alpha: 0.55 }).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
      }

      marks.clear();
      // What is on screen.
      if (input.view.length) {
        marks.poly(input.view.flatMap((p) => toMap(mode, p.x, p.y))).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
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
