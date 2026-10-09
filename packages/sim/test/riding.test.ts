import { describe, it, expect } from 'vitest';
import { createSim, type Command, type GameState, type SimConfig, type SimMap } from '../src';
import { testConfig, testMap, type Paint } from './fixtures';

const W = { type: 'move', x: 0, y: -127 } as const;
const S = { type: 'move', x: 0, y: 127 } as const;
const RELEASE = { type: 'move', x: 0, y: 0 } as const;

/** A sim whose horse starts at (x, y) heading (hx, hy), clear of the train. */
function rider(horse: Partial<SimConfig['values']['horse']> = {}, opts: { paint?: Paint; x?: number; y?: number; hx?: number; hy?: number } = {}) {
  const map: SimMap = testMap(opts.paint);
  const sim = createSim({ config: testConfig(horse), map, seed: 'ride', playerIds: [1] });
  const h = (sim.state as GameState).world.horses[0]!;
  h.x = opts.x ?? 10; h.y = opts.y ?? 90; h.hx = opts.hx ?? 1; h.hy = opts.hy ?? 0;
  const run = (ticks: number, ...commands: Command[]) => {
    sim.step([{ player: 1, commands }]);
    for (let t = 1; t < ticks; t++) sim.step([]);
    return h;
  };
  return { sim, h, run };
}

const MODELS = ['hold', 'coast', 'cruise'] as const;

describe('throttle', () => {
  for (const throttleModel of MODELS) {
    it(`${throttleModel}: holding W reaches top speed and holds it`, () => {
      const { run } = rider({ throttleModel });
      expect(run(60, W).speed).toBeLessThan(14);
      expect(run(140).speed).toBe(14);
      expect(run(300).speed).toBe(14);
    });
  }

  it('accelerates at 8 tiles/s²', () => {
    const { run } = rider();
    expect(run(30, W).speed).toBeCloseTo(4, 9);
  });

  it('brakes at 12 tiles/s² to a stop and no further', () => {
    const { run } = rider();
    run(200, W);
    expect(run(30, S).speed).toBeCloseTo(8, 9);
    expect(run(60).speed).toBe(0);
  });

  it('hold: releasing W keeps the current speed', () => {
    const { run } = rider({ throttleModel: 'hold' });
    run(45, W);
    const v = run(1, RELEASE).speed;
    expect(run(300).speed).toBe(v);
  });

  it('coast: releasing W slows under drag to a stop', () => {
    const { h, run } = rider({ throttleModel: 'coast' });
    run(200, W);
    expect(run(60, RELEASE).speed).toBeCloseTo(10, 9);
    expect(run(160).speed).toBe(0);
    const x = h.x;
    expect(run(60).x).toBe(x);
  });

  it('cruise: W and S move a target speed that the horse settles on', () => {
    const { h, run } = rider({ throttleModel: 'cruise' });
    run(30, W);
    expect(h.cruiseTarget).toBeCloseTo(5, 9);
    expect(run(120, RELEASE).speed).toBeCloseTo(5, 9);
    expect(run(200).speed).toBeCloseTo(5, 9);
    run(12, S);
    expect(h.cruiseTarget).toBeCloseTo(3, 9);
    expect(run(60, RELEASE).speed).toBeCloseTo(3, 9);
  });

  it('cruise: S all the way down stops the horse', () => {
    const { run } = rider({ throttleModel: 'cruise' });
    run(200, W);
    const h = run(200, S);
    expect([h.speed, h.cruiseTarget]).toEqual([0, 0]);
  });
});

