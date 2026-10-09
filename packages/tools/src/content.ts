import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, type ResolvedConfig } from '@train-robber/config';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONTENT_DIR = join(REPO_ROOT, 'packages/content');

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function gameVersion(): string {
  return (readJson(join(REPO_ROOT, 'apps/game/package.json')) as { version: string }).version;
}

export function loadConfig(): ResolvedConfig {
  return resolveConfig(readJson(join(CONTENT_DIR, 'base/tuning.json')));
}
