import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent, resolveConfig, type ContentFile, type LoadedContent, type ResolvedConfig, type Selection } from '@train-robber/config';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONTENT_DIR = join(REPO_ROOT, 'packages/content');
export const DEFAULT_PRESET = 'alpha-default';

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function file(path: string): ContentFile {
  const rel = relative(REPO_ROOT, path);
  try {
    return { file: rel, data: readJson(path) };
  } catch (e) {
    throw new Error(`${rel}: ${(e as Error).message}`);
  }
}

export function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function gameVersion(): string {
  return (readJson(join(REPO_ROOT, 'apps/game/package.json')) as { version: string }).version;
}

export function loadContentDir(dir = CONTENT_DIR): LoadedContent {
  return loadContent({
    base: file(join(dir, 'base/game.json')),
    variants: jsonFiles(join(dir, 'variants')).map(file),
    presets: jsonFiles(join(dir, 'presets')).map(file),
  });
}

export function loadConfig(sel: Selection = { preset: DEFAULT_PRESET }): ResolvedConfig {
  return resolveConfig(loadContentDir(), sel);
}
