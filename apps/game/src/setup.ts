// Picks the config and seed for a session from the URL:
//   ?preset=alpha-default&v=boardingFailure:time-only&set=countdown.scale=4&seed=abc123
// Each `set=<path>=<value>` is a run-time override of one config value, recorded in the log header.
// `?wanted=3` is short for `?set=wanted.forceLevel=3`: practice runs at that wanted level that save nothing.
import { loadContent, overridesFromSet, resolveConfig, type ContentFile, type ResolvedConfig } from '@train-robber/config';
import base from '@train-robber/content/base/game.json';
import cellTypes from '@train-robber/content/base/cell-types.json';
import items from '@train-robber/content/base/items.json';
import lootTables from '@train-robber/content/base/loot-tables.json';
import carTemplates from '@train-robber/content/base/car-templates.json';

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
