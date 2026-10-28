// The Playtests page (phase 2 M6a): experiment cards that compare a few setups on one question,
// and every run recorded in this browser (plus imported ones) in a list with Robbery, Boarding and
// All views. Rule: a milestone adds its numbers to a view and to the expanded run, never as a new
// column in every view.
import { EXPERIMENT_NUMBERS, overridesFromSet, setParams, setupSelection, type Experiment, type ExperimentBase, type ExperimentNumber, type ExperimentSetup } from '@train-robber/config';
import { download, listRuns, listSessions, openDb, readLog } from './logSink';
import pkg from '../package.json';
import {
  compareVersions, duration, experimentNumber, issueMarkdown, money, notesMarkdown, NUMBER_LABELS, outcomeWords, PULL_WINDOW_SEC, pullWords,
  runVersion, sessionPull, setupKey, setupRuns, toCsv, type ExperimentReport,
} from './playtestStats';
import type { RunRecord } from './runTracker';
import { getTester, setTester } from './tester';
import {
  ANSWER_FIELDS, classifyIncoming, decodeExperiment, emptyAnswers, loadAnswers, loadBases, loadOwn, mergeIncoming, newExperimentId, parseExperiment,
  playQuery, saveAnswers, saveBases, saveOwn, shareQuery, type Answers,
} from './experiments';
import { diffLabel, mapChoices, presetIds, repoExperiments, selectionError, settablePaths, variantGroups } from './setup';

const REPO_ISSUES = 'https://github.com/devlinjunker/train-robber/issues/new';
const ALL = '';
const VIEW_KEY = 'train-robber-playtests-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/** An experiment as the page shows it: where it came from and the base its Play links use. */
interface Shown { exp: Experiment; repo: boolean; base: ExperimentBase | undefined; baseChanged: boolean }

// ---------- Run list views ----------

interface Column { head: string; num?: boolean; cell: (r: RunRecord) => string }
type View = 'robbery' | 'boarding' | 'all';
const VIEWS: Record<View, { name: string; help: string }> = {
  robbery: { name: 'Robbery', help: 'How each robbery went: what you carried off, what you left on the train, and the clock and heat at the end.' },
  boarding: { name: 'Boarding', help: 'The Phase 1 numbers: jumps, how far each run got, time from commit to aboard, damage.' },
  all: { name: 'All', help: 'Who played what, on which build and map. Click a run for every number it recorded.' },
};

/** How a setup is told in lists: its difference from the default. */
function selectionLabel(base: ExperimentBase | undefined, setup: ExperimentSetup): string {
  const sel = setupSelection(base, setup);
  return diffLabel({ preset: sel.preset, variants: sel.variants, overrides: overridesFromSet(setParams(sel.set)), ...(sel.map ? { map: sel.map } : {}) });
}
const baseLabel = (base: ExperimentBase | undefined) => selectionLabel(base, { id: 'base', name: 'base' });

