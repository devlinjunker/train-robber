// Picks the config and seed for a session from the URL:
//   ?preset=alpha-default&v=boardingFailure:time-only&set=countdown.scale=4&seed=abc123
// Each `set=<path>=<value>` is a run-time override of one config value, recorded in the log header.
// `?wanted=3` is short for `?set=wanted.forceLevel=3`: practice runs at that wanted level that save nothing.
import { describeSetting, ExperimentSchema, loadContent, settingDocs, settingWords, overridesFromSet, resolveConfig, setEntries, type ContentFile, type Experiment, type ResolvedConfig } from '@train-robber/config';
import base from '@train-robber/content/base/game.json';
import cellTypes from '@train-robber/content/base/cell-types.json';
import items from '@train-robber/content/base/items.json';
import lootTables from '@train-robber/content/base/loot-tables.json';
import carTemplates from '@train-robber/content/base/car-templates.json';
import schemaSource from '../../../packages/config/src/schema.ts?raw';

const DEFAULT_PRESET = 'alpha-default';

const files = (mods: Record<string, unknown>): ContentFile[] =>
  Object.entries(mods).sort(([a], [b]) => a.localeCompare(b)).map(([file, data]) => ({ file, data: (data as { default: unknown }).default }));

const content = loadContent({
  base: { file: 'base/game.json', data: base },
  catalogs: {
    cellTypes: { file: 'base/cell-types.json', data: cellTypes },
    items: { file: 'base/items.json', data: items },
    lootTables: { file: 'base/loot-tables.json', data: lootTables },
    carTemplates: { file: 'base/car-templates.json', data: carTemplates },
  },
  variants: files(import.meta.glob('../../../packages/content/variants/*.json', { eager: true })),
  presets: files(import.meta.glob('../../../packages/content/presets/*.json', { eager: true })),
});

export interface Setup { config: ResolvedConfig; seed: string }

export function setupFromUrl(search = location.search): Setup {
  const q = new URLSearchParams(search);
  const variants: Record<string, string> = {};
  for (const v of q.getAll('v')) {
    const [group, id] = v.split(':');
    if (group && id) variants[group] = id;
  }
  const sets = q.getAll('set');
  const wanted = q.get('wanted');
  if (wanted !== null && wanted !== '') sets.push(`wanted.forceLevel=${wanted}`);
  const config = resolveConfig(content, { preset: q.get('preset') ?? DEFAULT_PRESET, variants, overrides: overridesFromSet(sets) });
  // Any string works as a seed; without one, the host picks a random one (the sim never does).
  const seed = q.get('seed') || Math.random().toString(36).slice(2, 10);
  return { config, seed };
}

/** The config a logged run used, rebuilt from its header's preset, variants and overrides on this build's content. */
export function configForHeader(h: { preset: string; variants: Record<string, string>; overrides: Record<string, unknown> }): ResolvedConfig {
  return resolveConfig(content, { preset: h.preset, variants: h.variants, overrides: h.overrides });
}

/** Preset ids, alphabetically, for the experiment editor. */
export const presetIds = (): string[] => [...content.presets.keys()].sort();
/** Variant ids by group, for the experiment editor. */
/** A variant group for the editor: a readable name, the question it answers, and each option's label. */
export interface VariantGroupInfo { group: string; name: string; question: string; options: { id: string; label: string; help: string }[] }
export const variantInfo = (): VariantGroupInfo[] => variantGroups().map(([group, ids]) => {
  const vs = ids.map((id) => content.variants.get(`${group}:${id}`)!);
  return { group, name: readable(group), question: vs[0]?.question ?? '', options: vs.map((v) => ({ id: v.id, label: v.label, help: v.help ?? '' })) };
});
/** `guardCatch` as `Guard catch`. */
export const readable = (camel: string) => camel === 'ai' ? 'AI' : camel.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());
/** What a `?set=` path takes, and its value in game.json, e.g. `number 0 to 1 · default 0.5`. */
export function settingHint(path: string): string {
  if (!path) return '';
  const words = settingWords(describeSetting(path));
  let v: unknown = base;
  for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return v === undefined || typeof v === 'object' ? words : `${words} · game.json has ${JSON.stringify(v)}`;
}
// Each setting's doc comment, read from schema.ts so the editor explains a `?set=` path in the schema's own words.
const docs = settingDocs(schemaSource);
/** A `?set=` path's doc comment, trying `*` for record keys (e.g. `trains.mail-express.carCount` → `trains.*.carCount`). */
export function settingDoc(path: string): string {
  const parts = path.split('.');
  if (docs.has(path)) return docs.get(path)!;
  for (let i = 0; i < parts.length; i++) {
    const p = [...parts.slice(0, i), '*', ...parts.slice(i + 1)].join('.');
    if (docs.has(p)) return docs.get(p)!;
  }
  return '';
}
/** A `?set=` path in words: `countdown.scale` → `Countdown › Scale`. */
export const settingName = (path: string) => path.split('.').map(readable).join(' › ');
/** Values to suggest for a `?set=` path: its choices, or true/false. */
export function settingChoices(path: string): string[] {
  const info = describeSetting(path);
  return info?.kind === 'choice' ? info.options! : info?.kind === 'boolean' ? ['true', 'false'] : [];
}
export const variantGroups = (): [string, string[]][] => [...content.groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, ids]) => [g, [...ids].sort()]);

