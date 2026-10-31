// The Playtests page (phase 2 M6a): experiment cards that compare a few setups on one question,
// and every run recorded in this browser (plus imported ones) in a list with Robbery, Boarding and
// All views. Rule: a milestone adds its numbers to a view and to the expanded run, never as a new
// column in every view.
import { EXPERIMENT_NUMBERS, overridesFromSet, setParams, setupSelection, type Experiment, type ExperimentBase, type ExperimentNumber, type ExperimentSetup } from '@train-robber/config';
import { download, listRuns, listSessions, openDb, readLog } from './logSink';
import pkg from '../package.json';
import {
  compareVersions, duration, experimentIssue, experimentNumber, issueMarkdown, money, notesIssue, notesMarkdown, NUMBER_LABELS, outcomeWords,
  runVersion, sessionPull, setupKey, setupRuns, toCsv, type ExperimentReport,
} from './playtestStats';
import type { RunRecord } from './runTracker';
import { getTester, setTester } from './tester';
import {
  ANSWER_FIELDS, loadStatus, saveStatus, classifyIncoming, decodeExperiment, emptyAnswers, loadAnswers, loadBases, loadOwn, mergeIncoming, newExperimentId, parseExperiment,
  linkedPr, loadDeleted, loadExcluded, playQuery, saveDeleted, undelete, saveExcluded, saveAnswers, saveBases, saveOwn, shareQuery, type Answers,
} from './experiments';
import { diffLabel, diffReadable, mapChoices, settingDoc, settingName, type VariantGroupInfo, presetIds, repoExperiments, selectionError, settablePaths, settingChoices, settingHint, variantInfo } from './setup';

const REPO = 'https://github.com/devlinjunker/train-robber';
const REPO_ISSUES = `${REPO}/issues/new`;
const prUrl = (n: number) => `${REPO}/pull/${n}`;
const PR_KEY = 'train-robber-linked-pr';
const ALL = '';
const VIEW_KEY = 'train-robber-playtests-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/** An experiment as the page shows it: where it came from and the base its Play links use. */
interface Shown { exp: Experiment; repo: boolean; base: ExperimentBase | undefined; baseChanged: boolean; done: boolean }

// ---------- Run list views ----------

interface Column { head: string; num?: boolean; cell: (r: RunRecord) => string }
type View = 'robbery' | 'boarding' | 'all';
const VIEWS: Record<View, { name: string; help: string }> = {
  robbery: { name: 'Robbery', help: 'How each robbery went: what you carried off (and lost), what you left on the train, your wanted level and bank. Click a save to see only its runs; time left and heat are in the totals and the expanded run.' },
  boarding: { name: 'Boarding', help: 'The Phase 1 numbers: jumps, how far each run got, time from commit to aboard, damage.' },
  all: { name: 'All', help: 'Who played what, on which build and map. Click a run for every number it recorded.' },
};

/** The totals strip above the run list: the visible runs summed up for the view's own numbers. */
function viewStats(view: View, rs: readonly RunRecord[]): [string, string][] {
  const n = (k: ExperimentNumber) => experimentNumber(k, rs);
  const count = (f: (r: RunRecord) => string) => String(new Set(rs.map(f)).size);
  const head: [string, string][] = [['Runs', String(rs.length)]];
  if (view === 'robbery') {
    // The bank as the newest saved run left it (runs are newest first).
    const bank = rs.find((r) => r.bankAfter !== undefined && !r.practice)?.bankAfter;
    return [...head, ['Ended', n('outcomes')], ['Avg length', n('length')], ['Avg carried', n('lootCarried')], ['Avg banked', n('banked')], ['Avg left on train', n('lootLeft')], ['Avg lost', n('lootLost')], ['Avg time left', n('timeLeft')], ['Avg heat', n('heat')], ['Wanted (start → after)', n('wanted')], ['Bank now', money(bank)]];
  }
  if (view === 'boarding') return [...head, ['Got aboard', n('aboard')], ['Jumps (P / G / F)', n('jumps')], ['Median to board', n('toBoard')], ['Avg damage', n('damage')], ['Ended', n('outcomes')]];
  const pull = sessionPull(rs);
  return [...head, ['Testers', count((r) => r.tester || '?')], ['Sessions', String(pull.sessions)], ['Versions', count(runVersion)], ['Maps', count((r) => r.mapId)], ['Notes', String(rs.reduce((k, r) => k + r.notes.length, 0))]];
}