describe('steering', () => {
  const step = (2 * Math.PI) / 180;

  it('heading-relative: D turns clockwise on screen by the per-tick rotation', () => {
    const { run } = rider({ steering: 'heading' });
    const h = run(1, { type: 'move', x: 127, y: 0 });
    expect(h.hx).toBeCloseTo(Math.cos(step), 12);
    expect(h.hy).toBeCloseTo(Math.sin(step), 12);
    run(44);
    expect(h.hx).toBeCloseTo(0, 9);
    expect(h.hy).toBeCloseTo(1, 9);
  });

  it('heading-relative: A turns the other way and steer commands are ignored', () => {
    const { run } = rider({ steering: 'heading' });
    const h = run(1, { type: 'move', x: -127, y: 0 }, { type: 'steer', x: 127, y: 127 });
    expect(h.hy).toBeCloseTo(-Math.sin(step), 12);
  });

  it('screen-relative: turns toward the steer direction at the turn rate, then holds it', () => {
    const { run } = rider({ steering: 'screen' });
    const h = run(1, { type: 'steer', x: 0, y: 127 }, { type: 'move', x: 127, y: 0 });
    expect(h.hx).toBeCloseTo(Math.cos(step), 12);
    expect(h.hy).toBeCloseTo(Math.sin(step), 12);
    run(43);
    expect(h.hy).toBeLessThan(1);
    run(1);
    expect([h.hx, h.hy]).toEqual([0, 1]);
    run(10, { type: 'steer', x: 0, y: 0 });
    expect([h.hx, h.hy]).toEqual([0, 1]);
  });

  it('screen-relative: a diagonal steer settles on the unit diagonal', () => {
    const { run } = rider({ steering: 'screen' });
    const h = run(90, { type: 'steer', x: -127, y: -127 });
    expect(h.hx).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(h.hy).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('keeps the heading a unit vector over many turns', () => {
    const { run } = rider({ steering: 'heading' });
    const h = run(5000, { type: 'move', x: 127, y: -127 });
    expect(Math.hypot(h.hx, h.hy)).toBeCloseTo(1, 12);
  });
});

describe('terrain', () => {
  it('slow ground caps speed at half the top speed', () => {
    const { h, run } = rider({}, { paint: (x) => (x >= 40 ? 'slow' : 'open') });
    run(1, W);
    while (h.x < 39) run(1);
    expect(h.speed).toBe(14);
    while (h.x < 60) run(1);
    expect(h.speed).toBe(7);
  });

  it('reins in at the braking rate when entering slow ground', () => {
    const { h, run } = rider({}, { paint: (x) => (x >= 40 ? 'slow' : 'open') });
    run(1, W);
    while (h.x < 40) run(1);
    expect(h.speed).toBeGreaterThan(13);
    run(1);
    expect(h.speed).toBeCloseTo(14 - 12 / 60, 9);
  });

  for (const zone of ['blocked', 'water'] as const) {
    it(`${zone} tiles stop the horse at their edge`, () => {
      const { h, run } = rider({}, { paint: (x) => (x >= 40 ? zone : 'open') });
      run(400, W);
      expect(h.x).toBeCloseTo(39.5, 9);
      expect(h.speed).toBeLessThan(8 / 60 + 1e-9);
    });
  }

  it('slides along a wall hit at a shallow angle', () => {
    const a = (10 * Math.PI) / 180;
    const { h, run } = rider({ steering: 'screen' }, { paint: (x) => (x >= 40 ? 'blocked' : 'open'), x: 38, y: 76, hx: Math.sin(a), hy: Math.cos(a) });
    run(1, W, { type: 'steer', x: 22, y: 125 });
    while (h.x < 39.49) run(1);
    const y = h.y;
    run(30);
    expect(h.x).toBeLessThanOrEqual(39.5 + 1e-9);
    expect(h.y).toBeGreaterThan(y + 2);
  });

  it('stops against a wall hit head-on', () => {
    const { h, run } = rider({}, { paint: (x) => (x >= 40 ? 'blocked' : 'open') });
    run(300, W);
    expect(h.speed).toBeLessThan(0.2);
  });

  it('treats the map edge as blocked', () => {
    const { h, run } = rider({}, { x: 5, hx: -1 });
    run(300, W);
    expect(h.x).toBeCloseTo(0.5, 9);
  });
});
