import { describe, it, expect } from 'vitest';
import { eventLogWriter, type RunHeader, type SimEvent } from '@train-robber/sim';
import { formatReport, reportFromLogs } from '../src/report';

const header: RunHeader = {
  gameVersion: '0', configHash: 'c', preset: 'alpha-default', variants: {}, overrides: {}, seed: 's', mapId: 'alpha-flats',
  mapHash: 'm', tickRateHz: 60, playerIds: [1], persistentAtStart: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, startedAt: '2026-10-10T00:00:00Z',
};

function logOf(events: SimEvent[]): string {
  const lines: string[] = [];
  const w = eventLogWriter(header, (l) => lines.push(l));
  w.events(events);
  return lines.join('\n');
}

describe('boarding report', () => {
  it('counts runs, jumps, rejections and the time from commit to aboard', () => {
    const a = logOf([
      { type: 'RunStarted', tick: 60, player: 1, runNumber: 1, trainId: 'blank-1' },
      { type: 'CommandRejected', tick: 100, player: 1, command: 'jump', reason: 'too far' },
      { type: 'BoardingAttempt', tick: 300, player: 1, result: 'fail', attempt: 1, meter: 0.1 },
      { type: 'BoardingAttempt', tick: 660, player: 1, result: 'good', attempt: 2, meter: 0.5 },
      { type: 'RunPhaseChanged', tick: 660, player: 1, from: 'boarding', to: 'aboard' },
      { type: 'RunEnded', tick: 720, player: 1, outcome: 'cancelled', durationTicks: 660, boardingAttempts: 2, retry: false },
    ]);
    const b = logOf([
      { type: 'RunStarted', tick: 0, player: 1, runNumber: 1, trainId: 'blank-1' },
      { type: 'BoardingAttempt', tick: 120, player: 1, result: 'fail', attempt: 1, meter: 0.9 },
      { type: 'RunEnded', tick: 240, player: 1, outcome: 'died', durationTicks: 240, boardingAttempts: 1, retry: false },
    ]);
    const r = reportFromLogs([a, b]);
    expect(r).toMatchObject({ runs: 2, boarded: 1, attempts: 3, outcomes: { cancelled: 1, died: 1 }, results: { fail: 2, good: 1 }, rejections: { 'jump: too far': 1 } });
    expect(r.commitToAboardSec).toEqual([10]);
    expect(r.runSec).toEqual([11, 4]);
    expect(formatReport(r)).toContain('fail 2 (67%)');
  });
});
