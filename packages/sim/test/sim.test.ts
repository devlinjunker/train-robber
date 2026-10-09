import { describe, it, expect } from 'vitest';
import { createSim, restoreSim, seedRng, nextU32, type InputFrame } from '../src';

const script = (t: number): InputFrame[] => [{
  player: 1,
  commands: t === 5 ? [{ type: 'startRun' }, { type: 'move', x: 127, y: -40 }] : t === 90 ? [{ type: 'move', x: 0, y: 127 }] : [],
}];

function run(ticks: number, seed = 42) {
  const sim = createSim({ seed, playerIds: [1] });
  for (let t = 0; t < ticks; t++) sim.step(script(t));
  return sim;
}

describe('determinism', () => {
  it('same seed + inputs give the same hash', () => {
    expect(run(600).hash()).toBe(run(600).hash());
  });
  it('different seed gives different rng state after run start', () => {
    expect(run(600, 1).hash()).not.toBe(run(600, 2).hash());
  });
  it('snapshot/restore resumes identically', () => {
    const a = run(300);
    const b = restoreSim(a.snapshot(), 42);
    for (let t = 300; t < 600; t++) { a.step(script(t)); b.step(script(t)); }
    expect(b.hash()).toBe(a.hash());
  });
  it('golden hash is stable', () => {
    expect(run(600).hash()).toMatchSnapshot();
  });
});

describe('rng', () => {
  it('streams are independent', () => {
    const a = seedRng(7), b = seedRng(7);
    nextU32(a, 'gen');
    expect(b.combat).toEqual(a.combat);
  });
});
