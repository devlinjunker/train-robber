// Playtest experiments (phase 2 M6a): a question plus 2-4 named setups to compare on the Playtests
// page. Repo experiments live in packages/content/playtests/*.json; testers build their own on the page.
import { z } from 'zod';
import { GameSchema } from './schema';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id with dashes');

/**
 * The numbers an experiment card can show for each setup. The card shows only the ones the
 * experiment names, so each question gets the few numbers that answer it.
 */
export const EXPERIMENT_NUMBERS = {
  outcomes: 'How runs ended',
  length: 'Average run length',
  lootCarried: 'Average loot carried at the end',
  banked: 'Average loot banked',
  lootLeft: 'Average loot left on the train',
  lootLost: 'Average loot lost on the way (thrown off, falls, spills)',
  wanted: 'Average wanted level at the start and after the outcome',
  timeLeft: 'Average countdown left',
  heat: 'Average heat at the end',
  heatRoll: 'Heat roll at the end (M6b): average chance of +wanted and how many hit',
  aboard: 'Share of runs that got aboard',
  toBoard: 'Median seconds from commit to aboard',
  jumps: 'Average jumps and perfect / good / fail',
  damage: 'Average damage taken',
  whistles: 'Average whistles',
} as const;
export type ExperimentNumber = keyof typeof EXPERIMENT_NUMBERS;
const numberId = z.enum(Object.keys(EXPERIMENT_NUMBERS) as [ExperimentNumber, ...ExperimentNumber[]]);

/** `?set=` values as `path: value`, e.g. `{ "countdown.scale": 4 }`. */
const setValues = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** What a setup or the base picks; anything left out comes from the base, then the game's defaults. */
const selection = {
  /** Preset id (`?preset=`); default alpha-default. */
  preset: id.optional(),
  /** Variant choices by group (`?v=group:id`). */
  variants: z.record(id).optional(),
  /** Config values (`?set=path=value`). */
  set: setValues.optional(),
  /** Map id (`?map=`), e.g. `line` or `big-country`. */
  map: z.string().regex(/^[a-z0-9-]+$/).optional(),
};

export const ExperimentSetupSchema = z.object({
  id,
  /** Short name shown on the card, e.g. "Mid towns". */
  name: z.string().min(1).max(40),
  ...selection,
}).strict();
export type ExperimentSetup = z.infer<typeof ExperimentSetupSchema>;

export const ExperimentBaseSchema = z.object(selection).strict();
export type ExperimentBase = z.infer<typeof ExperimentBaseSchema>;

export const ExperimentSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  title: z.string().min(1).max(80),
  /** The question the setups answer. */
  question: z.string().min(1).max(400),
  /** The pull request the question came from: the card links to it, and Send to PR posts results there. */
  pr: z.number().int().positive().optional(),
  /** Shared by every setup; on the page each tester can change it (e.g. to the spacing an earlier experiment picked). */
  base: ExperimentBaseSchema.optional(),
  setups: z.array(ExperimentSetupSchema).min(2).max(4),
  /** The numbers the card shows per setup, besides runs and session pull. */
  numbers: z.array(numberId).min(1).max(6),
  /** `done` once the question is answered: the page tucks the card into Finished experiments. */
  status: z.enum(['open', 'done']).optional(),
  /** What was decided, shown on a finished card. */
  conclusion: z.string().max(400).optional(),
}).strict().superRefine((e, ctx) => {
  const seen = new Set<string>();
  e.setups.forEach((s, i) => {
    if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['setups', i, 'id'], message: `duplicate setup id ${s.id}` });
    seen.add(s.id);
  });
});
export type Experiment = z.infer<typeof ExperimentSchema>;

export const DEFAULT_PRESET = 'alpha-default';

/** One setup with its experiment's base filled in: what the Play link puts in the URL. */
export interface SetupSelection {
  preset: string;
  variants: Record<string, string>;
  set: Record<string, string | number | boolean | null>;
  map?: string;
}

/** The setup over the base: the setup's preset and map win, variants and `?set=` values merge. */
export function setupSelection(base: ExperimentBase | undefined, setup: ExperimentSetup): SetupSelection {
  const map = setup.map ?? base?.map;
  return {
    preset: setup.preset ?? base?.preset ?? DEFAULT_PRESET,
    variants: { ...base?.variants, ...setup.variants },
    set: { ...base?.set, ...setup.set },
    ...(map ? { map } : {}),
  };
}

