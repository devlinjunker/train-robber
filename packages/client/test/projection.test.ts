import { describe, expect, it } from 'vitest';
import { DEFAULT_ZOOM, isoX, isoY, keyDirToWorld, screenDirToWorld, screenToWorld, stepZoom, worldToScreen, ZOOM_STEPS, type Camera } from '../src/projection';

const cam: Camera = { x: 200, y: 170, zoom: 0.7, width: 1280, height: 800 };

describe('projection', () => {
  it('is 2:1 isometric with 64 × 32 tiles', () => {
    expect([isoX(1, 0), isoY(1, 0)]).toEqual([32, 16]);
    expect([isoX(0, 1), isoY(0, 1)]).toEqual([-32, 16]);
    expect(isoY(0, 0, 1)).toBe(-32);
  });

  it('puts the camera point at the screen centre', () => {
    expect(worldToScreen(cam.x, cam.y, 0, cam)).toEqual({ x: 640, y: 400 });
  });

  it('round-trips world to screen to world on the ground', () => {
    for (const [x, y] of [[0, 0], [200, 170], [123.4, 56.7], [399, 1]] as const) {
      const s = worldToScreen(x, y, 0, cam);
      const w = screenToWorld(s.x, s.y, cam);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.y).toBeCloseTo(y, 9);
    }
  });

  it('maps screen directions through the inverse projection', () => {
    const r = Math.SQRT1_2;
    const close = (a: [number, number], b: [number, number]) => { expect(a[0]).toBeCloseTo(b[0], 9); expect(a[1]).toBeCloseTo(b[1], 9); };
    close(screenDirToWorld(1, 0), [r, -r]);   // right on screen
    close(screenDirToWorld(0, -1), [-r, -r]); // up on screen
    close(screenDirToWorld(0, 1), [r, r]);    // down
    close(screenDirToWorld(-1, 0), [-r, r]);  // left
    expect(screenDirToWorld(0, 0)).toEqual([0, 0]);
    // A screen diagonal lands on a world axis: up-right is -y.
    close(screenDirToWorld(1, -0.5), [0, -1]);
  });

  it('a world direction from a screen direction projects back to that screen direction', () => {
    for (const [dx, dy] of [[1, 0], [0, -1], [1, 1], [-1, -1], [0.3, 0.9]] as const) {
      const [wx, wy] = screenDirToWorld(dx, dy);
      const sx = isoX(wx, wy), sy = isoY(wx, wy);
      expect(Math.atan2(sy, sx)).toBeCloseTo(Math.atan2(dy, dx), 9);
    }
  });

  it('maps keys like the inverse projection, with diagonals on the tile axes', () => {
    for (const [dx, dy] of [[1, 0], [0, -1], [-1, 0], [0, 1]] as const) {
      const a = keyDirToWorld(dx, dy), b = screenDirToWorld(dx, dy);
      expect(a[0]).toBeCloseTo(b[0], 9);
      expect(a[1]).toBeCloseTo(b[1], 9);
    }
    const ur = keyDirToWorld(1, -1), dr = keyDirToWorld(1, 1);
    expect([ur[0] + 0, ur[1]]).toEqual([0, -1]);
    expect(dr[0]).toBeCloseTo(1, 9);
    expect(dr[1] + 0).toBeCloseTo(0, 9);
  });

  it('steps zoom between the configured levels, from in between too', () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
    expect(stepZoom(0.7, 1)).toBe(1);
    expect(stepZoom(0.7, -1)).toBe(0.5);
    expect(stepZoom(0.8, -1)).toBe(0.7);
    expect(stepZoom(0.8, 1)).toBe(1);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(stepZoom(ZOOM_STEPS[0]!, -1)).toBe(ZOOM_STEPS[0]);
  });
});
