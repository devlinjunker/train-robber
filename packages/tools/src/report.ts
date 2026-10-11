// Boarding metrics from event logs: the playtest gate's numbers (attempts per run, failure
// rate, rejections by reason, time from commit to boarding, cancels and deaths).
import { parseLog, type EventLogLine, type SimEvent } from '@train-robber/sim';

export interface BoardingReport {
  runs: number;
  outcomes: Record<string, number>;
  quickRetries: number;
  boarded: number;
  attempts: number;
  results: Record<string, number>;
  rejections: Record<string, number>;
  /** Seconds from commit to landing aboard, one per boarded run. */
  commitToAboardSec: number[];
  /** Run length in seconds, one per ended run. */
  runSec: number[];
}

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

/** Folds events into a report one at a time, so long bot sweeps need not keep them. */
export class ReportBuilder {
  readonly r: BoardingReport = { runs: 0, outcomes: {}, quickRetries: 0, boarded: 0, attempts: 0, results: {}, rejections: {}, commitToAboardSec: [], runSec: [] };
  private startedAt = new Map<number, number>();
  constructor(private readonly tickRateHz: number) {}

  add(e: SimEvent): void {
    const r = this.r;
    switch (e.type) {
      case 'RunStarted': r.runs++; this.startedAt.set(e.player, e.tick); break;
      case 'RunPhaseChanged':
        if (e.to === 'aboard') {
          r.boarded++;
          const at = this.startedAt.get(e.player);
          if (at !== undefined) r.commitToAboardSec.push((e.tick - at) / this.tickRateHz);
        }
        break;
      case 'BoardingAttempt': r.attempts++; bump(r.results, e.result); break;
      case 'CommandRejected': bump(r.rejections, `${e.command}: ${e.reason}`); break;
      case 'RunEnded':
        bump(r.outcomes, e.outcome);
        if (e.retry) r.quickRetries++;
        r.runSec.push(e.durationTicks / this.tickRateHz);
        this.startedAt.delete(e.player);
        break;
    }
  }
}

/** Builds one report over every event log given, in order. */
export function reportFromLogs(texts: string[]): BoardingReport {
  let builder: ReportBuilder | null = null;
  for (const text of texts) {
    const log = parseLog<EventLogLine>(text);
    builder ??= new ReportBuilder(log.header.tickRateHz);
    for (const l of log.lines) {
      if (l.k !== 'ev') continue;
      const { t, e, ...fields } = l;
      builder.add({ ...fields, type: e, tick: t } as unknown as SimEvent);
    }
  }
  return (builder ?? new ReportBuilder(60)).r;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sec = (v: number | null) => (v === null ? '-' : `${v.toFixed(1)} s`);
const counts = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

export function formatReport(r: BoardingReport): string {
  const fails = r.results.fail ?? 0;
  return [
    `runs ${r.runs}, boarded ${r.boarded} (${pct(r.boarded, r.runs)}), outcomes: ${counts(r.outcomes)}${r.quickRetries ? ` (${r.quickRetries} quick retries)` : ''}`,
    `jumps ${r.attempts}, ${r.runs ? (r.attempts / r.runs).toFixed(2) : '-'} per run; perfect ${r.results.perfect ?? 0}, good ${r.results.good ?? 0}, fail ${fails} (${pct(fails, r.attempts)})`,
    `rejected: ${counts(r.rejections)}`,
    `commit to aboard: median ${sec(median(r.commitToAboardSec))}; run length: median ${sec(median(r.runSec))}`,
  ].join('\n');
}
