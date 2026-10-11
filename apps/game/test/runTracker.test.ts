import { describe, it, expect } from 'vitest';
import type { SimEvent } from '@train-robber/sim';
import { createRunTracker, type SessionMeta } from '../src/runTracker';
import { compareVersions, issueMarkdown, notesMarkdown, runVersion, summarize, toCsv } from '../src/playtestStats';

const meta: SessionMeta = {
  session: 's1', tester: 'dev', gameVersion: '0.0.0', configHash: 'h', preset: 'alpha-default',
  variants: { steering: 'heading', throttleModel: 'coast' }, seed: 'abc', mapId: 'alpha-flats', url: '?seed=abc', tickRateHz: 60,
};
const ev = (e: Record<string, unknown>) => e as unknown as SimEvent;

function playOne() {
  const t = createRunTracker(meta);
  expect(t.events([ev({ type: 'RunStarted', tick: 10, player: 1, runNumber: 1, trainId: 'bank' })], 'T0'))
    .toMatchObject([{ id: 's1#1', outcome: 'abandoned', durationTicks: 0 }]);
  t.events([
    ev({ type: 'RunPhaseChanged', tick: 20, player: 1, from: 'approach', to: 'boarding' }),
    ev({ type: 'BoardingAttempt', tick: 30, player: 1, result: 'fail', attempt: 1, meter: 0.1 }),
    ev({ type: 'DamageDealt', tick: 30, target: 1, amount: 25, health: 75, cause: 'boarding' }),
    ev({ type: 'BoardingAttempt', tick: 40, player: 1, result: 'good', attempt: 2, meter: 0.5 }),
    ev({ type: 'RunPhaseChanged', tick: 40, player: 1, from: 'boarding', to: 'aboard' }),
    ev({ type: 'CommandRejected', tick: 45, player: 1, command: 'jump', reason: 'aboard' }),
  ], 'T1');
  expect(t.note(50, 'felt fine')).toBeNull();
  const [rec] = t.events([
    ev({ type: 'RunPhaseChanged', tick: 130, player: 1, from: 'aboard', to: 'ended' }),
    ev({ type: 'RunEnded', tick: 130, player: 1, outcome: 'cancelled', durationTicks: 120, boardingAttempts: 2, retry: true }),
  ], 'T2');
  return { t, rec: rec! };
}

describe('run tracker', () => {
  it('summarizes a run from its events', () => {
    const { rec } = playOne();
    expect(rec).toMatchObject({
      id: 's1#1', trainId: 'bank', startTick: 10, startedAt: 'T0', endedAt: 'T2', outcome: 'retry', durationTicks: 120, durationSec: 2,
      boardingAttempts: 2, boarding: { perfect: 0, good: 1, fail: 1 }, furthestPhase: 'aboard', damageTaken: 25,
      commitToAboardSec: 0.5, rejections: { 'jump: aboard': 1 },
      notes: [{ t: 50, text: 'felt fine' }], tester: 'dev', seed: 'abc',
    });
  });
  it('records an expired run with its time left and heat, and ?set= values make their own setup', () => {
    const t = createRunTracker({ ...meta, overrides: { countdown: { scale: 4 } } });
    t.events([ev({ type: 'RunStarted', tick: 0, player: 1, runNumber: 1, trainId: 'blank-1', countdownSec: 600, wantedLevel: 0 })], 'T0');
    t.events([ev({ type: 'HeatChanged', tick: 5, heat: 10, delta: 10, cause: 'debug' })], 'T1');
    const [rec] = t.events([ev({ type: 'RunEnded', tick: 900, player: 1, outcome: 'expired', durationTicks: 900, boardingAttempts: 0, retry: false, countdownLeftSec: 0, heat: 10 })], 'T2');
    expect(rec).toMatchObject({ outcome: 'expired', countdownLeftSec: 0, heatAtEnd: 10 });
    const [s] = summarize([rec!]);
    expect(s!.setup).toBe('alpha-default · steering:heading throttleModel:coast · set countdown.scale=4');
    expect(s!.outcomes.expired).toBe(1);
  });
  it('a note after a run updates the last run', () => {
    const { t } = playOne();
    expect(t.note(200, 'later')?.notes.map((n) => n.text)).toEqual(['felt fine', 'later']);
  });
  it('an open run is abandoned when the page closes', () => {
    const t = createRunTracker(meta);
    expect(t.abandon(5, 'T')).toBeNull();
    t.events([ev({ type: 'RunStarted', tick: 10, player: 1, runNumber: 3, trainId: 'mail' })], 'T0');
    expect(t.abandon(70, 'T9')).toMatchObject({ id: 's1#3', outcome: 'abandoned', durationTicks: 60, furthestPhase: 'approach' });
  });
});

