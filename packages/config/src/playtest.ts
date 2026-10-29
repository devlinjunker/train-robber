// Playtest experiments (phase 2 M6a): a question plus 2-4 named setups to compare on the Playtests
// page. Repo experiments live in packages/content/playtests/*.json; testers build their own on the page.
import { z } from 'zod';

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
