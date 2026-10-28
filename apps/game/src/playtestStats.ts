// Pure summaries of run records for the Playtests page: grouping by setup, CSV and the GitHub issue text.
import { EXPERIMENT_NUMBERS, setEntries, type Experiment, type ExperimentNumber } from '@train-robber/config';
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
const pct = (x: number) => `${Math.round(x * 100)}%`;
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
  'boardingAttempts', 'perfect', 'good', 'fail', 'furthestPhase', 'commitToAboardSec', 'damageTaken', 'countdownLeftSec', 'heatAtEnd', 'lootValue', 'lootItems', 'cashOut', 'lootLeftValue', 'lootLeftItems', 'exp', 'setup', 'rejections', 'notes', 'gameVersion', 'configHash', 'url', 'session',
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
      cashOut: r.cashOut, lootLeftValue: r.lootLeftValue, lootLeftItems: r.lootLeftItems, exp: r.exp, setup: r.setup,
    };
    return CSV_COLUMNS.map((c) => csvCell(flat[c])).join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}


/**
 * Every note in `runs` as Markdown, grouped by game version, for pasting into the pull request
 * that version belongs to. `filters` describes the page filters that picked the runs.
 */
export function notesMarkdown(runs: readonly RunRecord[], filters: readonly string[] = [], reports: readonly ExperimentReport[] = []): string {
  const versions = [...new Set(runs.map(runVersion))].sort(compareVersions);
  const noteCount = runs.reduce((n, r) => n + r.notes.length, 0);
  const lines = [`## Playtest notes: ${versions.join(', ') || 'no runs'}`, ''];
  lines.push(`${runs.length} run${runs.length === 1 ? "" : "s"}, ${noteCount} note${noteCount === 1 ? "" : "s"}${filters.length ? ` (filtered by ${filters.join(', ')})` : ''}.`);
  for (const rep of reports) lines.push('', ...experimentMarkdown(rep, runs));
  if (reports.length && versions.length) lines.push('', '### Run notes');
  for (const v of versions) {
    const rs = runs.filter((r) => runVersion(r) === v && r.notes.length).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (versions.length > 1) lines.push('', `${reports.length ? '####' : '###'} ${v}`);
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
export function issueMarkdown(runs: readonly RunRecord[], maxChars = 6000, reports: readonly ExperimentReport[] = []): string {
  const testers = [...new Set(runs.map((r) => r.tester).filter(Boolean))].join(', ') || 'unnamed';
  const lines = [`Playtest results from ${testers}: ${runs.length} runs on version ${[...new Set(runs.map(runVersion))].sort(compareVersions).join(', ')}.`];
  for (const rep of reports) lines.push('', ...experimentMarkdown(rep, runs));
  const tagged = new Set(reports.map((r) => r.exp.id));
  const loose = runs.filter((r) => !r.exp || !tagged.has(r.exp));
  if (loose.length) {
    lines.push('', reports.length ? '### Runs outside experiments' : '', '| Setup | Runs | Ended | Avg length | Got aboard | Avg loot |', '| --- | --- | --- | --- | --- | --- |');
    for (const s of summarize(loose)) lines.push(`| ${s.setup} | ${s.runs} | ${outcomeWords(s.outcomes)} | ${duration(s.avgSec)} | ${pct(s.aboard)} | ${money(s.avgLoot)} |`);
  }
  const noted = runs.filter((r) => r.notes.length);
  if (noted.length) {
    lines.push('', '**Notes**', '');
    for (const r of noted) for (const n of r.notes) lines.push(`- ${setupKey(r)}, seed \`${r.seed}\`, run ${r.runNumber} (${r.outcome}), tick ${n.t}: ${n.text}`);
  }
  lines.push('', '_Drop the exported `.log` files here for any run worth replaying._');
  const text = lines.join('\n');
  return text.length <= maxChars ? text : text.slice(0, maxChars - 40) + '\n\n_…cut to fit; see the CSV export._';
}

/** A new run that starts this soon after the last one ended (when the summary shows) counts as "went again". */
export const PULL_WINDOW_SEC = 30;

export interface SessionPull {
  /** Runs followed by another run in the same session, and how many of those followed within the window. */
  followed: number;
  again: number;
  /** Sessions (one page load each), and the outcome of the last run in each. */
  sessions: number;
  endedBy: Partial<Record<TrackedOutcome, number>>;
}

/**
 * Session pull (G45): within each session, how often the next run started within
 * PULL_WINDOW_SEC of the previous one ending, and which outcome ended each session. A new
 * run starts at the commit, so riding back to a train counts toward the gap.
 */
export function sessionPull(runs: readonly RunRecord[]): SessionPull {
  const bySession = new Map<string, RunRecord[]>();
  for (const r of runs) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);
  const out: SessionPull = { followed: 0, again: 0, sessions: bySession.size, endedBy: {} };
  for (const rs of bySession.values()) {
    rs.sort((a, b) => a.runNumber - b.runNumber);
    for (let i = 0; i + 1 < rs.length; i++) {
      out.followed++;
      const gap = (Date.parse(rs[i + 1]!.startedAt) - Date.parse(rs[i]!.endedAt)) / 1000;
      if (gap <= PULL_WINDOW_SEC) out.again++;
    }
    const last = rs[rs.length - 1]!.outcome;
    out.endedBy[last] = (out.endedBy[last] ?? 0) + 1;
  }
  return out;
}

const OUTCOME_WORDS: Record<TrackedOutcome, string> = { extracted: 'extracted', died: 'died', cancelled: 'cancelled', expired: 'expired', cashedOut: 'cashed out', retry: 'retry', abandoned: 'closed' };
/** Outcome counts as words, most common first, e.g. `2 extracted, 1 died`. */
export function outcomeWords(counts: Partial<Record<TrackedOutcome, number>>): string {
  return Object.entries(counts).filter(([, n]) => n).sort(([, a], [, b]) => b! - a!).map(([k, n]) => `${n} ${OUTCOME_WORDS[k as TrackedOutcome]}`).join(', ') || '–';
}
export const pullWords = (p: SessionPull) => (p.followed ? `${p.again} of ${p.followed}` : '–');

/** Seconds as `m:ss`, or `n s` under a minute. */
export const duration = (sec: number | null | undefined) => (sec == null ? '–' : sec < 60 ? `${sec.toFixed(1)} s` : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const avgOf = (rs: readonly RunRecord[], f: (r: RunRecord) => number | null | undefined) => {
  const xs = rs.flatMap((r) => { const v = f(r); return v == null ? [] : [v]; });
  return xs.length ? avg(xs) : null;
};

/** One experiment card cell per number, as text. */
export function experimentNumber(n: ExperimentNumber, rs: readonly RunRecord[]): string {
  if (!rs.length) return '–';
  switch (n) {
    case 'outcomes': {
      const c: Partial<Record<TrackedOutcome, number>> = {};
      for (const r of rs) c[r.outcome] = (c[r.outcome] ?? 0) + 1;
      return outcomeWords(c);
    }
    case 'length': return duration(avgOf(rs, (r) => r.durationSec));
    case 'lootCarried': return money(avgOf(rs, (r) => r.lootValue));
    case 'banked': return money(avgOf(rs, (r) => r.cashOut));
    case 'lootLeft': return money(avgOf(rs, (r) => r.lootLeftValue));
    case 'timeLeft': return duration(avgOf(rs, (r) => r.countdownLeftSec));
    case 'heat': { const h = avgOf(rs, (r) => r.heatAtEnd); return h == null ? '–' : h.toFixed(0); }
    case 'aboard': return pct(rs.filter((r) => r.furthestPhase === 'aboard' || r.furthestPhase === 'extracting').length / rs.length);
    case 'toBoard': { const m = median(rs.flatMap((r) => (r.commitToAboardSec == null ? [] : [r.commitToAboardSec]))); return duration(m); }
    case 'jumps': {
      const [s] = summarize(rs.map((r) => ({ ...r, preset: '', variants: {}, overrides: {} })));
      return `${s!.avgAttempts.toFixed(1)} (${pct(s!.perfect)} / ${pct(s!.good)} / ${pct(s!.fail)})`;
    }
    case 'damage': return (avgOf(rs, (r) => r.damageTaken) ?? 0).toFixed(0);
    case 'whistles': { const w = avgOf(rs, (r) => r.whistles); return w == null ? '–' : w.toFixed(1); }
  }
}

/** Short names for the card's row labels. */
export const NUMBER_LABELS: Record<ExperimentNumber, string> = {
  outcomes: 'Ended', length: 'Avg length', lootCarried: 'Avg carried', banked: 'Avg banked', lootLeft: 'Avg left on train',
  timeLeft: 'Avg time left', heat: 'Avg heat', aboard: 'Got aboard', toBoard: 'Median to board', jumps: 'Jumps (P / G / F)',
  damage: 'Avg damage', whistles: 'Avg whistles',
};
export { EXPERIMENT_NUMBERS };

/** Runs that belong to one setup of one experiment. */
export const setupRuns = (runs: readonly RunRecord[], expId: string, setupId: string) => runs.filter((r) => r.exp === expId && r.setup === setupId);

/** An experiment with what the page knows about it, for the notes export and GitHub. */
export interface ExperimentReport {
  exp: Experiment;
  /** Each setup's difference from the default, in setup order. */
  labels: string[];
  /** The base when it is not the default (changed on the page, or the experiment's own). */
  baseLabel?: string;
  answers: { answer: string; next: string; prize: string; again: string };
}

/** One experiment as Markdown: the question, a table of the setups side by side, and the answers. */
export function experimentMarkdown(rep: ExperimentReport, runs: readonly RunRecord[]): string[] {
  const { exp } = rep;
  const cells = exp.setups.map((s) => setupRuns(runs, exp.id, s.id));
  const row = (label: string, f: (rs: RunRecord[], i: number) => string) => `| ${label} | ${cells.map((rs, i) => f(rs, i).replace(/\|/g, '\\|')).join(' | ')} |`;
  const lines = [`### ${exp.title}`, '', `> ${exp.question}`, ''];
  if (rep.baseLabel) lines.push(`Base: ${rep.baseLabel}`, '');
  lines.push(
    `| | ${exp.setups.map((s) => s.name.replace(/\|/g, '\\|')).join(' | ')} |`,
    `| --- |${exp.setups.map(() => ' --- |').join('')}`,
    row('Setup', (_, i) => rep.labels[i] ?? ''),
    row('Runs', (rs) => String(rs.length)),
    ...exp.numbers.map((n) => row(NUMBER_LABELS[n], (rs) => experimentNumber(n, rs))),
    row(`Went again within ${PULL_WINDOW_SEC} s`, (rs) => pullWords(sessionPull(rs))),
    row('Sessions ended by', (rs) => outcomeWords(sessionPull(rs).endedBy)),
  );
  const a = rep.answers;
  const answered: [string, string][] = [['Answer', a.answer], ['What would you try next time?', a.next], ['Did you see a prize or route you left behind?', a.prize], ['Did you want to go again? Why?', a.again]];
  for (const [q, text] of answered) if (text.trim()) lines.push('', `**${q}** ${text.trim()}`);
  return lines;
}