/** `?set=` entries for a selection, as the URL writes them (strings plain, the rest as JSON). */
export function setParams(set: SetupSelection['set']): string[] {
  return Object.entries(set).map(([path, v]) => `${path}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
}

/** What a `?set=` path takes, read from the game.json schema, for the experiment editor's hints. */
export interface SettingInfo { kind: 'number' | 'integer' | 'boolean' | 'text' | 'choice' | 'list' | 'other'; options?: string[]; min?: number; max?: number; nullable?: boolean }

export function describeSetting(path: string): SettingInfo | null {
  let t: z.ZodTypeAny = GameSchema;
  let nullable = false;
  const unwrap = () => {
    for (;;) {
      if (t instanceof z.ZodEffects) t = t._def.schema;
      else if (t instanceof z.ZodOptional || t instanceof z.ZodDefault) t = t._def.innerType;
      else if (t instanceof z.ZodNullable) { nullable = true; t = t._def.innerType; }
      else return;
    }
  };
  for (const key of path.split('.')) {
    unwrap();
    if (t instanceof z.ZodObject) {
      const next = (t.shape as Record<string, z.ZodTypeAny>)[key];
      if (!next) return null;
      t = next;
    } else if (t instanceof z.ZodRecord) t = t._def.valueType;
    else return null;
  }
  unwrap();
  const extra = nullable ? { nullable } : {};
  if (t instanceof z.ZodNumber) {
    const info: SettingInfo = { kind: t.isInt ? 'integer' : 'number', ...extra };
    if (t.minValue !== null) info.min = t.minValue;
    if (t.maxValue !== null) info.max = t.maxValue;
    return info;
  }
  if (t instanceof z.ZodBoolean) return { kind: 'boolean', ...extra };
  if (t instanceof z.ZodEnum) return { kind: 'choice', options: [...(t.options as string[])], ...extra };
  if (t instanceof z.ZodLiteral) return { kind: 'choice', options: [String(t.value)], ...extra };
  if (t instanceof z.ZodUnion) {
    const lits = (t.options as z.ZodTypeAny[]).filter((o) => o instanceof z.ZodLiteral).map((o) => String((o as z.ZodLiteral<unknown>).value));
    if (lits.length === (t.options as unknown[]).length) return { kind: 'choice', options: lits, ...extra };
  }
  if (t instanceof z.ZodString) return { kind: 'text', ...extra };
  if (t instanceof z.ZodArray || t instanceof z.ZodTuple) return { kind: 'list', ...extra };
  return { kind: 'other', ...extra };
}

/** A setting's kind in a few words, e.g. `number 0 to 1`, `one of: off, los, cone`, `true or false`. */
export function settingWords(info: SettingInfo | null): string {
  if (!info) return 'not a setting';
  const n = info.nullable ? ' (or null)' : '';
  switch (info.kind) {
    case 'number': case 'integer': {
      const what = info.kind === 'integer' ? 'whole number' : 'number';
      if (info.min !== undefined && info.max !== undefined) return `${what} ${info.min} to ${info.max}${n}`;
      if (info.min !== undefined) return `${what}, at least ${info.min}${n}`;
      if (info.max !== undefined) return `${what}, at most ${info.max}${n}`;
      return what + n;
    }
    case 'boolean': return `true or false${n}`;
    case 'choice': return `one of: ${info.options!.join(', ')}${n}`;
    case 'text': return `text${n}`;
    case 'list': return `a list (can't be set with ?set=)`;
    default: return `a value${n}`;
  }
}

/**
 * The doc comment on each game.json setting, by `?set=` path, read from the source of schema.ts
 * (the `/** … *\/` line or block just above a key inside `GameSchema`). Paths under records use `*`.
 */
export function settingDocs(schemaSource: string): Map<string, string> {
  const out = new Map<string, string>();
  const start = schemaSource.indexOf('export const GameSchema = z.object({');
  if (start < 0) return out;
  const lines = schemaSource.slice(start).split('\n').slice(1);
  const stack: { key: string; indent: number }[] = [];
  let doc: string[] | null = null;
  let inDoc = false;
  for (const line of lines) {
    if (/^\}\)/.test(line)) break; // the end of GameSchema
    const t = line.trim();
    if (inDoc || t.startsWith('/**')) {
      const body = t.replace(/^\/\*\*/, '').replace(/\*\/$/, '').replace(/^\*\s?/, '').trim();
      if (!inDoc) doc = [];
      if (body) doc!.push(body);
      inDoc = !t.endsWith('*/');
      continue;
    }
    const m = /^(\s*)['"]?([\w-]+)['"]?\s*:/.exec(line);
    if (!m) { if (t && !t.startsWith('//')) doc = null; continue; }
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const key = m[2]!;
    const path = [...stack.map((s) => s.key), key].join('.');
    if (doc?.length) out.set(path, doc.join(' '));
    doc = null;
    const opens = (line.match(/[({]/g) ?? []).length, closes = (line.match(/[)}]/g) ?? []).length;
    if (opens > closes) stack.push({ key: /z\.record\(/.test(line) ? `${key}.*` : key, indent });
  }
  return out;
}
