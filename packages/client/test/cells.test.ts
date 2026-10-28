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

describe('DepthBands deferred', () => {
  it('holds adds and removals until flushed, a few bands at a time', () => {
    const land = new DepthBands(10);
    const a = at(5), b = at(15), c = at(25);
    land.addChild(a);
    land.deferred = true;
    land.addChild(b, c);
    land.removeChild(a);
    expect(b.parent).toBeNull();
    expect(a.parent).not.toBeNull();
    expect(land.flush(1)).toBe(true);
    expect([b.parent, c.parent].filter(Boolean)).toHaveLength(1);
    land.flush();
    expect(b.parent).not.toBeNull();
    expect(c.parent).not.toBeNull();
    expect(a.parent).toBeNull();
    expect(land.flush()).toBe(false);
  });

  it('cancels an add removed before it lands', () => {
    const land = new DepthBands(10);
    land.deferred = true;
    const a = at(5);
    land.addChild(a);
    land.removeChild(a);
    land.flush();
    expect(a.parent).toBeNull();
  });
});
