import { describe, expect, it } from 'vitest';
import { obstacleNear, type ObstacleTiles } from '../src/obstacle';

/** A strip of map: R rock, T forest, M mesa, . open. */
function tiles(rows: string[]): ObstacleTiles {
  const at = (x: number, y: number) => rows[y]?.[x] ?? '.';
  return { blocked: (x, y) => at(x, y) !== '.', forest: (x, y) => at(x, y) === 'T', mesa: (x, y) => at(x, y) === 'M' };
}

describe('obstacleNear', () => {
  const map = tiles(['....', 'R..T', '....', 'M...']);
  it('names the blocked tile beside the point', () => {
    expect(obstacleNear(map, 1.6, 1.5, 0.75)).toBe('rock');
    expect(obstacleNear(map, 2.4, 1.5, 0.75)).toBe('tree');
    expect(obstacleNear(map, 1.4, 3.5, 0.75)).toBe('mesa');
  });
  it('picks the nearest when two are in reach', () => {
    expect(obstacleNear(map, 1.3, 2.2, 1.5)).toBe('rock');
    expect(obstacleNear(map, 1.3, 2.8, 1.5)).toBe('mesa');
  });
  it('falls back to a rock with nothing in reach', () => {
    expect(obstacleNear(map, 2, 2.5, 0.2)).toBe('rock');
  });
});
