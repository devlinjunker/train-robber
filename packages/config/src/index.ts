import type { ZodError, ZodType } from 'zod';
import { hashState } from '@train-robber/sim';
import { GameSchema, PresetSchema, VariantSchema, type Game, type Preset, type Variant } from './schema';
import { deepFreeze, derive, type Derived } from './derive';

export * from './schema';
export * from './map';
export { derive, deepFreeze, type Derived } from './derive';

/** A loaded content file. `file` is only used in error messages. */
export interface ContentFile { file: string; data: unknown }

export interface ContentSet {
  base: ContentFile;
  variants: ContentFile[];
  presets: ContentFile[];
}

export interface Selection {
  preset: string;
  /** Per-group variant choices that replace the preset's, e.g. from `?v=group:id`. */
  variants?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

export interface ResolvedConfig {
  values: Derived<Game>;
  /** Hash of the canonical JSON of `values`, recorded in every log header. */
  hash: string;
  preset: string;
  variants: Record<string, string>;
  overrides: Record<string, unknown>;
}

export class ConfigError extends Error {
  constructor(readonly file: string, readonly path: string, detail: string) {
    super(`${file}${path ? ` at ${path}` : ''}: ${detail}`);
    this.name = 'ConfigError';
  }
}

function parse<T>(schema: ZodType<T>, f: ContentFile): T {
  const r = schema.safeParse(f.data);
  if (r.success) return r.data;
  const issue = (r.error as ZodError).issues[0]!;
  throw new ConfigError(f.file, issue.path.join('.'), issue.message);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Objects deep-merge, arrays and scalars replace, and `null` removes the key. */
export function merge(base: unknown, over: unknown): unknown {
  if (!isObject(over) || !isObject(base)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = k in out ? merge(out[k], v) : v;
  }
  return out;
}

/** Leaf paths a patch touches, used to catch two groups patching the same value. */
function leafPaths(v: unknown, prefix = ''): string[] {
  if (!isObject(v)) return [prefix];
  return Object.entries(v).flatMap(([k, c]) => leafPaths(c, prefix ? `${prefix}.${k}` : k));
}

export interface LoadedContent {
  base: ContentFile;
  variants: Map<string, Variant & { file: string }>;
  groups: Map<string, string[]>;
  presets: Map<string, Preset & { file: string }>;
}

/** Resolve step 1: check every file's shape and schemaVersion, and index variants and presets. */
export function loadContent(content: ContentSet): LoadedContent {
  const variants = new Map<string, Variant & { file: string }>();
  const groups = new Map<string, string[]>();
  for (const f of content.variants) {
    const v = parse(VariantSchema, f);
    const key = `${v.group}:${v.id}`;
    if (variants.has(key)) throw new ConfigError(f.file, 'id', `duplicate variant ${key}`);
    variants.set(key, { ...v, file: f.file });
    groups.set(v.group, [...(groups.get(v.group) ?? []), v.id]);
  }
  const presets = new Map<string, Preset & { file: string }>();
  for (const f of content.presets) {
    const p = parse(PresetSchema, f);
    if (presets.has(p.id)) throw new ConfigError(f.file, 'id', `duplicate preset ${p.id}`);
    presets.set(p.id, { ...p, file: f.file });
  }
  return { base: content.base, variants, groups, presets };
}

/** Steps 2 to 5: merge, validate, derive, freeze and hash. */
export function resolveConfig(loaded: LoadedContent, sel: Selection): ResolvedConfig {
  const preset = loaded.presets.get(sel.preset);
  if (!preset) throw new ConfigError('presets', '', `unknown preset ${sel.preset}`);
  const chosen: Record<string, string> = { ...preset.variants, ...sel.variants };
  for (const group of loaded.groups.keys()) {
    if (!(group in chosen)) throw new ConfigError(preset.file, `variants.${group}`, `no variant chosen for group ${group}`);
  }

  let merged: unknown = loaded.base.data;
  const owner = new Map<string, string>();
  for (const group of Object.keys(chosen).sort()) {
    const id = chosen[group]!;
    const v = loaded.variants.get(`${group}:${id}`);
    if (!v) throw new ConfigError(preset.file, `variants.${group}`, `unknown variant ${group}:${id}`);
    for (const path of leafPaths(v.patch)) {
      const prev = owner.get(path);
      if (prev) throw new ConfigError(v.file, `patch.${path}`, `also patched by group ${prev}`);
      owner.set(path, group);
    }
    merged = merge(merged, v.patch);
  }
  const overrides = sel.overrides ?? {};
  merged = merge(merged, overrides);

  const game = parse(GameSchema, { file: `${loaded.base.file} merged with preset ${preset.id}`, data: merged });
  let values: Derived<Game>;
  try {
    values = derive(game, game.sim.tickRateHz);
  } catch (e) {
    throw new ConfigError(loaded.base.file, '', (e as Error).message);
  }
  deepFreeze(values);
  return { values, hash: hashState(values), preset: preset.id, variants: chosen, overrides };
}
