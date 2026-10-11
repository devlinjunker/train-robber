import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandLogWriter, createSim, mapHash, parseLog, type CommandLogLine, type InputFrame, type RunHeader, type SimEvent } from '@train-robber/sim';
import { overridesFromSet } from '@train-robber/config';
import { configDiff, replayText } from '../src/replay';
import { gameVersion, loadConfig, loadMapDef } from '../src/content';
import { recordGolden, riderCommands } from '../src/golden';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/golden.commands.ndjson');

describe('golden replay', () => {
  it('the checked-in replay reproduces every logged hash', () => {
    const r = replayText(readFileSync(GOLDEN, 'utf8'));
    expect(r.mismatches).toEqual([]);
    // The fixture's game version is pinned (GOLDEN_GAME_VERSION), so only that warning is expected.
    expect(r.warnings.filter((w) => !w.startsWith('game version differs'))).toEqual([]);
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

describe('?set= overrides in the log', () => {
  it('a run played with overrides and a preset that builds on another replays in sync, and expires', () => {
    const overrides = overridesFromSet(['countdown.scale=0.05', 'heat.heatDrainFactor=2']);
    const config = loadConfig({ preset: 'medium-run', overrides });
    expect(config.values.countdown.scale).toBe(0.05);
    const map = loadMapDef();
    const header: RunHeader = {
      gameVersion: gameVersion(), configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
      seed: 'set-1', mapId: map.id, mapHash: mapHash(map), tickRateHz: 60, playerIds: [1], persistentAtStart: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, startedAt: 'T',
    };
    const lines: string[] = [];
    const log = commandLogWriter(header, (l) => lines.push(l), { hashEveryTicks: 60 });
    const sim = createSim({ config, map, seed: header.seed, playerIds: [1] });
    const events: SimEvent[] = [];
    let t = 0;
    const play = (commands: InputFrame['commands']) => { const f = [{ player: 1, commands }]; log.step(t, f); events.push(...sim.step(f).events); t++; log.checkpoint(t, () => sim.hash()); };
    // Quick retry behind the train, ride up until auto commit, raise heat, then wait out the 7.5 s clock.
    play([{ type: 'quickRetry' }]);
    while (!sim.state.run && t < 3000) {
      const c = riderCommands(sim, config, sim.state.world.trains[0]!.id, 'left');
      play(t % 10 === 0 ? [{ type: 'move', x: c.x, y: c.y }] : []);
    }
    expect(sim.state.run).not.toBeNull();
    play([{ type: 'debugHeat' }, { type: 'move', x: 0, y: 0 }]);
    while (sim.state.run && t < 6000) play([]);
    log.end(t, sim.hash());
    const end = events.find((e) => e.type === 'RunEnded');
    expect(end).toMatchObject({ outcome: 'expired', countdownLeftSec: 0, heat: 10 });
    const r = replayText(lines.join('\n'));
    expect(r.warnings).toEqual([]);
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    // Without the overrides the same commands drift.
    const header0 = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(replayText([JSON.stringify({ ...header0, overrides: {} }), ...lines.slice(1)].join('\n')).ok).toBe(false);
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
