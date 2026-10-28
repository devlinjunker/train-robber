import { describe, it, expect } from 'vitest';
import type { Experiment } from '@train-robber/config';
import {
  canonical, classifyIncoming, decodeExperiment, encodeExperiment, loadAnswers, loadBases, loadOwn, mergeIncoming, newExperimentId, playQuery,
  saveAnswers, saveBases, saveOwn, shareQuery,
} from '../src/experiments';
import { experimentIssue, experimentMarkdown, experimentNumber, notesMarkdown, sessionPull, issueMarkdown } from '../src/playtestStats';
import type { RunRecord } from '../src/runTracker';

const exp: Experiment = {
  schemaVersion: 1, id: 'towns-abcd', title: 'Town spacing — “tight” vs mid', question: 'Which spacing?',
  base: { map: 'line', variants: { steering: 'screen' } },
  setups: [{ id: 'tight', name: 'Tight', set: { 'countdown.scale': 2 } }, { id: 'mid', name: 'Mid', preset: 'medium-run', set: { 'mapGen.name': 'x y' } }],
  numbers: ['outcomes', 'lootLeft'],
};

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('experiments in the browser', () => {
  it('stores own experiments, repo base changes and answers, skipping anything broken', () => {
    const s = memoryStorage();
    expect(loadOwn(s)).toEqual([]);
    saveOwn([exp], s);
    s.m.set('train-robber-experiments', JSON.stringify([exp, { id: 'junk' }]));
    expect(loadOwn(s)).toEqual([exp]);
    saveBases({ e1: { preset: 'medium-run' }, bad: { nope: 1 } as never }, s);
    expect(loadBases(s)).toEqual({ e1: { preset: 'medium-run' } });
    saveAnswers({ e1: { answer: 'a', next: '', prize: '', again: 'yes' } }, s);
    expect(loadAnswers(s).e1!.again).toBe('yes');
  });

  it('a Share link carries the whole experiment, unicode included; a repo one only its id', () => {
    const q = shareQuery(exp, false);
    expect(q).toMatch(/^\?xp=[A-Za-z0-9_-]+$/);
    expect(decodeExperiment(new URLSearchParams(q).get('xp')!)).toEqual(exp);
    expect(shareQuery(exp, true)).toBe('?exp=towns-abcd');
    expect(() => decodeExperiment(encodeExperiment(exp).slice(0, 20))).toThrow(/cut short/);
    expect(() => decodeExperiment(encodeExperiment({ ...exp, setups: [] }))).toThrow(/not a valid experiment \(setups/);
  });

  it('a Play link sets the merged setup and tags it; own experiments carry themselves', () => {
    const q = new URLSearchParams(playQuery(exp, 'mid', exp.base, true));
    expect(q.get('preset')).toBe('medium-run');
    expect(q.getAll('v')).toEqual(['steering:screen']);
    expect(q.getAll('set')).toEqual(['mapGen.name=x y']);
    expect(q.get('map')).toBe('line');
    expect([q.get('exp'), q.get('setup')]).toEqual(['towns-abcd', 'mid']);
    expect(decodeExperiment(q.get('xp')!)).toEqual(exp);
    const repo = new URLSearchParams(playQuery(exp, 'tight', { preset: 'medium-run' }, false));
    expect([repo.get('preset'), repo.getAll('set'), repo.get('map'), repo.has('xp')]).toEqual(['medium-run', ['countdown.scale=2'], null, false]);
    expect(() => playQuery(exp, 'nope', undefined, false)).toThrow(/no setup nope/);
  });

  it('an incoming experiment is added once, asks on a clash, and a repo one stays put', () => {
    const repo = new Set(['medium-run-countdown']);
    expect(classifyIncoming(exp, [], repo)).toBe('new');
    expect(classifyIncoming({ ...exp, id: 'medium-run-countdown' }, [], repo)).toBe('repo');
    // Same contents in another key order is the same experiment.
    const reordered = JSON.parse(canonical(exp)) as Experiment;
    expect(classifyIncoming(reordered, [exp], repo)).toBe('same');
    expect(mergeIncoming(reordered, [exp], repo, false).own).toEqual([exp]);
    const changed = { ...exp, question: 'Changed?' };
    expect(classifyIncoming(changed, [exp], repo)).toBe('conflict');
    expect(mergeIncoming(changed, [exp], repo, true)).toEqual({ own: [changed], id: exp.id, kind: 'conflict' });
    const both = mergeIncoming(changed, [exp], repo, false, () => 0.5);
    expect(both.own).toHaveLength(2);
    expect(both.id).not.toBe(exp.id);
    expect(both.own[1]).toMatchObject({ id: both.id, title: `${exp.title} (shared)`, question: 'Changed?' });
  });

  it('new ids are slugs with a random tail that avoid taken ones', () => {
    let n = 0;
    const rand = () => [0, 0, 0.5][n++]!;
    expect(newExperimentId('Town Spacing!', new Set(['town-spacing-0000']), rand)).toBe(`town-spacing-${Math.floor(0.5 * 36 ** 4).toString(36)}`);
    expect(newExperimentId('', new Set(), () => 0)).toBe('experiment-0000');
  });
});

describe('experiment cards', () => {
  const run = (o: Partial<RunRecord>): RunRecord => ({
    session: 's1', tester: 'dev', gameVersion: '0.2.4', configHash: 'h', preset: 'alpha-default', variants: {}, seed: 'x', mapId: 'line', url: '', tickRateHz: 60,
    id: `${o.session ?? 's1'}#${o.runNumber ?? 1}`, runNumber: 1, trainId: 't', startedAt: '2026-10-28T10:00:00Z', endedAt: '2026-10-28T10:01:00Z', outcome: 'extracted',
    durationTicks: 3600, durationSec: 60, boardingAttempts: 1, boarding: { perfect: 1, good: 0, fail: 0 }, furthestPhase: 'aboard', damageTaken: 0,
    commitToAboardSec: 5, rejections: {}, notes: [], exp: 'towns-abcd', setup: 'tight', ...o,
  });
  // Session s1: run 2 starts 20 s after run 1 ends (went again), run 3 starts 2 min after run 2. Session s2: one run, closed mid-run.
  const runs = [
    run({ runNumber: 1, lootLeftValue: 100 }),
    run({ runNumber: 2, startedAt: '2026-10-28T10:01:20Z', endedAt: '2026-10-28T10:02:00Z', outcome: 'died', lootLeftValue: 300 }),
    run({ runNumber: 3, startedAt: '2026-10-28T10:04:00Z', endedAt: '2026-10-28T10:05:00Z', notes: [{ t: 9, text: 'too short' }] }),
    run({ session: 's2', runNumber: 1, outcome: 'abandoned' }),
    run({ session: 's3', setup: 'mid', outcome: 'cashedOut', lootLeftValue: 50 }),
  ];

  it('session pull: runs followed within 30 s, and the outcome that ended each session', () => {
    expect(sessionPull(runs.slice(0, 4))).toEqual({ followed: 2, again: 1, sessions: 2, endedBy: { extracted: 1, abandoned: 1 } });
  });

  it('shows only the numbers it names, per setup', () => {
    expect(experimentNumber('outcomes', runs.slice(0, 4))).toBe('2 extracted, 1 died, 1 closed');
    expect(experimentNumber('lootLeft', runs.slice(0, 4))).toBe('$200');
    expect(experimentNumber('length', runs.slice(0, 1))).toBe('1:00');
    expect(experimentNumber('heat', [])).toBe('–');
  });

  it('writes the card and its answers into the notes and the GitHub issue', () => {
    const rep = { exp, labels: ['countdown.scale=2', 'medium-run'], baseLabel: 'steering:screen, map line', answers: { answer: 'Mid felt right', next: 'Board later', prize: '', again: 'Yes' } };
    const md = experimentMarkdown(rep, runs).join('\n');
    expect(md).toContain('### Town spacing');
    expect(md).toContain('> Which spacing?');
    expect(md).toContain('| | Tight | Mid |');
    expect(md).toContain('| Runs | 4 | 1 |');
    expect(md).toContain('| Avg left on train | $200 | $50 |');
    expect(md).toContain('| Went again within 30 s | 1 of 2 | – |');
    expect(md).toContain('**Answer** Mid felt right');
    expect(md).toContain('**Did you want to go again? Why?** Yes');
    expect(md).not.toContain('prize or route');
    const notes = notesMarkdown(runs, [], [rep]);
    expect(notes.indexOf('### Town spacing')).toBeLessThan(notes.indexOf('### Run notes'));
    expect(notes).toContain('- tick 9: too short');
    const issue = issueMarkdown([...runs, run({ exp: undefined, setup: undefined, id: 'loose' })], 6000, [rep]);
    expect(issue).toContain('### Runs outside experiments');
    expect(issue).toContain('| alpha-default ·  | 1 | 1 extracted |');
  });

  it('one experiment goes to GitHub alone, with the file to commit when it is finished', () => {
    const rep = { exp, labels: ['a', 'b'], answers: { answer: 'Mid', next: '', prize: '', again: '' } };
    const plain = experimentIssue(rep, runs, 'devlin');
    expect(plain.title).toBe(`Experiment results: ${exp.title}`);
    expect(plain.body).toMatch(/^devlin on build 0\.2\.4\./);
    expect(plain.body).toContain('| | Tight | Mid |');
    expect(plain.body).not.toContain('File to commit');
    const done = experimentIssue(rep, runs, '', { ...exp, status: 'done', conclusion: 'Mid' });
    expect(done.title).toBe(`Experiment done: ${exp.title}`);
    expect(done.body).toContain('`packages/content/playtests/towns-abcd.json`');
    expect(done.body).toContain('"status": "done"');
    expect(experimentIssue(rep, runs, '', undefined, 200).body.length).toBeLessThanOrEqual(200);
  });
});
