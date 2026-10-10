// The Playtests page: every run recorded in this browser (plus imported ones), grouped by setup.
import { download, listRuns, listSessions, openDb, readLog } from './logSink';
import { issueMarkdown, setupKey, summarize, toCsv } from './playtestStats';
import type { RunRecord } from './runTracker';
import { getTester, setTester } from './tester';

const REPO_ISSUES = 'https://github.com/devlinjunker/train-robber/issues/new';
const ALL = '';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (x: number) => `${Math.round(x * 100)}%`;

async function main() {
  const db = await openDb();
  let runs: RunRecord[] = [];
  let stored = new Set<string>();
  const filters = new Map<string, string>();

  const tester = $<HTMLInputElement>('tester');
  tester.value = getTester();
  tester.addEventListener('change', () => setTester(tester.value.trim()));

  const visible = () => runs.filter((r) => [...filters].every(([k, v]) => v === ALL || filterValue(r, k) === v));

  async function load() {
    runs = (await listRuns(db)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    stored = new Set((await listSessions(db)).map((s) => s.id));
    renderFilters();
    render();
  }

  function renderFilters() {
    const keys = ['tester', 'outcome', 'gameVersion', 'mapId', ...new Set(runs.flatMap((r) => Object.keys(r.variants).map((g) => `v:${g}`)))];
    const box = $('filters');
    box.innerHTML = '';
    for (const k of keys) {
      const values = [...new Set(runs.map((r) => filterValue(r, k)))].sort();
      if (values.length < 2 && !filters.get(k)) continue;
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">all</option>` + values.map((v) => `<option${filters.get(k) === v ? ' selected' : ''}>${esc(v)}</option>`).join('');
      sel.addEventListener('change', () => { filters.set(k, sel.value); render(); });
      const label = document.createElement('label');
      label.append(k.startsWith('v:') ? k.slice(2) : k, sel);
      box.append(label);
    }
  }

  function render() {
    const rs = visible();
    const sum = summarize(rs);
    $('summary').innerHTML = sum.length === 0 ? `<tr><td class="empty">No runs yet. Commit to a train with E and play; each run shows up here when it ends.</td></tr>` :
      `<tr><th>Setup</th><th class="num">Runs</th><th class="num">Testers</th><th class="num">Died</th><th class="num">Cancelled</th><th class="num">Retry</th><th class="num">Abandoned</th><th class="num">Avg length</th><th class="num">Avg jumps</th><th class="num">Perfect / good / fail</th><th class="num">Got aboard</th><th class="num">Median to board</th><th class="num">Notes</th></tr>` +
      sum.map((s) => `<tr><td>${esc(s.setup)}</td><td class="num">${s.runs}</td><td class="num">${s.testers}</td><td class="num">${s.outcomes.died}</td><td class="num">${s.outcomes.cancelled}</td><td class="num">${s.outcomes.retry}</td><td class="num">${s.outcomes.abandoned}</td><td class="num">${s.avgSec.toFixed(1)} s</td><td class="num">${s.avgAttempts.toFixed(1)}</td><td class="num">${pct(s.perfect)} / ${pct(s.good)} / ${pct(s.fail)}</td><td class="num">${pct(s.aboard)}</td><td class="num">${s.medianToAboardSec === null ? '–' : `${s.medianToAboardSec.toFixed(1)} s`}</td><td class="num">${s.notes}</td></tr>`).join('');
    $('runs').innerHTML = rs.length === 0 ? '' :
      `<tr><th>When</th><th>Tester</th><th>Setup</th><th>Seed</th><th>Map</th><th>Train</th><th>Outcome</th><th class="num">Length</th><th class="num">Jumps (P/G/F)</th><th>Furthest</th><th class="num">Damage</th><th>Notes</th><th>Logs</th></tr>` +
      rs.map((r) => `<tr><td>${esc(new Date(r.startedAt).toLocaleString())}</td><td>${esc(r.tester || '–')}</td><td>${esc(setupKey(r))}</td><td>${esc(r.seed)}</td><td>${esc(r.mapId)}</td><td>${esc(r.trainId)}</td><td class="${r.outcome}">${r.outcome}</td><td class="num">${r.durationSec.toFixed(1)} s</td><td class="num">${r.boardingAttempts} (${r.boarding.perfect}/${r.boarding.good}/${r.boarding.fail})</td><td>${r.furthestPhase}</td><td class="num">${r.damageTaken}</td><td class="notes">${r.notes.map((n) => esc(n.text)).join('<br>')}</td><td>${stored.has(r.session) ? `<a class="watch" href="${esc(watchUrl(r))}" target="_blank">Watch</a> <button data-logs="${esc(r.session)}">.log</button>` : '<span class="muted">pruned</span>'}</td></tr>`).join('');
  }

  $('runs').addEventListener('click', async (e) => {
    const session = (e.target as HTMLElement).dataset.logs;
    if (!session) return;
    const stamp = session.replace(/[:.]/g, '-');
    for (const log of ['commands', 'events'] as const) {
      const text = await readLog(db, session, log);
      if (text) download(`${stamp}.${log}.log`, text);
    }
  });
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('csv').addEventListener('click', () => download(`playtests-${stamp()}.csv`, toCsv(visible()), 'text/csv'));
  $('json').addEventListener('click', () => download(`playtests-${stamp()}.json`, JSON.stringify(visible(), null, 1), 'application/json'));
  $('github').addEventListener('click', () => {
    const rs = visible();
    if (rs.length === 0) return;
    const who = getTester() || 'a tester';
    const q = new URLSearchParams({ title: `Playtest: ${rs.length} runs from ${who}`, body: issueMarkdown(rs), labels: 'playtest' });
    open(`${REPO_ISSUES}?${q}`, '_blank');
  });
  const file = $<HTMLInputElement>('importFile');
  $('import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    // Read every file first: an IndexedDB transaction closes when the code awaits anything else.
    const incoming: RunRecord[] = [];
    for (const f of Array.from(file.files ?? [])) {
      try {
        const parsed = JSON.parse(await f.text()) as RunRecord[];
        incoming.push(...parsed.filter((r) => r?.id && r.session && r.variants && r.boarding));
      } catch (e) { alert(`${f.name}: ${(e as Error).message}`); }
    }
    const n = incoming.length;
    const tx = db.transaction('runs', 'readwrite');
    for (const r of incoming) tx.objectStore('runs').put(r);
    tx.oncomplete = () => { file.value = ''; void load().then(() => alert(`Imported ${n} runs.`)); };
  });
  addEventListener('focus', () => void load());
  await load();
}

/** The game page in replay mode, opened at the run's commit when the record knows it. */
function watchUrl(r: RunRecord): string {
  const q = new URLSearchParams({ replay: r.session });
  if (r.startTick !== undefined) q.set('t', String(r.startTick));
  return `./?${q}`;
}

function filterValue(r: RunRecord, key: string): string {
  if (key.startsWith('v:')) return r.variants[key.slice(2)] ?? '–';
  return String(r[key as keyof RunRecord] ?? '') || '–';
}

void main();