describe('playtest stats', () => {
  const { rec } = playOne();
  const died = { ...rec, id: 's1#2', outcome: 'died' as const, boarding: { perfect: 1, good: 0, fail: 1 }, furthestPhase: 'boarding' as const, notes: [] };
  const other = { ...rec, id: 's2#1', variants: { steering: 'screen', throttleModel: 'coast' }, tester: 'sam' };
  it('groups runs by setup', () => {
    const [a, b] = summarize([rec, died, other]);
    expect(a).toMatchObject({ setup: 'alpha-default · steering:heading throttleModel:coast', runs: 2, testers: 1, aboard: 0.5, notes: 1 });
    expect(a!.outcomes).toEqual({ died: 1, cancelled: 0, expired: 0, retry: 1, abandoned: 0 });
    expect(a!.perfect).toBe(0.25);
    expect(a!.medianToAboardSec).toBe(0.5);
    expect(b).toMatchObject({ runs: 1, setup: 'alpha-default · steering:screen throttleModel:coast' });
  });
  it('writes CSV with quoted notes and a markdown issue body', () => {
    const csv = toCsv([{ ...rec, notes: [{ t: 1, text: 'a, "b"' }] }]).split('\n');
    expect(csv[0]).toMatch(/^startedAt,tester,preset,variants/);
    expect(csv[1]).toContain('"a, ""b"""');
    const md = issueMarkdown([rec, other]);
    expect(md).toContain('Playtest results from dev, sam: 2 runs on version unknown.');
    expect(md).toContain('felt fine');
    expect(issueMarkdown([rec, other], 100).length).toBeLessThanOrEqual(100);
  });
});

describe('playtest versions and notes export', () => {
  const { rec } = playOne();
  const newer = { ...rec, id: 's2#1', gameVersion: '0.2.1', notes: [{ t: 7, text: 'heat rose too fast' }] };
  const bare = { ...rec, id: 's3#1', gameVersion: '0.2.0', notes: [] };

  it('treats 0.0.0 as unknown and sorts versions newest first', () => {
    expect(runVersion(rec)).toBe('unknown');
    expect(runVersion(newer)).toBe('0.2.1');
    expect(['unknown', '0.2.0-mud-effect', '0.2.0', '0.10.0', '0.2.1', '0.2.0-junctions'].sort(compareVersions))
      .toEqual(['0.10.0', '0.2.1', '0.2.0', '0.2.0-junctions', '0.2.0-mud-effect', 'unknown']);
    expect(runVersion({ gameVersion: '0.2.0-mud-effect' })).toBe('0.2.0-mud-effect');
  });
  it('exports notes grouped by version, with the filters that picked them', () => {
    const md = notesMarkdown([rec, newer, bare], ['outcome retry']);
    expect(md).toContain('## Playtest notes: 0.2.1, 0.2.0, unknown');
    expect(md).toContain('3 runs, 2 notes (filtered by outcome retry).');
    expect(md.indexOf('### 0.2.1')).toBeLessThan(md.indexOf('### unknown'));
    expect(md).toContain('- tick 7: heat rose too fast');
    expect(md).toContain('- tick 50: felt fine');
    expect(md).toMatch(/### 0\.2\.0\n\n_No notes._/);
  });
  it('a tagged version gets its own group and file name', () => {
    const md = notesMarkdown([newer, { ...newer, id: 's4#1', gameVersion: '0.2.1-mud-effect', notes: [{ t: 9, text: 'mud too sticky' }] }]);
    expect(md).toContain('## Playtest notes: 0.2.1, 0.2.1-mud-effect');
    expect(md).toMatch(/### 0\.2\.1-mud-effect\n\n.*\n- tick 9: mud too sticky/);
  });
  it('a single version gets no subheadings', () => {
    expect(notesMarkdown([newer])).not.toContain('###');
  });
});
