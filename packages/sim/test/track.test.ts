import { describe, it, expect } from 'vitest';
import { trackAt, wrapDistance, type TrackRoute } from '../src/world/track';

// A 4 x 4 square loop sampled every tile, clockwise in screen space (y down), starting at (0, 0).
function square(): TrackRoute {
  const pts = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [4, 3], [4, 4], [3, 4], [2, 4], [1, 4], [0, 4], [0, 3], [0, 2], [0, 1]] as const;
  const n = pts.length;
  const col = (f: (i: number) => number) => pts.map((_, i) => f(i));
  return {
    closed: true, length: n, spacing: 1,
    samples: {
      x: col((i) => pts[i]![0]), y: col((i) => pts[i]![1]), s: col((i) => i),
      tx: col((i) => pts[(i + 1) % n]![0] - pts[i]![0]), ty: col((i) => pts[(i + 1) % n]![1] - pts[i]![1]),
    },
  };
}

const pick = ({ x, y, tx, ty }: { x: number; y: number; tx: number; ty: number }) => ({ x, y, tx, ty });

describe('trackAt', () => {
  const r = square();

  it('starts on the first sample at 0', () => {
    expect(trackAt(r, 0)).toEqual({ d: 0, x: 0, y: 0, tx: 1, ty: 0 });
  });

  it('interpolates position and keeps the segment tangent at known distances', () => {
    expect(pick(trackAt(r, 2.5))).toEqual({ x: 2.5, y: 0, tx: 1, ty: 0 });
    expect(pick(trackAt(r, 4))).toEqual({ x: 4, y: 0, tx: 0, ty: 1 });
    expect(pick(trackAt(r, 6.25))).toEqual({ x: 4, y: 2.25, tx: 0, ty: 1 });
    expect(pick(trackAt(r, 10))).toEqual({ x: 2, y: 4, tx: -1, ty: 0 });
  });

  it('runs the last segment back to the first sample', () => {
    expect(pick(trackAt(r, 15.5))).toEqual({ x: 0, y: 0.5, tx: 0, ty: -1 });
  });

  it('wraps past the end and before the start', () => {
    expect(trackAt(r, 16)).toEqual(trackAt(r, 0));
    expect(trackAt(r, 18.5)).toEqual(trackAt(r, 2.5));
    expect(trackAt(r, 16 * 3 + 6.25)).toEqual(trackAt(r, 6.25));
    expect(trackAt(r, -0.5)).toEqual(trackAt(r, 15.5));
    expect(wrapDistance(r, -16)).toBe(0);
  });

  it('copes with stored distances rounded either side of the even spacing', () => {
    const rounded = square();
    (rounded.samples.s as number[])[4] = 4.0001;
    const before = trackAt(rounded, 4);
    expect([before.x, before.tx]).toEqual([expect.closeTo(3.9999, 6), 1]);
    (rounded.samples.s as number[])[4] = 3.9999;
    expect(pick(trackAt(rounded, 4)).ty).toBe(1);
  });

  it('clamps an open route to its ends', () => {
    const open: TrackRoute = { ...r, closed: false, length: 15 };
    expect(pick(trackAt(open, -3))).toEqual({ x: 0, y: 0, tx: 1, ty: 0 });
    expect(pick(trackAt(open, 99))).toEqual({ x: 0, y: 1, tx: 0, ty: -1 });
  });

  it('reuses the out object', () => {
    const out = { d: 0, x: 0, y: 0, tx: 0, ty: 0 };
    expect(trackAt(r, 1, out)).toBe(out);
  });
});
