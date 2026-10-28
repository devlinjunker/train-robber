// Pure summaries of run records for the Playtests page: grouping by setup, CSV and the GitHub issue text.
import { setEntries } from '@train-robber/config';
import type { RunRecord, TrackedOutcome } from './runTracker';

/**
 * Preset plus every variant choice, e.g. `alpha-default · steering:heading throttleModel:coast`,
 * then any `?set=` values, e.g. `· set countdown.scale=4`, since those make a different setup too.
 */
export function setupKey(r: Pick<RunRecord, 'preset' | 'variants' | 'overrides'>): string {
  const v = Object.entries(r.variants).sort(([a], [b]) => a.localeCompare(b)).map(([g, id]) => `${g}:${id}`).join(' ');
  const set = setEntries(r.overrides ?? {}).sort();
  return `${r.preset} · ${v}${set.length ? ` · set ${set.join(' ')}` : ''}`;
}

/** The game version a run was played on; `unknown` for records from before versions were set (0.0.0). */
export function runVersion(r: Pick<RunRecord, 'gameVersion'>): string {
  return r.gameVersion && r.gameVersion !== '0.0.0' ? r.gameVersion : 'unknown';
}

/**
 * Newest version first, `unknown` last. A tagged build (`0.2.0-mud-effect`, a PR testing one
 * feature on top of 0.2.0) sorts right after its plain version, tags alphabetically.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'unknown') return 1;
  if (b === 'unknown') return -1;
  const split = (v: string) => { const i = v.indexOf('-'); return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)]; };
  const [ca = '', ta = ''] = split(a), [cb = '', tb = ''] = split(b);
  const pa = ca.split('.').map(Number), pb = cb.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return ta.localeCompare(tb);
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
  /** Average dollar value carried at run end, over runs recorded since loot; null when there are none. */
  avgLoot: number | null;
  notes: number;
}

/** Dollars, rounded, or a dash when there is nothing to show. */
export const money = (v: number | null | undefined) => (v == null ? '–' : `$${Math.round(v)}`);
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
    const outcomes: Record<TrackedOutcome, number> = { extracted: 0, died: 0, cancelled: 0, expired: 0, cashedOut: 0, retry: 0, abandoned: 0 };
    for (const r of rs) outcomes[r.outcome]++;
    const attempts = rs.reduce((n, r) => n + r.boardingAttempts, 0);
    const share = (k: 'perfect' | 'good' | 'fail') => (attempts ? rs.reduce((n, r) => n + r.boarding[k], 0) / attempts : 0);
    return {
      setup, runs: rs.length, testers: new Set(rs.map((r) => r.tester || '?')).size, outcomes,
      avgSec: avg(rs.map((r) => r.durationSec)), avgAttempts: avg(rs.map((r) => r.boardingAttempts)),
      perfect: share('perfect'), good: share('good'), fail: share('fail'),
      aboard: rs.filter((r) => r.furthestPhase === 'aboard' || r.furthestPhase === 'extracting').length / rs.length,
      medianToAboardSec: median(rs.flatMap((r) => (r.commitToAboardSec == null ? [] : [r.commitToAboardSec]))),
      avgLoot: rs.some((r) => r.lootValue !== undefined) ? avg(rs.flatMap((r) => (r.lootValue === undefined ? [] : [r.lootValue]))) : null,
      notes: rs.reduce((n, r) => n + r.notes.length, 0),
    };
  }).sort((a, b) => b.runs - a.runs);
}

