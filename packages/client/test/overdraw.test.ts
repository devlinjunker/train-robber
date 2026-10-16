import { describe, expect, it } from 'vitest';
import { clipPolygon } from '../src/iso/overdraw';

describe('clipPolygon', () => {
  it('keeps a polygon inside the box as it is', () => {
    expect(clipPolygon([1, 1, 3, 1, 3, 3], 0, 0, 10, 10)).toEqual([1, 1, 3, 1, 3, 3]);
  });
  it('cuts a polygon to the box', () => {
    const pts = clipPolygon([-5, -5, 5, -5, 5, 5, -5, 5], 0, 0, 10, 10);
    const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBe(0); expect(Math.max(...xs)).toBe(5);
    expect(Math.min(...ys)).toBe(0); expect(Math.max(...ys)).toBe(5);
  });
  it('drops a polygon outside the box', () => {
    expect(clipPolygon([20, 20, 30, 20, 30, 30], 0, 0, 10, 10)).toEqual([]);
  });
});