/** How a setup is told in lists: its difference from the default. */
function selectionLabel(base: ExperimentBase | undefined, setup: ExperimentSetup): string {
  const sel = setupSelection(base, setup);
  return diffLabel({ preset: sel.preset, variants: sel.variants, overrides: overridesFromSet(setParams(sel.set)), ...(sel.map ? { map: sel.map } : {}) });
}
/** A setup's difference as lines for its card header, variants in words with their help on hover. */
/** A `?set=` row's explanation: the setting in words, then its doc comment from the schema. */
function setDoc(path: string): string {
  if (!path) return '';
  const doc = settingDoc(path);
  return `<b>${esc(settingName(path))}</b>${doc ? ` · ${esc(doc)}` : ''}`;
}
/** The help line under a variant pick: what the chosen option does, or where an unpicked one comes from. */
function variantHelp(g: VariantGroupInfo, id: string | undefined, inherit: string): string {
  const o = id ? g.options.find((x) => x.id === id) : undefined;
  if (o) return o.help || o.label;
  return inherit === '(base)' ? `Uses the base's choice. ${g.question}` : `Uses the preset's choice. ${g.question}`;
}
function selectionHtml(base: ExperimentBase | undefined, setup: ExperimentSetup): string {
  const sel = setupSelection(base, setup);
  return diffReadable({ preset: sel.preset, variants: sel.variants, overrides: overridesFromSet(setParams(sel.set)), ...(sel.map ? { map: sel.map } : {}) })
    .map((p) => `<div${p.help ? ` title="${esc(p.help)}"` : ''}>${esc(p.text)}</div>`).join('');
}
const baseLabel = (base: ExperimentBase | undefined) => selectionLabel(base, { id: 'base', name: 'base' });