/** The experiments shipped in packages/content/playtests (checked by `tools validate`); a bad one is skipped with a warning. */
export const repoExperiments: Experiment[] = Object.entries(import.meta.glob('../../../packages/content/playtests/*.json', { eager: true, import: 'default' }))
  .flatMap(([file, data]) => {
    const r = ExperimentSchema.safeParse(data);
    if (!r.success) console.warn(`${file}: not a valid experiment`, r.error.issues[0]);
    return r.success ? [r.data] : [];
  })
  .sort((a, b) => a.title.localeCompare(b.title));

const presetVariantsCache = new Map<string, Record<string, string> | null>();
function presetVariants(preset: string): Record<string, string> | null {
  if (!presetVariantsCache.has(preset)) {
    try { presetVariantsCache.set(preset, resolveConfig(content, { preset }).variants); } catch { presetVariantsCache.set(preset, null); }
  }
  return presetVariantsCache.get(preset)!;
}

/**
 * A setup told as its difference from the default: the preset when it is not alpha-default, the
 * variant picks that differ from that preset's own, then the `?set=` values. Empty for the default.
 */
export function diffParts(sel: { preset: string; variants: Record<string, string>; overrides?: Record<string, unknown>; map?: string }): string[] {
  const own = presetVariants(sel.preset) ?? {};
  return [
    ...(sel.preset !== DEFAULT_PRESET ? [sel.preset] : []),
    ...Object.entries(sel.variants).filter(([g, id]) => own[g] !== id).sort().map(([g, id]) => `${g}:${id}`),
    ...setEntries(sel.overrides ?? {}).sort().map((e) => e.replace(/="([^"]*)"$/, '=$1')),
    ...(sel.map ? [`map ${sel.map}`] : []),
  ];
}
/**
 * The same difference in words, for experiment cards: variants as `Guard catch: Guards only raise heat`
 * with their help text, the preset, `?set=` values and map as they are.
 */
export function diffReadable(sel: Parameters<typeof diffParts>[0]): { text: string; help?: string }[] {
  const own = presetVariants(sel.preset) ?? {};
  const variant = (g: string, id: string) => {
    const v = content.variants.get(`${g}:${id}`);
    return { text: `${readable(g)}: ${v?.label ?? id}`, ...(v?.help ? { help: v.help } : {}) };
  };
  const out = [
    ...(sel.preset !== DEFAULT_PRESET ? [{ text: `preset ${sel.preset}` }] : []),
    // What the preset itself changes from the default, so a preset reads as its variants too.
    ...(sel.preset !== DEFAULT_PRESET ? Object.entries(own).filter(([g, id]) => (presetVariants(DEFAULT_PRESET) ?? {})[g] !== id && !(g in sel.variants)).sort().map(([g, id]) => variant(g, id)) : []),
    ...Object.entries(sel.variants).filter(([g, id]) => own[g] !== id).sort().map(([g, id]) => variant(g, id)),
    ...setEntries(sel.overrides ?? {}).sort().map((e) => {
      const path = e.slice(0, e.indexOf('='));
      const doc = settingDoc(path);
      return { text: `${settingName(path)} = ${e.slice(e.indexOf('=') + 1).replace(/^"([^"]*)"$/, '$1')}`, help: `${path}${doc ? `: ${doc}` : ''}` };
    }),
    ...(sel.map ? [{ text: `map ${sel.map}` }] : []),
  ];
  return out.length ? out : [{ text: 'default' }];
}
export const diffLabel = (sel: Parameters<typeof diffParts>[0]): string => diffParts(sel).join(', ') || 'default';

/** Why a selection does not resolve to a config, or null when it does. */
export function selectionError(sel: { preset: string; variants: Record<string, string>; overrides: Record<string, unknown> }): string | null {
  try { resolveConfig(content, sel); return null; } catch (e) { return (e as Error).message; }
}

/** Maps a setup can pick: the built ones, then the generated loop and the open line. */
export const mapChoices = (): string[] => [
  ...Object.keys(import.meta.glob('../../../packages/content/base/maps/*.json')).map((p) => p.replace(/^.*\/|\.json$/g, '')).sort(),
  'gen', 'line',
];

/** Every number or switch in game.json as a `?set=` path, e.g. `countdown.scale`, for the editor's suggestions. */
export function settablePaths(): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, c] of Object.entries(v)) walk(c, path ? `${path}.${k}` : k);
    else if (path && path !== 'schemaVersion') out.push(path);
  };
  walk(base, '');
  return out.sort();
}
