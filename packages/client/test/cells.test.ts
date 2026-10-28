import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import { DepthBands } from '../src/iso/cells';

const at = (z: number) => { const g = new Graphics(); g.zIndex = z; return g; };

describe('DepthBands', () => {
  it('puts each child in its depth band, bands in depth order', () => {
    const land = new DepthBands(10);
    const a = at(25), b = at(3), c = at(27), d = at(12);
    land.addChild(a, b, c, d);
    land.sortChildren();
    expect(land.children.map((band) => band.zIndex)).toEqual([0, 1, 2]);
    expect(a.parent).toBe(c.parent);
    expect(a.parent).not.toBe(b.parent);
    expect(land.children[2]!.isRenderGroup).toBe(true);
  });

  it('takes children out through the layer itself', () => {
    const land = new DepthBands(10);
    const a = at(5), b = at(15);
    land.addChild(a, b);
    land.removeChild(a);
    expect(a.parent).toBeNull();
    expect(b.parent?.parent).toBe(land);
  });
});
