import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import { BuildPacer, DepthBands, LazyChunks, setWarmUp, type BuildSteps, type Chunk, type LazyUnit } from '../src/iso/cells';

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

describe('LazyChunks stepped builds', () => {
  const chunk = (x0: number): Chunk => ({ g: new Graphics(), x0, y0: 0, x1: x0 + 10, y1: 10 });
  /** A unit at x0..x0+10 that builds in `steps` steps, counting them in `log`. */
  const stepped = (x0: number, steps: number, log: string[], onStep: () => void = () => {}): LazyUnit => ({
    box: { x0, y0: 0, x1: x0 + 10, y1: 10 },
    *build(): BuildSteps {
      for (let i = 0; i < steps; i++) { log.push(`${x0}:${i}`); onStep(); yield; }
      return [chunk(x0)];
    },
  });
  const view = { x0: 0, y0: 0, x1: 10, y1: 10 };
  /** A budget that is already spent: one step of a build near the view runs, then it waits. */
  const spent = () => ({ until: performance.now() - 1, must: view });

  it('builds a unit on screen at once, however many steps', () => {
    const log: string[] = [], built: Chunk[][] = [];
    const lazy = new LazyChunks([stepped(0, 5, log)], { onBuild: (c) => built.push(c) });
    expect(lazy.update(view, spent())).toBe(false);
    expect(log).toHaveLength(5);
    expect(lazy.chunks).toHaveLength(1);
    expect(built).toHaveLength(1);
  });

  it('builds a unit near the view a step a frame when the budget is spent, and says it is waiting', () => {
    const log: string[] = [], built: Chunk[][] = [];
    const lazy = new LazyChunks([stepped(20, 3, log)], { onBuild: (c) => built.push(c) });
    // Nothing starts once the frame's budget is gone.
    expect(lazy.update(view, spent())).toBe(true);
    expect(log).toHaveLength(0);
    // With budget it runs to the end.
    expect(lazy.update(view, { until: Infinity, must: view })).toBe(false);
    expect(log).toEqual(['20:0', '20:1', '20:2']);
    expect(built).toHaveLength(1);
    expect(lazy.chunks).toHaveLength(1);
  });

  /** Run `fn` with a clock that passes the frame's deadline (0.5) as soon as a build step has run. */
  const withClock = (fn: (c: { late(): void; reset(): void }) => void) => {
    let now = 0;
    const real = performance.now;
    performance.now = () => now;
    try { fn({ late: () => { now = 1; }, reset: () => { now = 0; } }); } finally { performance.now = real; }
  };

  it('picks a half-built unit up where it stopped, and finishes it before starting another', () => {
    withClock((clock) => {
      const log: string[] = [];
      const lazy = new LazyChunks([stepped(20, 3, log, clock.late), stepped(12, 2, log, clock.late)]);
      const frame = () => { clock.reset(); return lazy.update(view, { until: 0.5, must: view }); };
      expect(frame()).toBe(true);
      expect(log).toEqual(['12:0']);
      expect(frame()).toBe(true);
      expect(log).toEqual(['12:0', '12:1']);
      // The nearer unit ends before the further one starts.
      for (let i = 0; i < 5; i++) frame();
      expect(log).toEqual(['12:0', '12:1', '20:0', '20:1', '20:2']);
      expect(lazy.chunks).toHaveLength(2);
      expect(frame()).toBe(false);
    });
  });

  it('gives up a half-built unit left far behind', () => {
    withClock((clock) => {
      const log: string[] = [];
      const lazy = new LazyChunks([stepped(20, 3, log, clock.late)], {}, 24, 72);
      expect(lazy.update(view, { until: 0.5, must: view })).toBe(true);
      expect(log).toEqual(['20:0']);
      clock.reset();
      const far = { x0: 500, y0: 0, x1: 510, y1: 10 };
      expect(lazy.update(far, { until: 0.5, must: far })).toBe(false);
      // Back again, it starts over.
      clock.reset();
      lazy.update(view, { until: Infinity, must: view });
      expect(log).toEqual(['20:0', '20:0', '20:1', '20:2']);
      expect(lazy.chunks).toHaveLength(1);
    });
  });

  it('warms the pieces of a unit built ahead of the view, not of one needed at once', () => {
    const warmed: Graphics[] = [];
    setWarmUp((g) => warmed.push(g));
    try {
      const lazy = new LazyChunks([stepped(0, 1, []), stepped(20, 1, [])]);
      lazy.update(view, { until: performance.now() + 1000, must: view });
      expect(lazy.chunks).toHaveLength(2);
      expect(warmed).toHaveLength(1);
      expect(warmed[0]).toBe(lazy.chunks.find((c) => c.x0 === 20)!.g);
    } finally { setWarmUp(null); }
  });

  it('buildAll runs stepped builds to the end', () => {
    const log: string[] = [];
    const lazy = new LazyChunks([stepped(0, 2, log), stepped(900, 2, log)]).buildAll();
    expect(lazy.chunks).toHaveLength(2);
    expect(log).toHaveLength(4);
  });
});

describe('BuildPacer', () => {
  it('gives the most at a steady frame rate, the same share of a second at any refresh rate', () => {
    const at60 = new BuildPacer(), at144 = new BuildPacer();
    let a = 0, b = 0;
    for (let i = 0; i < 120; i++) { a = at60.next(1000 / 60); b = at144.next(1000 / 144); }
    expect(a).toBeCloseTo(4, 5);
    expect(b).toBeCloseTo(240 / 144, 5);
  });

  it('cuts back at once when a frame runs late, and comes back slowly', () => {
    const p = new BuildPacer();
    for (let i = 0; i < 60; i++) p.next(16.7);
    const late1 = p.next(33.4), late2 = p.next(33.4);
    expect(late1).toBeLessThan(3);
    expect(late2).toBeCloseTo(100 * 16.7 / 1000, 2);
    // Never below the least, and back to the most after a second of good frames.
    expect(p.next(50)).toBeCloseTo(1.67, 2);
    let v = 0;
    for (let i = 0; i < 30; i++) v = p.next(16.7);
    expect(v).toBeCloseTo(4, 1);
  });

  it('treats a steady slow frame rate as the rate to keep, capped per frame', () => {
    const p = new BuildPacer();
    let v = 0;
    for (let i = 0; i < 120; i++) v = p.next(33.3);
    expect(v).toBe(4);
  });
});