async function main() {
  const db = await openDb();
  let runs: RunRecord[] = [];
  let stored = new Set<string>();
  const filters = new Map<string, string>();
  let own = loadOwn();
  let bases = loadBases();
  const answers = loadAnswers();
  let view: View = 'robbery';
  try { const v = localStorage.getItem(VIEW_KEY); if (v && v in VIEWS) view = v as View; } catch { /* default view */ }
  const expanded = new Set<string>();
  const repoIds = new Set(repoExperiments.map((e) => e.id));

  $('build').textContent = pkg.version;
  const tester = $<HTMLInputElement>('tester');
  tester.value = getTester();
  tester.addEventListener('change', () => setTester(tester.value.trim()));

  const shown = (): Shown[] => [
    ...repoExperiments.map((exp) => ({ exp, repo: true, base: bases[exp.id] ?? exp.base, baseChanged: exp.id in bases })),
    ...own.map((exp) => ({ exp, repo: false, base: exp.base, baseChanged: false })),
  ];
  const findShown = (id: string | undefined) => (id ? shown().find((s) => s.exp.id === id) : undefined);
  const labelCache = new Map<string, string>();
  /** The Setup column: the experiment and setup when the run was tagged, else its difference from the default. */
  const runSetup = (r: RunRecord): string => {
    const s = findShown(r.exp);
    const setup = s?.exp.setups.find((x) => x.id === r.setup);
    if (s && setup) return `${s.exp.title} › ${setup.name}`;
    const k = setupKey(r);
    if (!labelCache.has(k)) labelCache.set(k, diffLabel(r));
    return labelCache.get(k)!;
  };

  const visible = () => runs.filter((r) => [...filters].every(([k, v]) => v === ALL || filterValue(r, k) === v));

  /** Save an experiment someone shared (link or file), asking on an id clash. Returns the id it is saved under. */
  function receive(incoming: Experiment): string {
    const kind = classifyIncoming(incoming, own, repoIds);
    const replace = kind === 'conflict' && confirm(`You already have an experiment with the id "${incoming.id}" but different contents.\n\nOK: replace yours with the shared "${incoming.title}".\nCancel: keep both (the shared one is saved as a copy).`);
    const r = mergeIncoming(incoming, own, repoIds, replace);
    if (r.kind === 'new' || r.kind === 'conflict') { own = r.own; saveOwn(own); }
    return r.id;
  }

  /** Runs carry a copy of a tester's own experiment: add any you don't have, so their runs get a card. */
  function adoptFromRuns() {
    const known = new Set([...repoIds, ...own.map((e) => e.id)]);
    let added = false;
    for (const r of runs) {
      if (r.experiment && !known.has(r.experiment.id)) {
        try { own = [...own, parseExperiment(r.experiment)]; known.add(r.experiment.id); added = true; } catch { /* a damaged copy: the runs stay in the list */ }
      }
    }
    if (added) saveOwn(own);
  }

  async function load() {
    runs = (await listRuns(db)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    stored = new Set((await listSessions(db)).map((s) => s.id));
    adoptFromRuns();
    render();
  }
  function render() { renderFilters(); renderExperiments(); renderRuns(); }

  // ---------- Filters ----------

  function renderFilters() {
    const keys = ['version', 'tester', 'outcome', 'experiment', 'mapId', ...new Set(runs.flatMap((r) => Object.keys(r.variants).map((g) => `v:${g}`)))];
    const box = $('filters');
    box.innerHTML = '';
    for (const k of keys) {
      const values = [...new Set(runs.map((r) => filterValue(r, k)))].sort(k === 'version' ? compareVersions : undefined);
      // Version is always offered, so notes can be exported for one version; other filters only when they would split the runs.
      if (k !== 'version' && values.length < 2 && !filters.get(k)) continue;
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">all</option>` + values.map((v) => `<option value="${esc(v)}"${filters.get(k) === v ? ' selected' : ''}>${esc(k === 'experiment' ? findShown(v)?.exp.title ?? v : v)}</option>`).join('');
      sel.addEventListener('change', () => { filters.set(k, sel.value); renderExperiments(); renderRuns(); });
      const label = document.createElement('label');
      label.append(k.startsWith('v:') ? k.slice(2) : k === 'mapId' ? 'map' : k, sel);
      box.append(label);
    }
  }

  // ---------- Experiment cards ----------

  function card(s: Shown, rs: readonly RunRecord[]): string {
    const { exp } = s;
    const cols = exp.setups.map((setup) => setupRuns(rs, exp.id, setup.id));
    const ans = answers[exp.id] ?? emptyAnswers();
    const cells = (f: (runs: RunRecord[]) => string) => cols.map((c) => `<td>${f(c)}</td>`).join('');
    const notes = (c: RunRecord[]) => {
      const ns = c.flatMap((r) => r.notes.map((n) => `<li>${esc(n.text)} <span class="muted">(${esc(r.tester || 'run')} ${r.runNumber}, ${esc(r.outcome)})</span></li>`));
      return ns.length ? `<ul>${ns.join('')}</ul>` : '<span class="muted">–</span>';
    };
    const href = (setupId: string) => `./${playQuery(exp, setupId, s.base, !s.repo)}`;
    const base = s.base && Object.keys(s.base).length ? baseLabel(s.base) : 'default';
    return `<article class="card" id="exp-${esc(exp.id)}" data-exp="${esc(exp.id)}">
      <div class="card-head">
        <div><h3>${esc(exp.title)}<span class="tag">${s.repo ? 'repo' : 'yours'}</span></h3></div>
        <div class="actions">
          <button data-act="share" title="Copy a link that opens this experiment on anyone's Playtests page${s.repo ? '' : ' and saves it there'}">Share link</button>
          <button data-act="dup" title="Make your own editable copy">Duplicate</button>
          <button data-act="file" title="Copy the experiment as a packages/content/playtests/*.json file">Copy as file</button>
          ${s.repo ? '<button data-act="base" title="Change the base setup every setup builds on, in this browser only">Edit base</button>' : '<button data-act="edit">Edit</button><button data-act="del">Delete</button>'}
        </div>
      </div>
      <div class="question">${esc(exp.question)}</div>
      <div class="base muted">Base: ${esc(base)}${s.baseChanged ? ' <b>(changed in this browser)</b> <button data-act="resetbase">Reset</button>' : ''}</div>
      <div class="scroll"><table class="cmp">
        <tr><th></th>${exp.setups.map((setup) => `<th>${esc(setup.name)}<div class="diff">${esc(selectionLabel(s.base, setup))}</div><a class="play" href="${esc(href(setup.id))}" target="_blank" title="Play this setup; its runs are tagged for this card">Play ▸</a></th>`).join('')}</tr>
        <tr><td>Runs</td>${cells((c) => `${c.length}${c.length ? ` <span class="muted">(${new Set(c.map((r) => r.tester || '?')).size} tester${new Set(c.map((r) => r.tester || '?')).size === 1 ? '' : 's'})</span>` : ''}`)}</tr>
        ${exp.numbers.map((n) => `<tr><td title="${esc(EXPERIMENT_NUMBERS[n])}">${esc(NUMBER_LABELS[n])}</td>${cells((c) => esc(experimentNumber(n, c)))}</tr>`).join('')}
        <tr><td title="Runs followed by another run in the same session, and how many of those started within ${PULL_WINDOW_SEC} s of the last one ending (the summary screen)">Went again within ${PULL_WINDOW_SEC} s</td>${cells((c) => esc(pullWords(sessionPull(c))))}</tr>
        <tr><td title="The outcome of the last run in each session (a page load); closed means the tab closed mid-run">Sessions ended by</td>${cells((c) => esc(outcomeWords(sessionPull(c).endedBy)))}</tr>
        <tr><td>Notes</td>${cells(notes)}</tr>
      </table></div>
      <div class="answers">
        <label>Your answer to the question<textarea data-ans="answer" rows="2">${esc(ans.answer)}</textarea></label>
        ${ANSWER_FIELDS.map((f) => `<label>${esc(f.label)}<textarea data-ans="${f.key}" rows="1">${esc(ans[f.key])}</textarea></label>`).join('')}
      </div>
    </article>`;
  }

  function renderExperiments() {
    const rs = visible();
    const list = shown();
    $('experiments').innerHTML = list.length ? list.map((s) => card(s, rs)).join('') : '<div class="empty">No experiments yet. Press New experiment to compare a few setups.</div>';
  }

  async function copyText(btn: HTMLButtonElement, text: string, fallback: () => void) {
    const label = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { fallback(); }
    setTimeout(() => { btn.textContent = label; }, 1500);
  }

  $('experiments').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    const id = btn?.closest<HTMLElement>('[data-exp]')?.dataset.exp;
    const s = findShown(id);
    if (!btn || !s) return;
    const { exp } = s;
    switch (btn.dataset.act) {
      case 'share': {
        const url = `${location.origin}${location.pathname}${shareQuery(exp, s.repo)}`;
        void copyText(btn, url, () => prompt('Copy this link:', url));
        break;
      }
      case 'file': {
        const text = JSON.stringify(exp, null, 2) + '\n';
        void copyText(btn, text, () => download(`${exp.id}.json`, text, 'application/json'));
        break;
      }
      case 'dup': {
        const copy: Experiment = { ...structuredClone(exp), id: newExperimentId(exp.title, new Set([...repoIds, ...own.map((o) => o.id)])), title: `${exp.title} (copy)`.slice(0, 80) };
        if (s.base) copy.base = structuredClone(s.base); else delete copy.base;
        openEditor(copy, 'full', (saved) => { own = [...own, saved as Experiment]; saveOwn(own); render(); });
        break;
      }
      case 'edit':
        openEditor(structuredClone(exp), 'full', (saved) => { own = own.map((o) => (o.id === exp.id ? saved as Experiment : o)); saveOwn(own); render(); });
        break;
      case 'base':
        openEditor({ ...structuredClone(exp), ...(s.base ? { base: structuredClone(s.base) } : {}) }, 'base', (saved) => {
          const b = (saved as Experiment).base ?? {};
          if (JSON.stringify(b) === JSON.stringify(exp.base ?? {})) delete bases[exp.id]; else bases = { ...bases, [exp.id]: b };
          saveBases(bases); render();
        });
        break;
      case 'resetbase':
        delete bases[exp.id]; saveBases(bases); render();
        break;
      case 'del':
        if (confirm(`Delete the experiment "${exp.title}"? Its runs stay in the run list.`)) { own = own.filter((o) => o.id !== exp.id); saveOwn(own); render(); }
        break;
    }
  });
  $('experiments').addEventListener('input', (e) => {
    const ta = e.target as HTMLTextAreaElement;
    const key = ta.dataset.ans as keyof Answers | undefined;
    const id = ta.closest<HTMLElement>('[data-exp]')?.dataset.exp;
    if (!key || !id) return;
    answers[id] = { ...(answers[id] ?? emptyAnswers()), [key]: ta.value };
    saveAnswers(answers);
  });
  $('newExp').addEventListener('click', () => {
    const draft: Experiment = {
      schemaVersion: 1, id: newExperimentId('my experiment', new Set([...repoIds, ...own.map((o) => o.id)])), title: '', question: '',
      setups: [{ id: 'a', name: 'Default' }, { id: 'b', name: 'Changed' }], numbers: ['outcomes', 'length', 'lootCarried', 'lootLeft'],
    };
    // The id comes from the title once it is saved, and never changes after (runs are tagged with it).
    openEditor(draft, 'full', (saved) => {
      own = [...own, { ...saved, id: newExperimentId(saved.title, new Set([...repoIds, ...own.map((o) => o.id)])) }];
      saveOwn(own); render();
    });
  });

  // ---------- Run list ----------

  const furthest = (r: RunRecord) => r.furthestPhase;
  const loot = (v: number | undefined, n: number | undefined) => (v === undefined ? '–' : `${money(v)} (${n ?? 0})`);
  const COLS: Record<View, Column[]> = {
    robbery: [
      { head: 'When', cell: (r) => esc(when(r.startedAt)) },
      { head: 'Setup', cell: (r) => esc(runSetup(r)) },
      { head: 'Outcome', cell: (r) => `<span class="${r.outcome}">${r.outcome}</span>` },
      { head: 'Length', num: true, cell: (r) => duration(r.durationSec) },
      { head: 'Carried', num: true, cell: (r) => loot(r.lootValue, r.lootItems) },
      { head: 'Left on train', num: true, cell: (r) => loot(r.lootLeftValue, r.lootLeftItems) },
      { head: 'Time left', num: true, cell: (r) => duration(r.countdownLeftSec) },
      { head: 'Heat', num: true, cell: (r) => String(r.heatAtEnd ?? '–') },
    ],
    boarding: [
      { head: 'When', cell: (r) => esc(when(r.startedAt)) },
      { head: 'Setup', cell: (r) => esc(runSetup(r)) },
      { head: 'Outcome', cell: (r) => `<span class="${r.outcome}">${r.outcome}</span>` },
      { head: 'Jumps (P/G/F)', num: true, cell: (r) => `${r.boardingAttempts} (${r.boarding.perfect}/${r.boarding.good}/${r.boarding.fail})` },
      { head: 'Furthest', cell: (r) => furthest(r) },
      { head: 'To board', num: true, cell: (r) => duration(r.commitToAboardSec) },
      { head: 'Damage', num: true, cell: (r) => String(r.damageTaken) },
      { head: 'Train', cell: (r) => esc(r.trainId) },
    ],
    all: [
      { head: 'When', cell: (r) => esc(when(r.startedAt)) },
      { head: 'Version', cell: (r) => esc(runVersion(r)) },
      { head: 'Tester', cell: (r) => esc(r.tester || '–') },
      { head: 'Setup', cell: (r) => esc(runSetup(r)) },
      { head: 'Map', cell: (r) => esc(r.mapId) },
      { head: 'Outcome', cell: (r) => `<span class="${r.outcome}">${r.outcome}</span>` },
      { head: 'Length', num: true, cell: (r) => duration(r.durationSec) },
      { head: 'Notes', num: true, cell: (r) => String(r.notes.length || '–') },
    ],
  };

  /** Everything a run recorded, for its expanded row. Milestones add their numbers here. */
  function detail(r: RunRecord, span: number): string {
    const s = findShown(r.exp);
    const setup = s?.exp.setups.find((x) => x.id === r.setup);
    const items: [string, string][] = [
      ['Version', runVersion(r)], ['Tester', r.tester || '–'], ['Run', `run ${r.runNumber} in session ${r.session}`], ['Seed', r.seed], ['Map', r.mapId], ['Train', r.trainId],
      ['Experiment', r.exp ? `${s?.exp.title ?? r.exp} › ${setup?.name ?? r.setup ?? '–'}` : '–'],
      ['Setup (vs default)', diffLabel(r)], ['Preset', r.preset], ['Variants', Object.entries(r.variants).map(([g, id]) => `${g}:${id}`).join(' ')],
      ['?set= values', setupKey(r).split(' · set ')[1] ?? '–'],
      ['Outcome', r.outcome], ['Length', duration(r.durationSec)], ['Started', when(r.startedAt)],
      ['Carried at end', loot(r.lootValue, r.lootItems)], ['Banked', money(r.cashOut)], ['Left on train', loot(r.lootLeftValue, r.lootLeftItems)],
      ['Time left', duration(r.countdownLeftSec)], ['Heat at end', String(r.heatAtEnd ?? '–')],
      ['Jumps (perfect / good / fail)', `${r.boardingAttempts} (${r.boarding.perfect} / ${r.boarding.good} / ${r.boarding.fail})`], ['Furthest', r.furthestPhase],
      ['Commit to aboard', duration(r.commitToAboardSec)], ['Damage taken', String(r.damageTaken)],
      ['Whistles', String(r.whistles ?? '–')], ['Mount jumps', String(r.mountAttempts ?? '–')],
      ['Refused commands', Object.entries(r.rejections ?? {}).map(([k, n]) => `${k} ×${n}`).join(', ') || '–'],
    ];
    const notes = r.notes.length ? `<div class="notes">${r.notes.map((n) => `<div>tick ${n.t}: ${esc(n.text)}</div>`).join('')}</div>` : '<div class="notes muted">No notes (press N in game).</div>';
    const logs = stored.has(r.session)
      ? `<a href="${esc(watchUrl(r))}" target="_blank">Watch</a> <button data-logs="${esc(r.session)}">Download .log files</button>`
      : '<span class="muted">Logs pruned (only the newest 20 sessions keep them).</span>';
    return `<tr class="detail"><td colspan="${span}"><dl>${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${notes}
      <div class="bar">${logs} <a href="./${esc(r.url || '')}" target="_blank">Play this setup again</a></div></td></tr>`;
  }

  function renderRuns() {
    $('views').innerHTML = (Object.keys(VIEWS) as View[]).map((v) => `<button data-view="${v}" aria-pressed="${v === view}">${VIEWS[v].name}</button>`).join('');
    $('viewHelp').textContent = VIEWS[view].help;
    const rs = visible();
    const cols = COLS[view];
    $('runs').innerHTML = rs.length === 0
      ? `<tr><td class="empty">${runs.length ? 'No runs match the filters.' : 'No runs yet. Press Play on an experiment setup, or open the game and commit to a train with E; each run shows up here when it ends.'}</td></tr>`
      : `<tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.head}</th>`).join('')}</tr>` +
        rs.map((r) => `<tr class="run${expanded.has(r.id) ? ' open' : ''}" data-run="${esc(r.id)}" title="Click for details">${cols.map((c) => `<td class="${c.num ? 'num' : c.head === 'Setup' ? 'setup' : ''}">${c.cell(r)}</td>`).join('')}</tr>${expanded.has(r.id) ? detail(r, cols.length) : ''}`).join('');
  }

  $('views').addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.view as View | undefined;
    if (!v) return;
    view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* remembered for this page only */ }
    renderRuns();
  });
  $('runs').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const session = el.dataset.logs;
    if (session) {
      const s = session.replace(/[:.]/g, '-');
      for (const log of ['commands', 'events'] as const) {
        const text = await readLog(db, session, log);
        if (text) download(`${s}.${log}.log`, text);
      }
      return;
    }
    if (el.closest('a, button')) return;
    const row = el.closest<HTMLElement>('tr.run');
    if (!row?.dataset.run) return;
    if (expanded.has(row.dataset.run)) expanded.delete(row.dataset.run); else expanded.add(row.dataset.run);
    renderRuns();
  });

  // ---------- Export menu ----------

  const menu = $<HTMLDetailsElement>('exportMenu');
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target as Node)) menu.open = false; });
  const activeFilters = () => [...filters].filter(([, v]) => v !== ALL).map(([k, v]) => `${k.startsWith('v:') ? k.slice(2) : k} ${v}`);
  /** Experiments worth reporting: ones with runs in view, or an answer written. */
  const reports = (rs: readonly RunRecord[]): ExperimentReport[] => shown()
    .filter((s) => rs.some((r) => r.exp === s.exp.id) || Object.values(answers[s.exp.id] ?? {}).some((a) => a.trim()))
    .map((s) => ({
      exp: s.exp, labels: s.exp.setups.map((setup) => selectionLabel(s.base, setup)),
      ...(s.base && Object.keys(s.base).length ? { baseLabel: baseLabel(s.base) } : {}),
      answers: answers[s.exp.id] ?? emptyAnswers(),
    }));
  const notes = () => { const rs = visible(); return notesMarkdown(rs, activeFilters(), reports(rs)); };
  const notesName = () => {
    const v = filters.get('version');
    return `playtest-notes-${v && v !== ALL ? v : 'all'}-${stamp()}.md`;
  };
  $('notesCopy').addEventListener('click', () => void copyText($<HTMLButtonElement>('notesCopy'), notes(), () => download(notesName(), notes(), 'text/markdown')));
  $('notesDownload').addEventListener('click', () => download(notesName(), notes(), 'text/markdown'));
  $('csv').addEventListener('click', () => download(`playtests-${stamp()}.csv`, toCsv(visible()), 'text/csv'));
  $('json').addEventListener('click', () => download(`playtests-${stamp()}.json`, JSON.stringify(visible(), null, 1), 'application/json'));
  $('github').addEventListener('click', () => {
    const rs = visible();
    const reps = reports(rs);
    if (rs.length === 0 && reps.length === 0) return;
    const who = getTester() || 'a tester';
    const q = new URLSearchParams({ title: `Playtest: ${rs.length} runs from ${who}`, body: issueMarkdown(rs, 6000, reps), labels: 'playtest' });
    window.open(`${REPO_ISSUES}?${q}`, '_blank');
  });
  const file = $<HTMLInputElement>('importFile');
  $('import').addEventListener('click', () => { menu.open = false; file.click(); });
  file.addEventListener('change', async () => {
    // Read every file first: an IndexedDB transaction closes when the code awaits anything else.
    const incoming: RunRecord[] = [];
    const exps: string[] = [];
    for (const f of Array.from(file.files ?? [])) {
      try {
        const parsed = JSON.parse(await f.text()) as unknown;
        if (Array.isArray(parsed)) incoming.push(...(parsed as RunRecord[]).filter((r) => r?.id && r.session && r.variants && r.boarding));
        else { const id = receive(parseExperiment(parsed)); exps.push(id); flash(id); }
      } catch (e) { alert(`${f.name}: ${(e as Error).message}`); }
    }
    const n = incoming.length;
    const tx = db.transaction('runs', 'readwrite');
    for (const r of incoming) tx.objectStore('runs').put(r);
    tx.oncomplete = () => {
      file.value = '';
      void load().then(() => {
        if (exps.length) flash(exps[0]!);
        alert([n ? `Imported ${n} runs.` : '', exps.length ? `Saved ${exps.length} experiment${exps.length === 1 ? '' : 's'}.` : ''].filter(Boolean).join(' ') || 'Nothing to import.');
      });
    };
  });

  // ---------- Experiment editor ----------

  function openEditor(draft: Experiment, mode: 'full' | 'base', onSave: (e: Experiment) => void) {
    const dlg = $<HTMLDialogElement>('editor');
    const presets = presetIds(), groups = variantGroups(), maps = mapChoices();
    const opts = (values: string[], current: string | undefined, inherit: string) =>
      `<option value="">${esc(inherit)}</option>` + values.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
    const setRow = (path = '', value: unknown = '') =>
      `<div class="row setrow"><input list="setPaths" placeholder="countdown.scale" value="${esc(path)}" /><input placeholder="value" value="${esc(typeof value === 'string' ? value : JSON.stringify(value))}" /><button type="button" data-del-set title="Remove">×</button></div>`;
    const selection = (sel: ExperimentBase, inherit: string) => {
      const changed = Object.keys(sel.variants ?? {}).length;
      return `<div class="row">
          <label>Preset<select data-f="preset">${opts(presets, sel.preset, inherit)}</select></label>
          <label>Map<select data-f="map">${opts(maps, sel.map, inherit === '(base)' ? '(base)' : 'default (alpha-flats)')}</select></label>
        </div>
        <details${changed ? ' open' : ''}><summary class="muted">Variants${changed ? ` (${changed} picked)` : ''}</summary><div class="vars">${groups.map(([g, ids]) =>
          `<label>${esc(g)}<select data-var="${esc(g)}">${opts(ids, sel.variants?.[g], inherit === '(base)' ? '(base)' : "(preset's)")}</select></label>`).join('')}</div></details>
        <div class="muted">?set= values</div><div data-sets>${Object.entries(sel.set ?? {}).map(([p, v]) => setRow(p, v)).join('')}</div>
        <button type="button" data-add-set>Add a value</button>`;
    };
    const setupBlock = (s: ExperimentSetup, i: number) => `<fieldset data-setup="${esc(s.id)}"><legend>Setup ${i + 1}</legend>
        <div class="row"><label>Name<input data-f="name" value="${esc(s.name)}" maxlength="40" /></label>${mode === 'full' ? '<button type="button" data-del-setup>Remove setup</button>' : ''}</div>
        ${selection(s, '(base)')}</fieldset>`;
    const full = mode === 'full';
    dlg.innerHTML = `<form method="dialog">
      <h3>${full ? 'Experiment' : `Base setup for "${esc(draft.title)}"`}</h3>
      ${full ? `<div class="row"><label style="flex:1">Title<input class="wide" data-f="title" value="${esc(draft.title)}" maxlength="80" placeholder="Town spacing" /></label></div>
      <div class="row"><label style="flex:1">Question<textarea class="wide" data-f="question" rows="2" maxlength="400" placeholder="Which town spacing makes a robbery tense without dragging?">${esc(draft.question)}</textarea></label></div>`
        : '<div class="muted">Every setup builds on the base. This change stays in this browser; Reset on the card puts the repo base back.</div>'}
      <fieldset data-base><legend>Base (shared by every setup)</legend>${selection(draft.base ?? {}, 'default')}</fieldset>
      ${full ? `<div data-setups>${draft.setups.map(setupBlock).join('')}</div><button type="button" data-add-setup>Add setup</button>
      <fieldset><legend>Numbers to compare (up to 6)</legend><div class="numbers">${(Object.keys(EXPERIMENT_NUMBERS) as ExperimentNumber[]).map((n) =>
        `<label><input type="checkbox" data-num="${n}"${draft.numbers.includes(n) ? ' checked' : ''} /> ${esc(EXPERIMENT_NUMBERS[n])}</label>`).join('')}</div></fieldset>` : ''}
      <datalist id="setPaths">${settablePaths().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="error" data-error></div>
      <div class="foot"><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-save>Save</button></div>
    </form>`;

    const readSelection = (root: Element): ExperimentBase => {
      const f = (name: string) => root.querySelector<HTMLSelectElement>(`:scope > .row [data-f="${name}"]`)?.value || undefined;
      const variants: Record<string, string> = {};
      root.querySelectorAll<HTMLSelectElement>(':scope > details [data-var]').forEach((s) => { if (s.value) variants[s.dataset.var!] = s.value; });
      const set: Record<string, string | number | boolean | null> = {};
      root.querySelectorAll(':scope > [data-sets] > .setrow').forEach((row) => {
        const [p, v] = Array.from(row.querySelectorAll('input')).map((i) => i.value.trim());
        if (!p) return;
        let value: string | number | boolean | null = v ?? '';
        try { const j = JSON.parse(value) as unknown; if (j === null || ['number', 'boolean', 'string'].includes(typeof j)) value = j as typeof value; } catch { /* plain text */ }
        set[p] = value;
      });
      const preset = f('preset'), map = f('map');
      return { ...(preset ? { preset } : {}), ...(Object.keys(variants).length ? { variants } : {}), ...(Object.keys(set).length ? { set } : {}), ...(map ? { map } : {}) };
    };

    dlg.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.matches('[data-add-set]')) t.previousElementSibling!.insertAdjacentHTML('beforeend', setRow());
      else if (t.matches('[data-del-set]')) t.closest('.setrow')!.remove();
      else if (t.matches('[data-del-setup]')) t.closest('fieldset')!.remove();
      else if (t.matches('[data-add-setup]')) {
        const box = dlg.querySelector('[data-setups]')!;
        const taken = new Set(Array.from(box.querySelectorAll<HTMLElement>('[data-setup]')).map((f) => f.dataset.setup!));
        let id = 'a';
        for (let i = 0; taken.has(id); i++) id = String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
        box.insertAdjacentHTML('beforeend', setupBlock({ id, name: '' }, box.children.length));
      } else if (t.matches('[data-cancel]')) dlg.close();
      else if (t.matches('[data-save]')) {
        const err = dlg.querySelector<HTMLElement>('[data-error]')!;
        const v = (name: string) => dlg.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-f="${name}"]`)?.value.trim() ?? '';
        const base = readSelection(dlg.querySelector('[data-base]')!);
        const next: Experiment = full ? {
          schemaVersion: 1, id: draft.id, title: v('title'), question: v('question'),
          ...(Object.keys(base).length ? { base } : {}),
          setups: Array.from(dlg.querySelectorAll<HTMLElement>('[data-setup]')).map((fs) => ({ id: fs.dataset.setup!, name: fs.querySelector<HTMLInputElement>('[data-f="name"]')!.value.trim(), ...readSelection(fs) })),
          numbers: (Object.keys(EXPERIMENT_NUMBERS) as ExperimentNumber[]).filter((n) => dlg.querySelector<HTMLInputElement>(`[data-num="${n}"]`)?.checked),
        } : { ...draft, ...(Object.keys(base).length ? { base } : {}) };
        if (!full && !Object.keys(base).length) delete next.base;
        let problem: string | null = null;
        try { parseExperiment(next); } catch (x) { problem = (x as Error).message.replace(/^not a valid experiment /, 'Check the form ') ; }
        if (!problem) for (const s of next.setups) {
          const sel = setupSelection(next.base, s);
          const bad = selectionError({ preset: sel.preset, variants: sel.variants, overrides: overridesFromSet(setParams(sel.set)) });
          if (bad) { problem = `${s.name}: ${bad}`; break; }
        }
        if (problem) { err.textContent = problem; return; }
        dlg.close();
        onSave(next);
      }
    };
    dlg.showModal();
  }

  // ---------- Links that open this page ----------

  function flash(id: string) {
    requestAnimationFrame(() => {
      const el = document.getElementById(`exp-${id}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2500);
    });
  }
  const q = new URLSearchParams(location.search);
  let target = q.get('exp') ?? undefined;
  const xp = q.get('xp');
  if (xp) {
    try { target = receive(decodeExperiment(xp)); } catch (e) { alert(`This Share link did not open: ${(e as Error).message}.`); }
    q.delete('xp');
    if (target) q.set('exp', target);
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`);
  }

  addEventListener('focus', () => { own = loadOwn(); bases = loadBases(); void load(); });
  await load();
  if (target) {
    if (findShown(target)) flash(target);
    else alert(`This page has no experiment "${target}". It may come from a newer build.`);
  }
}

/** The game page in replay mode, opened at the run's commit when the record knows it. */
function watchUrl(r: RunRecord): string {
  const q = new URLSearchParams({ replay: r.session });
  if (r.startTick !== undefined) q.set('t', String(r.startTick));
  return `./?${q}`;
}

function filterValue(r: RunRecord, key: string): string {
  if (key === 'version') return runVersion(r);
  if (key === 'experiment') return r.exp ?? '–';
  if (key.startsWith('v:')) return r.variants[key.slice(2)] ?? '–';
  return String(r[key as keyof RunRecord] ?? '') || '–';
}

void main();
