import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, parseLog, type CommandLogLine, type InputFrame } from '@train-robber/sim';
import { configDiff, replayText } from '../src/replay';
import { loadConfig, loadMapDef } from '../src/content';
import { recordGolden } from '../src/golden';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/golden.commands.ndjson');

describe('golden replay', () => {
  it('the checked-in replay reproduces every logged hash', () => {
    const r = replayText(readFileSync(GOLDEN, 'utf8'));
    expect(r.mismatches).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.checked).toBeGreaterThan(1);
    expect(r.actualHash).toBe(r.expectedHash);
    expect(r.ok).toBe(true);
  });
  it('the golden script still records the checked-in file', () => {
    // Fails when the sim, config or script changes; rerun `npm run golden:update` if intended.
    expect(recordGolden()).toBe(readFileSync(GOLDEN, 'utf8'));
  });
  it('the golden run commits, fails two jumps, lands the third as good, and cancels aboard', () => {
    const log = parseLog<CommandLogLine>(readFileSync(GOLDEN, 'utf8'));
    const h = log.header;
    const sim = createSim({ config: loadConfig({ preset: h.preset, variants: h.variants }), map: loadMapDef(h.mapId), seed: h.seed, playerIds: h.playerIds, persistent: h.persistentAtStart });
    const byTick = new Map<number, InputFrame['commands']>();
    for (const l of log.lines) if (l.k === 'cmd') byTick.set(l.t, l.c);
    const seen: string[] = [];
    const end = log.lines.find((l) => l.k === 'end')!.t;
    for (let t = 0; t < end; t++) {
      for (const e of sim.step([{ player: 1, commands: byTick.get(t) ?? [] }]).events) {
        if (e.type === 'RunStarted') seen.push('commit');
        else if (e.type === 'BoardingAttempt') seen.push(e.result);
        else if (e.type === 'RunPhaseChanged' && e.to === 'aboard') seen.push('aboard');
        else if (e.type === 'RunEnded') seen.push(e.outcome);
      }
    }
    expect(seen).toEqual(['commit', 'fail', 'fail', 'good', 'aboard', 'cancelled']);
  });
  it('a tampered command is detected', () => {
    const text = readFileSync(GOLDEN, 'utf8').replace('"x":127', '"x":126');
    expect(replayText(text).ok).toBe(false);
  });
});

describe('notes and config in the log', () => {
  const golden = readFileSync(GOLDEN, 'utf8');
  it('note lines are reported and do not affect the replay', () => {
    const [header, ...rest] = golden.trimEnd().split('\n');
    const text = [header, '{"k":"note","t":0,"text":"start"}', ...rest, '{"k":"note","t":9999,"text":"felt slow"}'].join('\n');
    const r = replayText(text);
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([{ t: 0, text: 'start' }, { t: 9999, text: 'felt slow' }]);
  });
  it('a config hash mismatch names the parameters that changed', () => {
    const [headerText, ...rest] = golden.trimEnd().split('\n');
    const header = JSON.parse(headerText!) as Record<string, unknown>;
    const current = loadConfig({ preset: header.preset as string, variants: header.variants as Record<string, string> });
    const logged = structuredClone(current.values) as { horse: { accel: number } };
    logged.horse.accel += 1;
    const text = [JSON.stringify({ ...header, configHash: 'other', config: logged }), ...rest].join('\n');
    const w = replayText(text).warnings;
    expect(w[0]).toMatch(/^config hash differs/);
    expect(w).toContain(`  horse.accel: log ${current.values.horse.accel + 1}, current ${current.values.horse.accel}`);
  });
});

describe('configDiff', () => {
  it('lists differing leaves only', () => {
    expect(configDiff({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 1, c: 3 }, d: [1], e: true })).toEqual(['a.c: log 2, current 3', 'e: log missing, current true']);
  });
});
