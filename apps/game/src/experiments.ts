// Playtest experiments on this browser (phase 2 M6a): your own ones and the answers you wrote,
// kept in localStorage; Share links and Play links that carry an experiment; and how an incoming
// experiment is merged into your own. Repo experiments come from setup.ts and are read-only.
import { ExperimentBaseSchema, ExperimentSchema, setParams, setupSelection, type Experiment, type ExperimentBase } from '@train-robber/config';

const OWN_KEY = 'train-robber-experiments';
const BASES_KEY = 'train-robber-experiment-bases';
const ANSWERS_KEY = 'train-robber-experiment-answers';

/** The answer box: the experiment's own question first, then the three every experiment asks (G45). */
export interface Answers { answer: string; next: string; prize: string; again: string }
export const ANSWER_FIELDS: readonly { key: keyof Answers; label: string }[] = [
  { key: 'next', label: 'What would you try next time?' },
  { key: 'prize', label: 'Did you see a prize or route you left behind?' },
  { key: 'again', label: 'Did you want to go again? Why?' },
];
export const emptyAnswers = (): Answers => ({ answer: '', next: '', prize: '', again: '' });

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

function readJson(key: string, s: Store | null): unknown {
  try { return JSON.parse(s?.getItem(key) ?? 'null'); } catch { return null; }
}
function writeJson(key: string, value: unknown, s: Store | null): void {
  try { s?.setItem(key, JSON.stringify(value)); } catch { /* storage blocked or full: kept for this page only */ }
}

/** Your own experiments, oldest first; anything that no longer parses is skipped. */
export function loadOwn(s = storage()): Experiment[] {
  const raw = readJson(OWN_KEY, s);
  return Array.isArray(raw) ? raw.flatMap((e) => { const r = ExperimentSchema.safeParse(e); return r.success ? [r.data] : []; }) : [];
}
export function saveOwn(list: readonly Experiment[], s = storage()): void { writeJson(OWN_KEY, list, s); }

/** Base setups you changed on repo experiments, by experiment id. */
export function loadBases(s = storage()): Record<string, ExperimentBase> {
  const raw = readJson(BASES_KEY, s);
  const out: Record<string, ExperimentBase> = {};
  if (raw && typeof raw === 'object') for (const [id, b] of Object.entries(raw)) { const r = ExperimentBaseSchema.safeParse(b); if (r.success) out[id] = r.data; }
  return out;
}
export function saveBases(bases: Record<string, ExperimentBase>, s = storage()): void { writeJson(BASES_KEY, bases, s); }

export function loadAnswers(s = storage()): Record<string, Answers> {
  const raw = readJson(ANSWERS_KEY, s);
  return raw && typeof raw === 'object' ? raw as Record<string, Answers> : {};
}
export function saveAnswers(answers: Record<string, Answers>, s = storage()): void { writeJson(ANSWERS_KEY, answers, s); }

/** JSON with sorted keys, so two copies of an experiment compare equal whatever order they were written in. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const sameExperiment = (a: Experiment, b: Experiment) => canonical(a) === canonical(b);

/** URL-safe base64 of the experiment's JSON, for Share and Play links. */
export function encodeExperiment(e: Experiment): string {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(e))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The experiment in a link, checked against the schema; throws with the reason when it is not one. */
export function decodeExperiment(s: string): Experiment {
  let json: unknown;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    throw new Error('the link is cut short or not an experiment');
  }
  return parseExperiment(json);
}

export function parseExperiment(json: unknown): Experiment {
  const r = ExperimentSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new Error(`not a valid experiment (${issue.path.join('.') || 'root'}: ${issue.message})`);
  }
  return r.data;
}

/** A lowercase id from a title plus a short random tail, so two testers' experiments never share an id by chance. */
export function newExperimentId(title: string, taken: ReadonlySet<string>, rand = Math.random): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'experiment';
  for (;;) {
    const id = `${slug}-${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * What to do with an experiment someone shared: `repo` when it is one of the repo's (it stays
 * read-only; nothing is saved), `same` when you already have it as it is, `new` to add it, or
 * `conflict` when you have a different experiment with that id (ask: keep both or replace).
 */
export type Incoming = 'repo' | 'same' | 'new' | 'conflict';
export function classifyIncoming(e: Experiment, own: readonly Experiment[], repoIds: ReadonlySet<string>): Incoming {
  if (repoIds.has(e.id)) return 'repo';
  const mine = own.find((o) => o.id === e.id);
  if (!mine) return 'new';
  return sameExperiment(mine, e) ? 'same' : 'conflict';
}

/**
 * Save an incoming experiment into `own`. On a conflict, `replace` swaps yours for it; otherwise
 * both are kept and the incoming one gets a new id. Returns the new list and the id it was saved
 * under (the one runs from its Play link should be tagged with).
 */
export function mergeIncoming(e: Experiment, own: readonly Experiment[], repoIds: ReadonlySet<string>, replace: boolean, rand = Math.random): { own: Experiment[]; id: string; kind: Incoming } {
  const kind = classifyIncoming(e, own, repoIds);
  if (kind === 'repo' || kind === 'same') return { own: [...own], id: e.id, kind };
  if (kind === 'new') return { own: [...own, e], id: e.id, kind };
  if (replace) return { own: own.map((o) => (o.id === e.id ? e : o)), id: e.id, kind };
  const id = newExperimentId(e.title, new Set([...own.map((o) => o.id), ...repoIds]), rand);
  return { own: [...own, { ...e, id, title: `${e.title} (shared)`.slice(0, 80) }], id, kind };
}

/**
 * The game page's URL for one setup: preset, variants, `?set=` values and map, tagged with
 * `exp` and `setup`. `carry` adds the whole experiment (`xp`) so the link saves it for whoever
 * opens it; repo experiments don't need it.
 */
export function playQuery(e: Experiment, setupId: string, base: ExperimentBase | undefined, carry: boolean): string {
  const setup = e.setups.find((s) => s.id === setupId);
  if (!setup) throw new Error(`experiment ${e.id} has no setup ${setupId}`);
  const sel = setupSelection(base, setup);
  const q = new URLSearchParams();
  q.set('preset', sel.preset);
  for (const [g, id] of Object.entries(sel.variants).sort()) q.append('v', `${g}:${id}`);
  for (const s of setParams(sel.set)) q.append('set', s);
  if (sel.map) q.set('map', sel.map);
  q.set('exp', e.id);
  q.set('setup', setupId);
  if (carry) q.set('xp', encodeExperiment(base === e.base ? e : { ...e, ...(base ? { base } : {}) }));
  return `?${q}`;
}

/** The Playtests page link that opens (and saves) an experiment: by id for a repo one, carried whole otherwise. */
export function shareQuery(e: Experiment, isRepo: boolean): string {
  return isRepo ? `?exp=${encodeURIComponent(e.id)}` : `?xp=${encodeExperiment(e)}`;
}