const CSV_COLUMNS = [
  'startedAt', 'tester', 'preset', 'variants', 'seed', 'mapId', 'trainId', 'runNumber', 'outcome', 'durationSec',
  'boardingAttempts', 'perfect', 'good', 'fail', 'furthestPhase', 'commitToAboardSec', 'damageTaken', 'countdownLeftSec', 'heatAtEnd', 'lootValue', 'lootItems', 'cashOut', 'lootLost', 'wantedLevel', 'wantedAfter', 'bankAfter', 'practice', 'rejections', 'notes', 'gameVersion', 'configHash', 'url', 'session',
] as const;

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(runs: readonly RunRecord[]): string {
  const rows = runs.map((r) => {
    const flat: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      ...r, variants: setupKey(r).split(' · ').slice(1).join(' · '), perfect: r.boarding.perfect, good: r.boarding.good, fail: r.boarding.fail,
      rejections: Object.entries(r.rejections ?? {}).map(([k, n]) => `${k} ×${n}`).join(' | '),
      notes: r.notes.map((n) => n.text).join(' | '), countdownLeftSec: r.countdownLeftSec, heatAtEnd: r.heatAtEnd, lootValue: r.lootValue, lootItems: r.lootItems,
      cashOut: r.cashOut, lootLost: r.lootLost, wantedLevel: r.wantedLevel, wantedAfter: r.wantedAfter, bankAfter: r.bankAfter, practice: r.practice,
    };
    return CSV_COLUMNS.map((c) => csvCell(flat[c])).join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Every note in `runs` as Markdown, grouped by game version, for pasting into the pull request
 * that version belongs to. `filters` describes the page filters that picked the runs.
 */
export function notesMarkdown(runs: readonly RunRecord[], filters: readonly string[] = []): string {
  const versions = [...new Set(runs.map(runVersion))].sort(compareVersions);
  const noteCount = runs.reduce((n, r) => n + r.notes.length, 0);
  const lines = [`## Playtest notes: ${versions.join(', ') || 'no runs'}`, ''];
  lines.push(`${runs.length} run${runs.length === 1 ? "" : "s"}, ${noteCount} note${noteCount === 1 ? "" : "s"}${filters.length ? ` (filtered by ${filters.join(', ')})` : ''}.`);
  for (const v of versions) {
    const rs = runs.filter((r) => runVersion(r) === v && r.notes.length).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (versions.length > 1) lines.push('', `### ${v}`);
    if (!rs.length) { lines.push('', '_No notes._'); continue; }
    for (const r of rs) {
      const who = r.tester ? `${r.tester}, ` : '';
      lines.push('', `**${who}${r.startedAt.slice(0, 16).replace('T', ' ')}** · ${setupKey(r)} · map \`${r.mapId}\`, seed \`${r.seed}\`, run ${r.runNumber} (${r.outcome}, ${r.durationSec.toFixed(1)} s)`);
      for (const n of r.notes) lines.push(`- tick ${n.t}: ${n.text}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Markdown for a GitHub issue, cut to `maxChars` so the prefilled issue URL stays short enough. */
export function issueMarkdown(runs: readonly RunRecord[], maxChars = 6000): string {
  const testers = [...new Set(runs.map((r) => r.tester).filter(Boolean))].join(', ') || 'unnamed';
  const lines = [
    `Playtest results from ${testers}: ${runs.length} runs on version ${[...new Set(runs.map(runVersion))].sort(compareVersions).join(', ')}.`, '',
    '| Setup | Runs | Extracted | Died | Cancelled | Expired | Cashed out | Retry | Abandoned | Avg length | Avg jumps | Perfect / good / fail | Got aboard | Median to board | Avg loot |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summarize(runs).map((s) => `| ${s.setup} | ${s.runs} | ${s.outcomes.extracted ?? 0} | ${s.outcomes.died} | ${s.outcomes.cancelled} | ${s.outcomes.expired} | ${s.outcomes.cashedOut ?? 0} | ${s.outcomes.retry} | ${s.outcomes.abandoned} | ${s.avgSec.toFixed(1)} s | ${s.avgAttempts.toFixed(1)} | ${pct(s.perfect)} / ${pct(s.good)} / ${pct(s.fail)} | ${pct(s.aboard)} | ${s.medianToAboardSec === null ? '–' : `${s.medianToAboardSec.toFixed(1)} s`} | ${money(s.avgLoot)} |`),
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