async function main() {
  const db = await openDb();
  let runs: RunRecord[] = [];
  let stored = new Set<string>();
  const filters = new Map<string, string>();
  let moreOpen = false;
  let own = loadOwn();
  let bases = loadBases();
  const answers = loadAnswers();
  let status = loadStatus();
  let view: View = 'robbery';
  try { const v = localStorage.getItem(VIEW_KEY); if (v && v in VIEWS) view = v as View; } catch { /* default view */ }
  const expanded = new Set<string>();
  // The PR a link from GitHub opened the page for (`?pr=N`): every card can send its results there,
  // and Play links pass it on so the runs are tagged with it. Kept until Unlink.
  let pr = linkedPr(new URLSearchParams(location.search).get('pr'));
  try { if (pr) localStorage.setItem(PR_KEY, String(pr)); else pr = linkedPr(localStorage.getItem(PR_KEY)); } catch { /* this page only */ }
  const cardPr = (s: Shown) => pr ?? s.exp.pr;
  // `?exp=<id>` focuses the page on one experiment: only its card, and only its runs, until Show all.
  let focus: string | undefined;
  function renderPr() {
    const box = $('prLink');
    box.hidden = !pr;
    box.innerHTML = pr ? `Linked to <a href="${prUrl(pr)}" target="_blank" rel="noopener">PR #${pr} ↗</a> <button id="prUnlink" title="Stop sending results to this PR">Unlink</button>` : '';
    $('github').textContent = pr ? `Send to GitHub (issue for PR #${pr})` : 'Send to GitHub';
  }
  $('prLink').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id !== 'prUnlink') return;
    pr = undefined;
    try { localStorage.removeItem(PR_KEY); } catch { /* this page only */ }
    const q = new URLSearchParams(location.search); q.delete('pr');
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`);
    renderPr(); renderExperiments();
  });
  /** A new `playtest` issue in a new tab; with a PR, the title names it and the body links it, so the PR shows the issue. */
  function openIssue(title: string, body: string, prN?: number) {
    const t = prN ? `${title} (PR #${prN})` : title;
    const b = prN ? `For #${prN}.\n\n${body}` : body;
    window.open(`${REPO_ISSUES}?${new URLSearchParams({ title: t, body: b, labels: 'playtest' })}`, '_blank', 'noopener');
  }
  // Runs left out of the results (quick tests): kept, but hidden from cards, totals and the list unless shown.
  const excluded = loadExcluded();
  let showExcluded = false;
  const repoIds = new Set(repoExperiments.map((e) => e.id));

  $('build').textContent = pkg.version;
  const sha = String(import.meta.env.VITE_BUILD_SHA ?? '');
  if (/^[0-9a-f]{7,40}$/.test(sha)) {
    $('buildSha').innerHTML = ` from commit <a href="https://github.com/devlinjunker/train-robber/commit/${sha}" target="_blank" rel="noopener" title="The commit this page was built from"><code>${sha.slice(0, 7)}</code></a>`;
  }
  const tester = $<HTMLInputElement>('tester');
  tester.value = getTester();
  tester.addEventListener('change', () => setTester(tester.value.trim()));

  const shown = (): Shown[] => [
    ...repoExperiments.map((exp) => ({ exp, repo: true, base: bases[exp.id] ?? exp.base, baseChanged: exp.id in bases })),
    ...own.map((exp) => ({ exp, repo: false, base: exp.base, baseChanged: false })),
  ].map((x) => ({ ...x, done: (status[x.exp.id] ?? x.exp.status ?? 'open') === 'done' }));
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

  const visible = () => runs.filter((r) => (showExcluded || !excluded.has(r.id)) && [...filters].every(([k, v]) => v === ALL || filterValue(r, k) === v));

  /** Save an experiment someone shared (link or file), asking on an id clash. Returns the id it is saved under. */
  function receive(incoming: Experiment): string {
    const kind = classifyIncoming(incoming, own, repoIds);
    const replace = kind === 'conflict' && confirm(`You already have an experiment with the id "${incoming.id}" but different contents.\n\nOK: replace yours with the shared "${incoming.title}".\nCancel: keep both (the shared one is saved as a copy).`);
    const r = mergeIncoming(incoming, own, repoIds, replace);
    if (r.kind === 'new' || r.kind === 'conflict') { own = r.own; saveOwn(own); }
    undelete(incoming.id); undelete(r.id);
    return r.id;
  }

  /** Runs carry a copy of a tester's own experiment: add any you don't have, so their runs get a card. */
  function adoptFromRuns() {
    const known = new Set([...repoIds, ...own.map((e) => e.id), ...loadDeleted()]);
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
    const keys = ['version', 'tester', 'outcome', 'experiment', 'mapId', 'pr', 'practice', 'saveId', ...new Set(runs.flatMap((r) => Object.keys(r.variants).map((g) => `v:${g}`)))];
    const box = $('filters');
    box.innerHTML = '';
    // Variant groups go in a More filters menu, so the row stays short however many groups there are.
    const more = document.createElement('details');
    more.className = 'menu more';
    const moreBox = document.createElement('div');
    for (const k of keys) {
      const values = [...new Set(runs.map((r) => filterValue(r, k)))].sort(k === 'version' ? compareVersions : undefined);
      // Version is always offered, so notes can be exported for one version; other filters only when they would split the runs.
      if (k !== 'version' && values.length < 2 && !filters.get(k)) continue;
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">all</option>` + values.map((v) => `<option value="${esc(v)}"${filters.get(k) === v ? ' selected' : ''}>${esc(k === 'experiment' ? findShown(v)?.exp.title ?? v : k === 'saveId' && v !== '–' ? v.slice(0, 6) : v)}</option>`).join('');
      sel.addEventListener('change', () => { filters.set(k, sel.value); if (k.startsWith('v:')) renderFilters(); renderExperiments(); renderRuns(); });
      const label = document.createElement('label');
      label.append(k.startsWith('v:') ? k.slice(2) : k === 'mapId' ? 'map' : k === 'saveId' ? 'save' : k === 'pr' ? 'PR' : k, sel);
      (k.startsWith('v:') ? moreBox : box).append(label);
    }
    if (moreBox.children.length) {
      const active = [...filters].filter(([k, v]) => k.startsWith('v:') && v !== ALL).length;
      more.innerHTML = `<summary>Variants${active ? ` (${active} set)` : ''} ▾</summary>`;
      more.open = moreOpen;
      more.addEventListener('toggle', () => { moreOpen = more.open; });
      more.append(moreBox);
      box.append(more);
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
    const target = cardPr(s);
    const href = (setupId: string) => `./${playQuery(exp, setupId, s.base, !s.repo, pr)}`;
    const base = s.base && Object.keys(s.base).length ? baseLabel(s.base) : 'default';
    return `<article class="card" id="exp-${esc(exp.id)}" data-exp="${esc(exp.id)}">
      <div class="card-head">
        <div><h3>${esc(exp.title)}<span class="tag">${s.repo ? 'repo' : 'yours'}</span>${exp.pr ? `<a class="tag" href="${prUrl(exp.pr)}" target="_blank" rel="noopener" title="The pull request this question came from">PR #${exp.pr} ↗</a>` : ''}</h3></div>
        <div class="actions">
          <button data-act="share" title="Copy a link that opens this experiment on anyone's Playtests page${s.repo ? '' : ' and saves it there'}">Share link</button>
          <button data-act="dup" title="Make your own editable copy">Duplicate</button>
          <button data-act="file" title="Copy the experiment as a packages/content/playtests/*.json file${s.done ? ', marked done with its conclusion' : ''}">Copy as file</button>
          <button data-act="gh" title="Open a GitHub issue with this experiment's results, your answers and its run notes${target ? `, linked to PR #${target}` : ''}">Send to GitHub${target ? ` (PR #${target})` : ''}</button>
          ${s.repo ? '<button data-act="base" title="Change the base setup every setup builds on, in this browser only">Edit base</button>' : '<button data-act="edit">Edit</button><button data-act="del">Delete</button>'}
          ${s.done ? '<button data-act="reopen" title="Move it back to the open experiments">Reopen</button>' : '<button data-act="done" title="Answered: move it to Finished experiments (in this browser)">Mark done</button>'}
        </div>
      </div>
      <div class="question">${esc(exp.question)}</div>
      ${s.done ? `<div class="conclusion"><b>Done.</b> ${esc(exp.conclusion || answers[exp.id]?.answer || 'No conclusion written.')}</div>` : ''}
      <div class="base muted">Base: ${esc(base)}${s.baseChanged ? ' <b>(changed in this browser)</b> <button data-act="resetbase">Reset</button>' : ''}</div>
      ${s.done ? '<details class="results"><summary>Results and answers</summary>' : ''}
      <div class="scroll"><table class="cmp">
        <tr><th></th>${exp.setups.map((setup) => `<th>${esc(setup.name)}<div class="diff">${selectionHtml(s.base, setup)}</div><a class="play" href="${esc(href(setup.id))}" target="_blank" title="Play this setup; its runs are tagged for this card">Play ▸</a></th>`).join('')}</tr>
        <tr><td>Runs</td>${cells((c) => `${c.length}${c.length ? ` <span class="muted">(${new Set(c.map((r) => r.tester || '?')).size} tester${new Set(c.map((r) => r.tester || '?')).size === 1 ? '' : 's'})</span>` : ''}`)}</tr>
        ${exp.numbers.map((n) => `<tr><td title="${esc(EXPERIMENT_NUMBERS[n])}">${esc(NUMBER_LABELS[n])}</td>${cells((c) => esc(experimentNumber(n, c)))}</tr>`).join('')}
        <tr><td title="The outcome of the last run in each session (a page load); closed means the tab closed mid-run">Sessions ended by</td>${cells((c) => esc(outcomeWords(sessionPull(c).endedBy)))}</tr>
        <tr><td>Notes</td>${cells(notes)}</tr>
      </table></div>
      <div class="answers">
        <label>Your answer to the question<textarea data-ans="answer" rows="2">${esc(ans.answer)}</textarea></label>
        ${ANSWER_FIELDS.map((f) => `<label>${esc(f.label)}<textarea data-ans="${f.key}" rows="1">${esc(ans[f.key])}</textarea></label>`).join('')}
      </div>
      ${s.done ? '</details>' : ''}
    </article>`;
  }

  function renderExperiments() {
    const rs = visible();
    const focused = focus ? findShown(focus) : undefined;
    if (focused) {
      $('experiments').innerHTML = `<div class="focus muted">Showing one experiment and its runs. <button id="showAll">Show all experiments</button></div>${card(focused, rs)}`;
      $('experiments').querySelectorAll<HTMLDetailsElement>('details.results').forEach((d) => { d.open = true; });
      $('finished').hidden = true;
      return;
    }
    const list = shown();
    const open = list.filter((s) => !s.done), done = list.filter((s) => s.done);
    $('experiments').innerHTML = open.length ? open.map((s) => card(s, rs)).join('') : '<div class="empty">No open experiments. Press New experiment to compare a few setups.</div>';
    const fin = $<HTMLDetailsElement>('finished');
    fin.hidden = done.length === 0;
    $('finishedCount').textContent = String(done.length);
    $('finishedCards').innerHTML = done.map((s) => card(s, rs)).join('');
  }

  async function copyText(btn: HTMLButtonElement, text: string, fallback: () => void) {
    const label = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { fallback(); }
    setTimeout(() => { btn.textContent = label; }, 1500);
  }

  const onCardClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    const id = btn?.closest<HTMLElement>('[data-exp]')?.dataset.exp;
    const s = findShown(id);
    if (!btn || !s) return;
    const { exp } = s;
    switch (btn.dataset.act) {
      case 'share': {
        const url = `${location.origin}${location.pathname}${shareQuery(exp, s.repo)}${pr ? `&pr=${pr}` : ''}`;
        void copyText(btn, url, () => prompt('Copy this link:', url));
        break;
      }
      case 'file': {
        const text = JSON.stringify(fileFor(s), null, 2) + '\n';
        void copyText(btn, text, () => download(`${exp.id}.json`, text, 'application/json'));
        break;
      }
      case 'gh':
        sendExperiment(s, false);
        break;
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
        if (confirm(`Delete the experiment "${exp.title}"? Its runs stay in the run list.`)) {
          own = own.filter((o) => o.id !== exp.id); saveOwn(own);
          const gone = loadDeleted(); gone.add(exp.id); saveDeleted(gone);
          render();
        }
        break;
      case 'reopen':
        setStatus(exp, 'open'); flash(exp.id);
        break;
      case 'done':
        askDone(s);
        break;
    }
  };
  function setStatus(exp: Experiment, want: 'open' | 'done'): void {
    status = { ...status, [exp.id]: want };
    if (want === (exp.status ?? 'open')) delete status[exp.id];
    saveStatus(status); renderExperiments();
  }
  /** Mark done asks first: done everywhere (a GitHub issue with the file to commit), done in this browser only, or cancel (nothing changes). */
  function askDone(s: Shown): void {
    const dlg = $('doneDialog') as HTMLDialogElement;
    dlg.innerHTML = `<form method="dialog">
      <h3>Mark "${esc(s.exp.title)}" done?</h3>
      <p class="mini">It moves to Finished experiments. Add to GitHub opens an issue with its results, your answers and the file to commit (<code>"status": "done"</code> with your answer as the conclusion), so it is finished for everyone once that file is merged.</p>
      <div class="row done-actions">
        <button value="github" class="primary">Add to GitHub${cardPr(s) ? ` (PR #${cardPr(s)})` : ''}</button>
        <button value="local">Only this browser</button>
        <button value="cancel">Cancel</button>
      </div></form>`;
    dlg.returnValue = '';
    dlg.onclose = () => {
      const pick = dlg.returnValue;
      if (pick !== 'github' && pick !== 'local') return;
      setStatus(s.exp, 'done');
      if (pick === 'github') sendExperiment({ ...s, done: true }, true);
    };
    dlg.showModal();
  }
  /** The experiment as a repo file: the base you play it with, and once done, `status: done` with the conclusion (your answer if it has none). */
  function fileFor(s: Shown): Experiment {
    const out: Experiment = structuredClone(s.exp);
    if (s.base && Object.keys(s.base).length) out.base = structuredClone(s.base); else delete out.base;
    if (s.done) {
      out.status = 'done';
      const conclusion = (s.exp.conclusion || answers[s.exp.id]?.answer || '').trim().slice(0, 400);
      if (conclusion) out.conclusion = conclusion;
    }
    return out;
  }
  function report(s: Shown): ExperimentReport {
    return {
      exp: s.exp, labels: s.exp.setups.map((setup) => selectionLabel(s.base, setup)),
      ...(s.base && Object.keys(s.base).length ? { baseLabel: baseLabel(s.base) } : {}),
      answers: answers[s.exp.id] ?? emptyAnswers(),
    };
  }
  function sendExperiment(s: Shown, finishing: boolean) {
    const { title, body } = experimentIssue(report(s), visible(), getTester(), finishing ? fileFor(s) : undefined);
    openIssue(title, body, cardPr(s));
  }
  const onCardInput = (e: Event) => {
    const ta = e.target as HTMLTextAreaElement;
    const key = ta.dataset.ans as keyof Answers | undefined;
    const id = ta.closest<HTMLElement>('[data-exp]')?.dataset.exp;
    if (!key || !id) return;
    answers[id] = { ...(answers[id] ?? emptyAnswers()), [key]: ta.value };
    saveAnswers(answers);
  };
  for (const box of ['experiments', 'finishedCards']) { $(box).addEventListener('click', onCardClick); $(box).addEventListener('input', onCardInput); }
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
    // Time left and heat are in the totals strip and the expanded run; the save sits under When.
    robbery: [
      { head: 'When', cell: (r) => `${esc(when(r.startedAt))}${saveCell(r)}` },
      { head: 'Setup', cell: (r) => esc(runSetup(r)) },
      { head: 'Outcome', cell: (r) => `<span class="${r.outcome}">${r.outcome}</span>${resumedCell(r)}` },
      { head: 'Length', num: true, cell: (r) => duration(r.durationSec) },
      { head: 'Carried', num: true, cell: (r) => `${loot(r.lootValue, r.lootItems)}${r.lootLost ? `<div class="muted">lost ${money(r.lootLost)}</div>` : ''}` },
      { head: 'Left on train', num: true, cell: (r) => loot(r.lootLeftValue, r.lootLeftItems) },
      { head: 'Wanted', num: true, cell: (r) => wantedCell(r) },
      { head: 'Bank', num: true, cell: (r) => (r.bankAfter === undefined || r.practice ? '–' : money(r.bankAfter)) },
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
      ['Carried at end', loot(r.lootValue, r.lootItems)], ['Banked', money(r.cashOut)], ['Left on train', loot(r.lootLeftValue, r.lootLeftItems)], ['Lost on the way', money(r.lootLost)],
      ['Wanted', r.wantedLevel === undefined ? '–' : r.practice ? `${r.wantedLevel} (practice: nothing saved)` : `${r.wantedLevel} at start, ${r.wantedAfter ?? '–'} after`],
      ['Bank after', r.practice ? '– (practice)' : money(r.bankAfter)], ['Lifetime earned after', r.practice ? '– (practice)' : money(r.lifetimeAfter)],
      ['Save', r.saveId ? `${r.saveId}${r.day !== undefined ? `, day ${r.day}` : ''}` : '–'], ['Resumes', r.resumedFrom ?? '–'],
      ['Time left', duration(r.countdownLeftSec)], ['Heat at end', String(r.heatAtEnd ?? '–')],
      ['Jumps (perfect / good / fail)', `${r.boardingAttempts} (${r.boarding.perfect} / ${r.boarding.good} / ${r.boarding.fail})`], ['Furthest', r.furthestPhase],
      ['Commit to aboard', duration(r.commitToAboardSec)], ['Damage taken', String(r.damageTaken)],
      ['Whistles', String(r.whistles ?? '–')], ['Mount jumps', String(r.mountAttempts ?? '–')],
      ['Spotted by guards', String(r.spotted ?? '–')], ['Thrown off by guards', String(r.thrownOff ?? '–')],
      ['Refused commands', Object.entries(r.rejections ?? {}).map(([k, n]) => `${k} ×${n}`).join(', ') || '–'],
    ];
    const notes = r.notes.length
      ? `<div class="notes">${r.notes.map((n, i) => `<div>tick ${n.t}: ${esc(n.text)} <button class="mini" data-note-issue="${i}" title="Open a GitHub issue for this note">Issue ↗</button></div>`).join('')}</div>`
      : '<div class="notes muted">No notes (press N in game).</div>';
    const logs = stored.has(r.session)
      ? `<a href="${esc(watchUrl(r))}" target="_blank">Watch</a> <button data-logs="${esc(r.session)}">Download .log files</button>`
      : '<span class="muted">Logs pruned (only the newest 20 sessions keep them).</span>';
    return `<tr class="detail"><td colspan="${span}" data-for="${esc(r.id)}"><dl>${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${notes}
      <div class="bar">${logs} <a href="./${esc(r.url || '')}" target="_blank">Play this setup again</a>
        ${r.notes.length > 1 ? '<button data-run-notes-issue>Issue for this run\'s notes ↗</button>' : ''}
        <button data-exclude title="${excluded.has(r.id) ? 'Count this run in the cards, totals and list again' : 'Leave this run out of the cards, totals and list (e.g. a quick test); Show excluded brings it back'}">${excluded.has(r.id) ? 'Include in results' : 'Exclude from results'}</button></div></td></tr>`;
  }

  function renderRuns() {
    $('views').innerHTML = (Object.keys(VIEWS) as View[]).map((v) => `<button data-view="${v}" aria-pressed="${v === view}">${VIEWS[v].name}</button>`).join('');
    $('viewHelp').textContent = VIEWS[view].help;
    const nEx = runs.filter((r) => excluded.has(r.id)).length;
    $('excludedToggle').hidden = nEx === 0;
    $('excludedToggle').innerHTML = `<label><input type="checkbox" id="showExcluded"${showExcluded ? ' checked' : ''} /> Show ${nEx} excluded run${nEx === 1 ? '' : 's'}</label>`;
    const rs = visible();
    $('runStats').innerHTML = rs.length ? viewStats(view, rs).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') : '';
    const cols = COLS[view];
    $('runs').innerHTML = rs.length === 0
      ? `<tr><td class="empty">${runs.length ? 'No runs match the filters.' : 'No runs yet. Press Play on an experiment setup, or open the game and commit to a train with E; each run shows up here when it ends.'}</td></tr>`
      : `<tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.head}</th>`).join('')}</tr>` +
        rs.map((r) => `<tr class="run${expanded.has(r.id) ? ' open' : ''}${excluded.has(r.id) ? ' excluded' : ''}" data-run="${esc(r.id)}" title="Click for details">${cols.map((c) => `<td class="${c.num ? 'num' : c.head === 'Setup' ? 'setup' : ''}">${c.cell(r)}</td>`).join('')}</tr>${expanded.has(r.id) ? detail(r, cols.length) : ''}`).join('');
  }

  $('excludedToggle').addEventListener('change', (e) => {
    showExcluded = (e.target as HTMLInputElement).checked;
    renderExperiments(); renderRuns();
  });
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
    if (el.dataset.save) { e.preventDefault(); filters.set('saveId', filters.get('saveId') === el.dataset.save ? ALL : el.dataset.save); renderFilters(); renderExperiments(); renderRuns(); return; }
    if (el.dataset.goto) {
      e.preventDefault();
      expanded.add(el.dataset.goto);
      renderRuns();
      const target = document.querySelector<HTMLElement>(`tr.run[data-run="${CSS.escape(el.dataset.goto)}"]`);
      target?.scrollIntoView({ block: 'center' });
      target?.classList.add('flash');
      setTimeout(() => target?.classList.remove('flash'), 1200);
      return;
    }
    const runId = el.closest<HTMLElement>('[data-for]')?.dataset.for;
    const rec = runId ? runs.find((r) => r.id === runId) : undefined;
    if (rec && el.dataset.noteIssue !== undefined) {
      const { title, body } = notesIssue([rec], getTester(), Number(el.dataset.noteIssue));
      openIssue(title, body, pr ?? findShown(rec.exp)?.exp.pr);
      return;
    }
    if (rec && el.matches('[data-run-notes-issue]')) {
      const { title, body } = notesIssue([rec], getTester());
      openIssue(title, body, pr ?? findShown(rec.exp)?.exp.pr);
      return;
    }
    if (rec && el.matches('[data-exclude]')) {
      if (excluded.has(rec.id)) excluded.delete(rec.id); else excluded.add(rec.id);
      saveExcluded(excluded);
      renderExperiments(); renderRuns();
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
  $('notesIssue').addEventListener('click', () => {
    const rs = visible().filter((r) => r.notes.length);
    if (!rs.length) { alert('None of the runs shown have notes.'); return; }
    const { title, body } = notesIssue(rs, getTester());
    openIssue(title, body, pr);
  });
  $('notesDownload').addEventListener('click', () => download(notesName(), notes(), 'text/markdown'));
  $('csv').addEventListener('click', () => download(`playtests-${stamp()}.csv`, toCsv(visible()), 'text/csv'));
  $('json').addEventListener('click', () => download(`playtests-${stamp()}.json`, JSON.stringify(visible().map((r) => (excluded.has(r.id) ? { ...r, excluded: true } : r)), null, 1), 'application/json'));
  $('github').addEventListener('click', () => {
    const rs = visible();
    const reps = reports(rs);
    if (rs.length === 0 && reps.length === 0) return;
    const who = getTester() || 'a tester';
    openIssue(`Playtest: ${rs.length} runs from ${who}`, issueMarkdown(rs, 6000, reps), pr);
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
    for (const r of incoming) {
      if (r.excluded) excluded.add(r.id);
      const rec = { ...r };
      delete rec.excluded;
      tx.objectStore('runs').put(rec);
    }
    saveExcluded(excluded);
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
    const presets = presetIds(), groups = variantInfo(), maps = mapChoices();
    const opts = (values: string[], current: string | undefined, inherit: string) =>
      `<option value="">${esc(inherit)}</option>` + values.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
    // Each value row says what its path takes (and the game.json default), and suggests the choices.
    let rows = 0;
    const setRow = (path = '', value: unknown = '') => {
      const list = `setChoices${rows++}`;
      return `<div class="row setrow"><input list="setPaths" placeholder="countdown.scale" value="${esc(path)}" data-path /><input placeholder="value" list="${list}" value="${esc(typeof value === 'string' ? value : JSON.stringify(value))}" /><button type="button" data-del-set title="Remove">×</button>
        <datalist id="${list}">${settingChoices(path).map((c) => `<option value="${esc(c)}">`).join('')}</datalist><span class="muted hint" data-hint>${esc(settingHint(path))}</span>
        <div class="setdoc" data-doc>${setDoc(path)}</div></div>`;
    };
    const selection = (sel: ExperimentBase, inherit: string) => {
      const changed = Object.keys(sel.variants ?? {}).length;
      return `<div class="row">
          <label>Preset<select data-f="preset">${opts(presets, sel.preset, inherit)}</select></label>
          <label>Map<select data-f="map">${opts(maps, sel.map, inherit === '(base)' ? '(base)' : 'default (alpha-flats)')}</select></label>
        </div>
        <details${changed ? ' open' : ''}><summary class="muted">Variants${changed ? ` (${changed} picked)` : ''}</summary><div class="vars">${groups.map((g) =>
          `<label title="${esc(g.question)}">${esc(g.name)}<select data-var="${esc(g.group)}"><option value="">${inherit === '(base)' ? '(base)' : "(preset's)"}</option>${g.options.map((o) => `<option value="${esc(o.id)}" title="${esc(o.help)}"${o.id === sel.variants?.[g.group] ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select><span class="vhelp" data-vhelp>${esc(variantHelp(g, sel.variants?.[g.group], inherit))}</span></label>`).join('')}</div></details>
        <div class="muted">?set= values</div><div data-sets>${Object.entries(sel.set ?? {}).map(([p, v]) => setRow(p, v)).join('')}</div>
        <button type="button" data-add-set>Add a value</button>`;
    };
    const setupBlock = (s: ExperimentSetup, i: number) => `<fieldset data-setup="${esc(s.id)}"><legend>Setup ${i + 1}</legend>
        ${mode === 'full' ? '<div class="setup-actions"><button type="button" data-dup-setup title="Add a copy of this setup to change">Duplicate</button><button type="button" data-del-setup title="Remove this setup">Remove</button></div>' : ''}
        <div class="row"><label>Name<input data-f="name" value="${esc(s.name)}" maxlength="40" /></label></div>
        ${selection(s, '(base)')}</fieldset>`;
    const full = mode === 'full';
    dlg.innerHTML = `<form method="dialog">
      <h3>${full ? 'Experiment' : `Base setup for "${esc(draft.title)}"`}</h3>
      ${full ? `<div class="row"><label style="flex:1">Title<input class="wide" data-f="title" value="${esc(draft.title)}" maxlength="80" placeholder="Town spacing" /></label></div>
      <div class="row"><label style="flex:1">Question<textarea class="wide" data-f="question" rows="2" maxlength="400" placeholder="Which town spacing makes a robbery tense without dragging?">${esc(draft.question)}</textarea></label></div>
      <div class="row"><label>From PR (optional)<input data-f="pr" type="number" min="1" step="1" style="width:90px" value="${draft.pr ?? ''}" placeholder="#" title="The pull request the question came from: the card links to it and Send to PR posts results there" /></label></div>`
        : '<div class="muted">Every setup builds on the base. This change stays in this browser; Reset on the card puts the repo base back.</div>'}
      <fieldset data-base><legend>Base (shared by every setup)</legend>${selection(draft.base ?? {}, 'default')}</fieldset>
      ${full ? `<div data-setups>${draft.setups.map(setupBlock).join('')}</div><button type="button" data-add-setup>Add setup</button>
      <fieldset><legend>Numbers to compare (up to 6)</legend><div class="numbers">${(Object.keys(EXPERIMENT_NUMBERS) as ExperimentNumber[]).map((n) =>
        `<label><input type="checkbox" data-num="${n}"${draft.numbers.includes(n) ? ' checked' : ''} /> ${esc(EXPERIMENT_NUMBERS[n])}</label>`).join('')}</div></fieldset>` : ''}
      <datalist id="setPaths">${settablePaths().map((p) => `<option value="${esc(p)}" label="${esc(`${settingName(p)}${settingDoc(p) ? ` · ${settingDoc(p).slice(0, 90)}` : ''}`)}">`).join('')}</datalist>
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
      else if (t.matches('[data-add-setup], [data-dup-setup]')) {
        const box = dlg.querySelector('[data-setups]')!;
        const taken = new Set(Array.from(box.querySelectorAll<HTMLElement>('[data-setup]')).map((f) => f.dataset.setup!));
        let id = 'a';
        for (let i = 0; taken.has(id); i++) id = String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
        const from = t.matches('[data-dup-setup]') ? t.closest<HTMLElement>('[data-setup]') : null;
        const copy: ExperimentSetup = from ? { ...readSelection(from), id, name: `${from.querySelector<HTMLInputElement>('[data-f="name"]')!.value.trim() || 'Setup'} copy`.slice(0, 40) } : { id, name: '' };
        if (from) from.insertAdjacentHTML('afterend', setupBlock(copy, box.children.length)); else box.insertAdjacentHTML('beforeend', setupBlock(copy, box.children.length));
        box.querySelectorAll('legend').forEach((l, i) => { if (l.closest('[data-setup]')) l.textContent = `Setup ${i + 1}`; });
      } else if (t.matches('[data-cancel]')) dlg.close();
      else if (t.matches('[data-save]')) {
        const err = dlg.querySelector<HTMLElement>('[data-error]')!;
        const v = (name: string) => dlg.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-f="${name}"]`)?.value.trim() ?? '';
        const base = readSelection(dlg.querySelector('[data-base]')!);
        const next: Experiment = full ? {
          schemaVersion: 1, id: draft.id, title: v('title'), question: v('question'), ...(v('pr') ? { pr: Number(v('pr')) } : {}),
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
    dlg.onchange = (e) => {
      const t = e.target as HTMLSelectElement;
      if (!t.matches('[data-var]')) return;
      const g = groups.find((x) => x.group === t.dataset.var)!;
      const inherit = t.closest('[data-base]') ? 'default' : '(base)';
      t.parentElement!.querySelector('[data-vhelp]')!.textContent = variantHelp(g, t.value || undefined, inherit);
    };
    dlg.oninput = (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.matches('[data-path]')) return;
      const row = t.closest('.setrow')!;
      row.querySelector('[data-hint]')!.textContent = settingHint(t.value.trim());
      row.querySelector('[data-doc]')!.innerHTML = setDoc(t.value.trim());
      row.querySelector('datalist')!.innerHTML = settingChoices(t.value.trim()).map((c) => `<option value="${esc(c)}">`).join('');
    };
    dlg.showModal();
  }

  // ---------- Links that open this page ----------

  function flash(id: string) {
    requestAnimationFrame(() => {
      const el = document.getElementById(`exp-${id}`);
      if (!el) return;
      const fin = el.closest('details');
      if (fin) fin.open = true;
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

  addEventListener('focus', () => { own = loadOwn(); bases = loadBases(); status = loadStatus(); void load(); });
  renderPr();
  if (target) { focus = target; filters.set('experiment', target); }
  $('experiments').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id !== 'showAll') return;
    focus = undefined;
    filters.set('experiment', ALL);
    const u = new URLSearchParams(location.search); u.delete('exp');
    history.replaceState(null, '', `${location.pathname}${u.toString() ? `?${u}` : ''}${location.hash}`);
    renderFilters(); renderExperiments(); renderRuns();
  });
  await load();
  if (target) {
    if (findShown(target)) flash(target);
    else alert(`This page has no experiment "${target}". It may come from a newer build.`);
  }
}

/** A run picked up after an in-place cancel links to the run it continued. */
function resumedCell(r: RunRecord): string {
  if (!r.resumedFrom) return '';
  const n = r.resumedFrom.split('#').pop();
  return `<div class="muted"><a href="#" data-goto="${esc(r.resumedFrom)}">resumes run ${esc(n)}</a></div>`;
}

/** The save a run was played on (first 6 characters; click to show only that save's runs) and its day. */
function saveCell(r: RunRecord): string {
  if (!r.saveId) return '';
  return `<div class="muted"><a href="#" data-save="${esc(r.saveId)}" title="Show only the runs on this save">save ${esc(r.saveId.slice(0, 6))}</a>${r.day !== undefined ? ` · day ${r.day}` : ''}</div>`;
}

/** The run's wanted level and what the outcome did to it: `1 → 2`, `3 practice`, or – before M5. */
function wantedCell(r: RunRecord): string {
  if (r.wantedLevel === undefined) return '–';
  if (r.practice) return `${r.wantedLevel} <span class="muted">practice</span>`;
  return r.wantedAfter === undefined || r.wantedAfter === r.wantedLevel ? String(r.wantedLevel) : `${r.wantedLevel} → ${r.wantedAfter}`;
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
  if (key === 'practice') return r.practice ? 'practice' : r.wantedLevel === undefined ? '–' : 'saved';
  return String(r[key as keyof RunRecord] ?? '') || '–';
}

void main();
