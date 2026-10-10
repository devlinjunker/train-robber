// Pure summaries of run records for the Playtests page: grouping by setup, CSV and the GitHub issue text.
import type { RunRecord, TrackedOutcome } from './runTracker';

/** Preset plus every variant choice, e.g. `alpha-default · steering:heading throttleModel:coast`. */
export function setupKey(r: Pick<RunRecord, 'preset' | 'variants'>): string {
  const v = Object.entries(r.variants).sort(([a], [b]) => a.localeCompare(b)).map(([g, id]) => `${g}:${id}`).join(' ');
  return `${r.preset} · ${v}`;
}

export interface SetupSummary {
  setup: string;
  runs: number;
  testers: number;
  outcomes: Record<TrackedOutcome, number>;
  avgSec: number;
  avgAttempts: number;
  /** Share of boarding attempts by result, 0 to 1. */
  perfect: number; good: number; fail: number;
  /** Share of runs that got aboard a train, 0 to 1. */
  aboard: number;
  /** Median seconds from commit to landing aboard, over runs that got aboard. */
  medianToAboardSec: number | null;
  notes: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function summarize(runs: readonly RunRecord[]): SetupSummary[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = setupKey(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups].map(([setup, rs]) => {
    const outcomes: Record<TrackedOutcome, number> = { died: 0, cancelled: 0, retry: 0, abandoned: 0 };
    for (const r of rs) outcomes[r.outcome]++;
    const attempts = rs.reduce((n, r) => n + r.boardingAttempts, 0);
    const share = (k: 'perfect' | 'good' | 'fail') => (attempts ? rs.reduce((n, r) => n + r.boarding[k], 0) / attempts : 0);
    return {
      setup, runs: rs.length, testers: new Set(rs.map((r) => r.tester || '?')).size, outcomes,
      avgSec: avg(rs.map((r) => r.durationSec)), avgAttempts: avg(rs.map((r) => r.boardingAttempts)),
      perfect: share('perfect'), good: share('good'), fail: share('fail'),
      aboard: rs.filter((r) => r.furthestPhase === 'aboard').length / rs.length,
      medianToAboardSec: median(rs.flatMap((r) => (r.commitToAboardSec == null ? [] : [r.commitToAboardSec]))),
      notes: rs.reduce((n, r) => n + r.notes.length, 0),
    };
  }).sort((a, b) => b.runs - a.runs);
}

const CSV_COLUMNS = [
  'startedAt', 'tester', 'preset', 'variants', 'seed', 'mapId', 'trainId', 'runNumber', 'outcome', 'durationSec',
  'boardingAttempts', 'perfect', 'good', 'fail', 'furthestPhase', 'commitToAboardSec', 'damageTaken', 'rejections', 'notes', 'gameVersion', 'configHash', 'url', 'session',
] as const;

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(runs: readonly RunRecord[]): string {
  const rows = runs.map((r) => {
    const flat: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      ...r, variants: setupKey(r).split(' · ')[1], perfect: r.boarding.perfect, good: r.boarding.good, fail: r.boarding.fail,
      rejections: Object.entries(r.rejections ?? {}).map(([k, n]) => `${k} ×${n}`).join(' | '),
      notes: r.notes.map((n) => n.text).join(' | '),
    };
    return CSV_COLUMNS.map((c) => csvCell(flat[c])).join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Markdown for a GitHub issue, cut to `maxChars` so the prefilled issue URL stays short enough. */
export function issueMarkdown(runs: readonly RunRecord[], maxChars = 6000): string {
  const testers = [...new Set(runs.map((r) => r.tester).filter(Boolean))].join(', ') || 'unnamed';
  const lines = [
    `Playtest results from ${testers}: ${runs.length} runs.`, '',
    '| Setup | Runs | Died | Cancelled | Retry | Abandoned | Avg length | Avg jumps | Perfect / good / fail | Got aboard | Median to board |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summarize(runs).map((s) => `| ${s.setup} | ${s.runs} | ${s.outcomes.died} | ${s.outcomes.cancelled} | ${s.outcomes.retry} | ${s.outcomes.abandoned} | ${s.avgSec.toFixed(1)} s | ${s.avgAttempts.toFixed(1)} | ${pct(s.perfect)} / ${pct(s.good)} / ${pct(s.fail)} | ${pct(s.aboard)} | ${s.medianToAboardSec === null ? '–' : `${s.medianToAboardSec.toFixed(1)} s`} |`),
  ];
  const noted = runs.filter((r) => r.notes.length);
  if (noted.length) {
    lines.push('', '**Notes**', '');
    for (const r of noted) for (const n of r.notes) lines.push(`- ${setupKey(r)}, seed \`${r.seed}\`, run ${r.runNumber} (${r.outcome}), tick ${n.t}: ${n.text}`);
  }
  lines.push('', '_Drop the exported `.log` files here for any run worth replaying._');
  const text = lines.join('\n');
  return text.length <= maxChars ? text : text.slice(0, maxChars - 40) + '\n\n_…cut to fit; see the CSV export._';
}
