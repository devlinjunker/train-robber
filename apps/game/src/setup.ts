// Picks the config and seed for a session from the URL:
//   ?preset=alpha-default&v=boardingFailure:time-only&seed=42
import { loadContent, resolveConfig, type ContentFile, type ResolvedConfig } from '@train-robber/config';
import base from '@train-robber/content/base/game.json';

const DEFAULT_PRESET = 'alpha-default';

const files = (mods: Record<string, unknown>): ContentFile[] =>
  Object.entries(mods).sort(([a], [b]) => a.localeCompare(b)).map(([file, data]) => ({ file, data: (data as { default: unknown }).default }));

const content = loadContent({
  base: { file: 'base/game.json', data: base },
  variants: files(import.meta.glob('../../../packages/content/variants/*.json', { eager: true })),
  presets: files(import.meta.glob('../../../packages/content/presets/*.json', { eager: true })),
});

export interface Setup { config: ResolvedConfig; seed: number }

export function setupFromUrl(search = location.search): Setup {
  const q = new URLSearchParams(search);
  const variants: Record<string, string> = {};
  for (const v of q.getAll('v')) {
    const [group, id] = v.split(':');
    if (group && id) variants[group] = id;
  }
  const config = resolveConfig(content, { preset: q.get('preset') ?? DEFAULT_PRESET, variants });
  const seedParam = q.get('seed');
  const seed = seedParam !== null && /^\d+$/.test(seedParam) ? Number(seedParam) >>> 0 : (Math.random() * 2 ** 32) >>> 0;
  return { config, seed };
}
