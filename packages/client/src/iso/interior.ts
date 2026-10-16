// A car interior in the isometric view, drawn from its template and the cell catalog: the floor
// with flat patches for walkable cells that are not plain floor (doors, rugs, creaky boards), a
// box per blocking cell (walls, windows, crates, barrels) and a low box per walkable cell that
// gives cover (benches), and the loot lying in it. Used for the car you are aboard, and for the
// `?car=` debug scene.
import type { Graphics } from 'pixi.js';
import { carToWorld, type CarPose, type CellTypeDef, type PreparedCar } from '@train-robber/sim';
import { drawBox, groundEllipse, isoPoly, boxCorners, shade, type Box } from './draw';
import { depthOf } from '../projection';

/** Heights in tiles: low enough that you see over the walls into the car. */
export const WALL_HEIGHT = 0.9, PROP_HEIGHT = 0.75, SEAT_HEIGHT = 0.35;
export const FLOOR_COLOUR = 0x846446;
const STASH_COLOUR = 0x5a4a3a;
/** Loot colour by item category; unknown categories are gold. */
export const CATEGORY_COLOURS: Record<string, number> = { mail: 0xf0e6c8, cash: 0x6cbf6c, valuables: 0xd070e0, prize: 0xe8b830 };

export const colourOf = (hex: string): number => parseInt(hex.slice(1), 16);

/** How tall a cell type stands: blockers by whether they also block sight, cover you can walk over as a seat, the rest flat. */
export function cellHeight(t: Pick<CellTypeDef, 'blocksMove' | 'blocksSight' | 'cover'>): number {
  if (t.blocksMove) return t.blocksSight ? WALL_HEIGHT : PROP_HEIGHT;
  return t.cover > 0 ? SEAT_HEIGHT : 0;
}

export interface InteriorLoot { id: number; x: number; y: number; item: string; hidden: boolean }

export interface InteriorInput {
  car: CarPose;
  template: PreparedCar;
  cellTypes: readonly CellTypeDef[];
  /** Loot lying in this car, in its frame. */
  loot: readonly InteriorLoot[];
  /** Item definitions, for loot size and colour. */
  items: Readonly<Record<string, { weight: number; category: string }>>;
  /** The loot being searched, drawn with a ring. */
  searching: number | null;
  /** Loot within reach of E, drawn with a fainter ring. */
  inReach: number | null;
  timeSec: number;
}

/** Draws into `floor` (flat, under everything) and into sortable pieces from `piece`. */
export function drawInterior(floor: Graphics, piece: () => Graphics, input: InteriorInput): void {
  const { car, template: t, cellTypes } = input;
  const cellBox = (c: number, r: number, half: number, z1: number): Box => {
    const at = carToWorld(car, c + 0.5, r + 0.5);
    return { x: at.x, y: at.y, ux: car.ux, uy: car.uy, halfLength: half, halfWidth: half, z0: 0, z1 };
  };
  floor.poly(isoPoly(boxCorners({ ...car, z0: 0, z1: 0 }), 0.02)).fill(FLOOR_COLOUR);
  for (let r = 0; r < t.size.rows; r++) {
    for (let c = 0; c < t.size.cols; c++) {
      const type = cellTypes[t.cells[r * t.size.cols + c]!]!;
      const colour = colourOf(type.colour);
      const h = cellHeight(type);
      if (h === 0) {
        if (type.id !== 'floor') floor.poly(isoPoly(boxCorners(cellBox(c, r, 0.5, 0)), 0.03)).fill(colour);
        continue;
      }
      // Barrels are narrower than a cell; everything else fills it.
      const b = cellBox(c, r, type.id === 'barrel' ? 0.36 : 0.5, h);
      const g = piece();
      drawBox(g, b, colour);
      g.zIndex = depthOf(b.x, b.y);
    }
  }
  for (const l of input.loot) {
    const def = input.items[l.item];
    const heavy = (def?.weight ?? 0) >= 2;
    const at = carToWorld(car, l.x, l.y);
    const half = l.hidden ? 0.3 : heavy ? 0.36 : 0.2;
    const b: Box = { x: at.x, y: at.y, ux: car.ux, uy: car.uy, halfLength: half, halfWidth: half * 0.8, z0: 0, z1: l.hidden ? 0.3 : heavy ? 0.55 : 0.3 };
    const g = piece();
    if (l.id === input.searching || l.id === input.inReach) {
      groundEllipse(g, at.x, at.y, 0.6, 0.04).stroke({ width: 3, color: 0xffffff, alpha: l.id === input.searching ? 0.9 : 0.45 });
    }
    // Visible loot pulses gently so it reads as something to take; a hidden stash does not.
    const glow = l.hidden ? 1 : 1 + 0.18 * Math.sin(input.timeSec * 4 + l.id);
    drawBox(g, b, shade(l.hidden ? STASH_COLOUR : CATEGORY_COLOURS[def?.category ?? ''] ?? 0xe8b830, glow));
    g.zIndex = depthOf(at.x, at.y) + 0.01;
  }
}
