// The separate-mode train scene: one plain walled car with a striped backdrop that scrolls past
// at the train's speed (minimal by decision Q16). The car is drawn in its own small world where
// its front points up-right on screen, whatever the real track does.
import { Container, Graphics } from 'pixi.js';
import { CAR_TEMPLATES, WALKER_RADIUS } from '@train-robber/sim';
import { drawBox, groundEllipse, isoPoly, shade } from './draw';
import { depthOf } from '../projection';
import { CAR_COLOURS } from './worldScene';
import { GROUND } from './terrain';
import { carCellToInterior } from './interiorFrame';

export { carCellToInterior, interiorDirToCar } from './interiorFrame';

/** Width of one backdrop stripe, in tiles; the pattern repeats every two. */
const STRIPE = 3;
const BACKDROP_HALF = 40;
const WALL_HEIGHT = 1.3;

export interface InteriorScene {
  root: Container;
  /** Draw the car (rebuilt when the template changes), the player and the backdrop at `trainD`. */
  update(template: string, player: { x: number; y: number }, trainD: number): { x: number; y: number };
}

export function createInteriorScene(): InteriorScene {
  const root = new Container();
  root.label = 'iso-interior';
  const backdrop = new Graphics();
  const floor = new Graphics();
  const objects = new Container();
  objects.sortableChildren = true;
  const playerG = new Graphics();
  root.addChild(backdrop, floor, objects);
  let built = '';

  const build = (template: string) => {
    const t = CAR_TEMPLATES[template]!;
    const colour = CAR_COLOURS[template] ?? 0x777777;
    floor.clear();
    for (const g of objects.removeChildren()) if (g !== playerG) g.destroy();
    objects.addChild(playerG);
    // Floor planks, then the door gaps in the door colour.
    for (let c = 0; c < t.size.cols; c++) {
      for (let r = 0; r < t.size.rows; r++) {
        const cell = t.cells[r * t.size.cols + c]!;
        const p = carCellToInterior(template, c, r);
        const tint = cell === 'door' ? 0xe8c872 : (c + r) % 2 ? 0x7b5b3e : 0x846446;
        floor.poly(isoPoly([[p.x, p.y], [p.x + 1, p.y], [p.x + 1, p.y + 1], [p.x, p.y + 1]])).fill(tint);
        if (cell !== 'wall') continue;
        // Each wall cell is its own low box, so the player sorts between them.
        const wall = new Graphics();
        drawBox(wall, { x: p.x + 0.5, y: p.y + 0.5, ux: 0, uy: -1, halfLength: 0.5, halfWidth: 0.5, z0: 0, z1: WALL_HEIGHT }, colour);
        wall.zIndex = depthOf(p.x + 0.5, p.y + 0.5);
        objects.addChild(wall);
      }
    }
    built = template;
  };

  return {
    root,
    update(template, player, trainD) {
      if (built !== template) build(template);
      // Backdrop: stripes across the direction of travel, moving toward the rear (+y) with the train,
      // and the track under the car with its ties scrolling the same way.
      backdrop.clear();
      const off = trainD % (STRIPE * 2);
      for (let y = -BACKDROP_HALF - STRIPE * 2 + off; y < BACKDROP_HALF; y += STRIPE * 2) {
        backdrop.poly(isoPoly([[-BACKDROP_HALF, y], [BACKDROP_HALF, y], [BACKDROP_HALF, y + STRIPE], [-BACKDROP_HALF, y + STRIPE]])).fill(GROUND);
        backdrop.poly(isoPoly([[-BACKDROP_HALF, y + STRIPE], [BACKDROP_HALF, y + STRIPE], [BACKDROP_HALF, y + STRIPE * 2], [-BACKDROP_HALF, y + STRIPE * 2]])).fill(shade(GROUND, 0.88));
      }
      for (let y = -BACKDROP_HALF + (trainD % 1); y < BACKDROP_HALF; y += 1) backdrop.poly(isoPoly([[-1.2, y], [1.2, y], [1.2, y + 0.3], [-1.2, y + 0.3]]));
      backdrop.fill(0x5a3d26);
      const at = carCellToInterior(template, player.x, player.y);
      playerG.clear();
      groundEllipse(playerG, at.x, at.y, WALKER_RADIUS).fill({ color: 0x000000, alpha: 0.3 });
      drawBox(playerG, { x: at.x, y: at.y, ux: 0, uy: -1, halfLength: WALKER_RADIUS, halfWidth: WALKER_RADIUS, z0: 0, z1: 1.7 }, 0x6bd3ff);
      playerG.zIndex = depthOf(at.x, at.y);
      return at;
    },
  };
}
