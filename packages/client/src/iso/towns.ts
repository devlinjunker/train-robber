// Town spots on an open line (G3): a ring round the flat clearing and a signboard beside the
// track. Placeholders until towns are built in G6.
import { Graphics } from 'pixi.js';
import type { MapDef } from '@train-robber/config';
import { drawBox, groundEllipse } from './draw';

const RING = 0xe8d9a8, POST = 0x5a4026, BOARD = 0xc9a46a;

/** One static layer with every town's marker; empty on maps without towns. */
export function drawTowns(map: MapDef, surfaceZ: (x: number, y: number) => number = () => 0): Graphics {
  const g = new Graphics();
  g.label = 'iso-towns';
  for (const t of map.towns ?? []) {
    const z = surfaceZ(t.x, t.y);
    groundEllipse(g, t.x, t.y, t.radiusTiles, z).stroke({ width: 3, color: RING, alpha: 0.5 });
    // Two posts and a board, side on to the line (which runs east).
    for (const dx of [-1, 1]) drawBox(g, { x: t.x + dx, y: t.y, ux: 1, uy: 0, halfLength: 0.08, halfWidth: 0.08, z0: z, z1: z + 2.4 }, POST);
    drawBox(g, { x: t.x, y: t.y, ux: 1, uy: 0, halfLength: 1.4, halfWidth: 0.06, z0: z + 1.5, z1: z + 2.3 }, BOARD);
  }
  return g;
}
