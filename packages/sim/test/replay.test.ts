import { describe, it, expect } from 'vitest';
import { commandLogWriter, createReplay, createSim, indexCommandLog, parseLog, type CommandLogLine, type InputFrame, type RunHeader } from '../src';
import { testConfig, testMap } from './fixtures';

const config = testConfig();
const map = testMap(undefined, { x: 45, y: 38 });
const opts = { config, map, seed: 'abc123', playerIds: [1] };

const script = (t: number): InputFrame[] => [{
  player: 1,
  commands: t === 5 ? [{ type: 'startRun' }, { type: 'move', x: 127, y: -40 }] : t === 90 ? [{ type: 'move', x: 0, y: 127 }] : t === 200 ? [{ type: 'cancelRun' }] : t === 400 ? [{ type: 'startRun' }] : [],
}];

/** Record `ticks` of the script as a commands log, with a hash every 30 ticks and a note. */
function record(ticks: number): { text: string; hashes: string[] } {
  const header = { gameVersion: '0', configHash: config.hash, preset: 'p', variants: {}, overrides: {}, seed: opts.seed, mapId: 'test', mapHash: '', tickRateHz: 60, playerIds: [1], persistentAtStart: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, startedAt: '' } satisfies RunHeader;
  const lines: string[] = [];
  const log = commandLogWriter(header, (l) => lines.push(l), { hashEveryTicks: 30 });
  const sim = createSim(opts);
  const hashes = [sim.hash()];
  for (let t = 0; t < ticks; t++) {
    if (t === 100) log.note(t, 'here');
    log.step(t, script(t));
    sim.step(script(t));
    hashes.push(sim.hash());
    log.checkpoint(t + 1, () => sim.hash());
  }
  log.end(ticks, sim.hash());
  return { text: lines.join('\n') + '\n', hashes };
}

const replayOf = (text: string, every = 120) => createReplay(indexCommandLog(parseLog<CommandLogLine>(text)), opts, every);

describe('replay', () => {
  const { text, hashes } = record(600);

  it('indexes notes and the final tick', () => {
    const idx = indexCommandLog(parseLog<CommandLogLine>(text));
    expect(idx.finalTick).toBe(600);
    expect(idx.notes).toEqual([{ t: 100, text: 'here' }]);
  });

  it('stepping reproduces the recorded run and stops at the end', () => {
    const r = replayOf(text);
    for (let t = 0; t < 600; t++) { expect(r.step()).not.toBeNull(); expect(r.sim.hash()).toBe(hashes[t + 1]); }
    expect(r.step()).toBeNull();
  });

  it('seeking back and forward lands on the recorded state', () => {
    const r = replayOf(text);
    r.verify(10_000);
    for (const t of [450, 37, 599, 0, 240, 241, 600, 5000, -3]) {
      r.seek(t);
      const want = Math.max(0, Math.min(600, t));
      expect(r.tick).toBe(want);
      expect(r.sim.hash()).toBe(hashes[want]);
    }
  });

  it('seeking before the check has run still works', () => {
    const r = replayOf(text);
    r.seek(500); r.seek(10);
    expect(r.sim.hash()).toBe(hashes[10]);
    expect(r.sim.state.tick).toBe(10);
  });

  it('the background check reports in sync', () => {
    const r = replayOf(text);
    let c = r.verify(100);
    expect(c.done).toBe(false);
    while (!c.done) c = r.verify(100);
    expect(c.firstDesync).toBeNull();
    expect(c.compared).toBe(20); // hash lines at 30, 60 … 600; the end line shares tick 600
  });

  it('a tampered command is reported as the first desync tick', () => {
    const r = replayOf(text.replace('"x":127', '"x":126'));
    let c = r.verify(1000);
    while (!c.done) c = r.verify(1000);
    expect(c.firstDesync).toBe(30);
  });
});
