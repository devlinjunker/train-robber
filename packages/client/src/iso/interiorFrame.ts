// The train scene's own small world: the car sits at the origin with its front pointing up-right
// on screen (toward -y), whatever the real track does. Pure maths, shared by the scene and input.
import { CAR_TEMPLATES } from '@train-robber/sim';

/**
 * Car-frame cells (x from the front, y from the left) to the interior scene's world. The front
 * points toward -y (up-right on screen) and the right side toward +x.
 */
export function carCellToInterior(template: string, cx: number, cy: number): { x: number; y: number } {
  const t = CAR_TEMPLATES[template]!;
  return { x: cy - t.size.rows / 2, y: cx - t.size.cols / 2 };
}

/** An interior-scene world direction as [toward the front, toward the right side]. */
export function interiorDirToCar(wx: number, wy: number): [number, number] {
  return [-wy, wx];
}
