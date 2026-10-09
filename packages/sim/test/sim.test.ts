import { describe, it, expect } from 'vitest';
import { createSim, restoreSim, seedRng, nextU32, eventLogWriter, commandLogWriter, parseLog, type InputFrame, type RunHeader, type SimConfig } from '../src';

const config: SimConfig = { hash: 'test0001', values: { sim: { tickRateHz: 60 }, player: { speedTilesPerTick: 8 / 60 } } };

const script = (t: number): InputFrame[] => [{
  player: 1,
  commands: t === 5 ? [{ type: 'startRun' }, { type: 'move', x: 127, y: -40 }] : t === 90 ? [{ type: 'move', x: 0, y: 127 }] : t === 200 ? [{ type: 'cancelRun' }] : t === 400 ? [{ type: 'startRun' }] : [],
}];

function run(ticks: number, seed = 'abc123') {
  const sim = createSim({ config, seed, playerIds: [1] });
  for (let t = 0; t < ticks; t++) sim.step(script(t));
  return sim;
}

describe('determinism', () => {
  it('same seed + inputs give the same hash', () => {
    expect(run(600).hash()).toBe(run(600).hash());
  });
  it('different seed gives different rng state after run start', () => {
    expect(run(600, 'a').hash()).not.toBe(run(600, 'b').hash());
  });
  it('snapshot/restore resumes identically', () => {
    const a = run(300);
    const b = restoreSim(a.snapshot(), config);
    for (let t = 300; t < 600; t++) { a.step(script(t)); b.step(script(t)); }
    expect(b.hash()).toBe(a.hash());
    expect(b.snapshot().run?.runNumber).toBe(2);
  });
  it('restore refuses a different config', () => {
    expect(() => restoreSim(run(10).snapshot(), { ...config, hash: 'other' })).toThrow(/config/);
  });
});

describe('rng', () => {
  it('streams are independent', () => {
    const a = seedRng('7'), b = seedRng('7');
    nextU32(a, 'gen');
    expect(b.combat).toEqual(a.combat);
  });
});

const header: RunHeader = {
  gameVersion: '0.0.0', configHash: 'c0ffee00', preset: 'base', variants: {}, overrides: {}, seed: 'abc123',
  tickRateHz: 60, playerIds: [1], persistentAtStart: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, startedAt: '2026-10-09T00:00:00Z',
};

describe('logs', () => {
  it('command log writes a header, only ticks with commands, and periodic hashes', () => {
    const lines: string[] = [];
    const log = commandLogWriter(header, (l) => lines.push(l), { hashEveryTicks: 2 });
    const sim = createSim({ config, seed: 'abc123', playerIds: [1] });
    for (let t = 0; t < 4; t++) { log.step(t, script(t + 4)); sim.step(script(t + 4)); log.checkpoint(t + 1, () => sim.hash()); }
    const parsed = parseLog<{ k: string; t: number }>(lines.join('\n'));
    expect(parsed.header).toMatchObject({ k: 'header', log: 'commands', seed: 'abc123' });
    expect(parsed.lines.map((l) => `${l.k}@${l.t}`)).toEqual(['cmd@1', 'hash@2', 'hash@4']);
  });
  it('event log applies the allowlist', () => {
    const lines: string[] = [];
    const log = eventLogWriter(header, (l) => lines.push(l), { allow: ['RunStarted'] });
    log.events([{ type: 'RunStarted', tick: 3, player: 1 }, { type: 'RunCancelled', tick: 9, player: 1 }]);
    expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual([{ k: 'ev', t: 3, e: 'RunStarted', player: 1 }]);
  });
});
