// What the horse (or a player on a ledge) ran into, for the crash notice. The sim only knows
// blocked ground; the view draws it as a boulder, a tree (forest, scenery.ts forestTiles) or a mesa
// (a plateau, iso/height.ts). Devlin, 2026-10-28: crashing into a tree or mesa still said "a rock".

export type ObstacleKind = 'rock' | 'tree' | 'mesa';

export interface ObstacleTiles {
  /** Whether tile (x, y) is blocked ground on the map. */
  blocked(x: number, y: number): boolean;
  /** Whether tile (x, y) reads as forest. */
  forest(x: number, y: number): boolean;
  /** Whether tile (x, y) is part of a mesa. */
  mesa(x: number, y: number): boolean;
}

/**
 * The obstacle nearest a world point (x, y): the blocked tile within `reach` tiles of it whose
 * square is closest, drawn as a mesa, a tree or a rock. A rock when none is in reach.
 */
export function obstacleNear(t: ObstacleTiles, x: number, y: number, reach: number): ObstacleKind {
  let best = Infinity, kind: ObstacleKind = 'rock';
  for (let ty = Math.floor(y - reach); ty <= Math.floor(y + reach); ty++) {
    for (let tx = Math.floor(x - reach); tx <= Math.floor(x + reach); tx++) {
      if (!t.blocked(tx, ty)) continue;
      const dx = Math.max(tx - x, 0, x - (tx + 1)), dy = Math.max(ty - y, 0, y - (ty + 1));
      const d = dx * dx + dy * dy;
      if (d > reach * reach || d >= best) continue;
      best = d;
      kind = t.mesa(tx, ty) ? 'mesa' : t.forest(tx, ty) ? 'tree' : 'rock';
    }
  }
  return kind;
}
