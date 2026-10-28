// Boarding metrics from event logs: the playtest gate's numbers (attempts per run, failure
// rate, rejections by reason, time from commit to boarding, cancels and deaths).
import { parseLog, type EventLogLine, type SimEvent } from '@train-robber/sim';

export interface BoardingReport {
  runs: number;
  outcomes: Record<string, number>;
  quickRetries: number;
  /** Runs moved to another train with Tab, keeping their timer. */
  trainSwitches: number;
  boarded: number;
  attempts: number;
  results: Record<string, number>;
  rejections: Record<string, number>;
  /** Seconds from commit to landing aboard, one per boarded run. */
  commitToAboardSec: number[];
  /** Run length in seconds, one per ended run. */
  runSec: number[];
  /** Searches: items picked up and their value, refusals by reason, drops, and searches cancelled. */
  loot: { picked: number; value: number; refused: Record<string, number>; dropped: number; lost: number; cancelled: number };
  /** Guards: times the player was spotted, alarms raised (a guard going alert), throws off the train; and horse boosts. */
  guards: { spotted: number; alarms: number; thrownOff: number };
  boosts: number;
  /** Roofs (sneaking PR 3): climbs up, roof jumps, landings by where, slips and recoveries, falls by cause, guards climbing. */
  roof: { climbsUp: number; jumps: number; landed: Record<string, number>; slips: number; recovered: number; fell: Record<string, number>; guardClimbs: number; guardSlips: number };
}

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

/** Folds events into a report one at a time, so long bot sweeps need not keep them. */
export class ReportBuilder {
  readonly r: BoardingReport = { runs: 0, outcomes: {}, quickRetries: 0, trainSwitches: 0, boarded: 0, attempts: 0, results: {}, rejections: {}, commitToAboardSec: [], runSec: [], loot: { picked: 0, value: 0, refused: {}, dropped: 0, lost: 0, cancelled: 0 }, guards: { spotted: 0, alarms: 0, thrownOff: 0 }, boosts: 0, roof: { climbsUp: 0, jumps: 0, landed: {}, slips: 0, recovered: 0, fell: {}, guardClimbs: 0, guardSlips: 0 } };
  private startedAt = new Map<number, number>();
  constructor(private readonly tickRateHz: number) {}

  add(e: SimEvent): void {
    const r = this.r;
    switch (e.type) {
      case 'RunStarted': r.runs++; this.startedAt.set(e.player, e.tick); break;
      case 'RunPhaseChanged':
        if (e.to === 'aboard' && e.from !== 'extracting') {
          r.boarded++;
          const at = this.startedAt.get(e.player);
          if (at !== undefined) r.commitToAboardSec.push((e.tick - at) / this.tickRateHz);
        }
        break;
      case 'TrainSwitched': r.trainSwitches++; break;
      case 'BoardingAttempt': r.attempts++; bump(r.results, e.result); break;
      case 'CommandRejected': bump(r.rejections, `${e.command}: ${e.reason}`); break;
      case 'LootPickedUp': r.loot.picked++; r.loot.value += e.value; break;
      case 'LootRefused': bump(r.loot.refused, e.reason); break;
      case 'LootDropped': r.loot.dropped++; break;
      case 'LootLost': r.loot.lost++; break;
      case 'SearchCancelled': r.loot.cancelled++; break;
      case 'PlayerSpotted': r.guards.spotted++; break;
      case 'GuardStateChanged': if (e.to === 'alert') r.guards.alarms++; break;
      case 'ThrownOff': r.guards.thrownOff++; break;
      case 'HorseBoosted': r.boosts++; break;
      case 'Climbed': if (e.to === 'roof') r.roof.climbsUp++; break;
      case 'RoofJumped': r.roof.jumps++; break;
      case 'RoofLanded': bump(r.roof.landed, `${e.on}${e.jumped ? '' : ' (walked off)'}`); break;
      case 'RoofSlipped': r.roof.slips++; break;
      case 'RoofRecovered': r.roof.recovered++; break;
      case 'FellOff': bump(r.roof.fell, e.cause); break;
      case 'GuardClimbing': if (e.to === 'roof') r.roof.guardClimbs++; break;
      case 'GuardSlipped': r.roof.guardSlips++; break;
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
    `runs ${r.runs}, boarded ${r.boarded} (${pct(r.boarded, r.runs)}), outcomes: ${counts(r.outcomes)}${r.quickRetries ? ` (${r.quickRetries} quick retries)` : ''}${r.trainSwitches ? `, ${r.trainSwitches} train switches` : ''}`,
    `jumps ${r.attempts}, ${r.runs ? (r.attempts / r.runs).toFixed(2) : '-'} per run; perfect ${r.results.perfect ?? 0}, good ${r.results.good ?? 0}, fail ${fails} (${pct(fails, r.attempts)})`,
    `rejected: ${counts(r.rejections)}`,
    `commit to aboard: median ${sec(median(r.commitToAboardSec))}; run length: median ${sec(median(r.runSec))}`,
    `loot: picked ${r.loot.picked} ($${r.loot.value}), refused: ${counts(r.loot.refused)}, dropped ${r.loot.dropped}, lost ${r.loot.lost}, searches cancelled ${r.loot.cancelled}`,
    `guards: spotted ${r.guards.spotted}, alarms ${r.guards.alarms}, thrown off ${r.guards.thrownOff}; horse boosts ${r.boosts}`,
    `roofs: climbed up ${r.roof.climbsUp}, jumps ${r.roof.jumps}, landed: ${counts(r.roof.landed)}, slips ${r.roof.slips} (recovered ${r.roof.recovered}), fell: ${counts(r.roof.fell)}, guards climbed up ${r.roof.guardClimbs}, guard slips ${r.roof.guardSlips}`,
  ].join('\n');
}
