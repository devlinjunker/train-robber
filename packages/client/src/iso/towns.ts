// Town spots on an open line (G3): a ring round the flat clearing and a signboard beside the
// track. Placeholders until towns are built in G6.
import { Graphics } from 'pixi.js';
import type { MapDef } from '@train-robber/config';
import { drawBox, groundEllipse } from './draw';

const RING = 0xe8d9a8, POST = 0x5a4026, BOARD = 0xc9a46a;
// The camp (stakes PR): a gold ring where loot banks, a tent and a fire pit at the spawn.
const CAMP_RING = 0xffc857, CANVAS = 0xd8c7a0, FIRE = 0xd2542a;

/** One static layer with every town's marker, and the camp when loot banks there; empty on maps without either. */
export function drawTowns(map: MapDef, surfaceZ: (x: number, y: number) => number = () => 0, camp: { radiusTiles: number } | null = null): Graphics {
  const g = new Graphics();
  g.label = 'iso-towns';
  if (camp) {
    const { x, y } = map.markers.playerSpawn;
    const z = surfaceZ(x, y);
    groundEllipse(g, x, y, camp.radiusTiles, z).stroke({ width: 3, color: CAMP_RING, alpha: 0.6 });
    // A low tent beside the spawn, and a fire pit in front of it.
    drawBox(g, { x: x + 2.5, y: y - 2, ux: 1, uy: 0, halfLength: 1.1, halfWidth: 0.8, z0: z, z1: z + 1.3 }, CANVAS);
    drawBox(g, { x: x - 2, y: y - 2.5, ux: 1, uy: 0, halfLength: 0.35, halfWidth: 0.35, z0: z, z1: z + 0.25 }, FIRE);
  }
  for (const t of map.towns ?? []) {
    const z = surfaceZ(t.x, t.y);
    groundEllipse(g, t.x, t.y, t.radiusTiles, z).stroke({ width: 3, color: RING, alpha: 0.5 });
    // Two posts and a board, side on to the line (which runs east).
    for (const dx of [-1, 1]) drawBox(g, { x: t.x + dx, y: t.y, ux: 1, uy: 0, halfLength: 0.08, halfWidth: 0.08, z0: z, z1: z + 2.4 }, POST);
    drawBox(g, { x: t.x, y: t.y, ux: 1, uy: 0, halfLength: 1.4, halfWidth: 0.06, z0: z + 1.5, z1: z + 2.3 }, BOARD);
  }
  return g;
}
