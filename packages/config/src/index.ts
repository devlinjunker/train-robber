import type { ZodError, ZodType } from 'zod';
import { hashState } from '@train-robber/sim';
import { GameSchema, PresetSchema, VariantSchema, type Game, type Preset, type Variant } from './schema';
import { CarTemplatesFileSchema, CellTypesFileSchema, ItemsFileSchema, LootTablesFileSchema } from './catalogs';
import { deepFreeze, derive, type Derived } from './derive';
import { checkReferences } from './references';

export * from './schema';
export * from './catalogs';
export { checkReferences } from './references';
export * from './map';
export * from './scenery';
export * from './diff';
export { derive, deepFreeze, type Derived } from './derive';

/** A loaded content file. `file` is only used in error messages. */
export interface ContentFile { file: string; data: unknown }

/** The catalog files merged into the base config under their own key (see catalogs.ts). */
export interface CatalogFiles {
  cellTypes: ContentFile;
  items: ContentFile;
  lootTables: ContentFile;
  carTemplates: ContentFile;
}

export interface ContentSet {
  base: ContentFile;
  catalogs: CatalogFiles;
  variants: ContentFile[];
  presets: ContentFile[];
}

export interface Selection {
  preset: string;
  /** Per-group variant choices that replace the preset's, e.g. from `?v=group:id`. */
  variants?: Record<string, string>;
  /** Run-time values merged last, as a partial game.json tree, e.g. from `?set=countdown.scale=4`. */
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
  /** The catalogs' payloads, keyed as they appear in the config. */
  catalogs: { cellTypes: unknown; items: unknown; lootTables: unknown; carTemplates: unknown };
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
  const c = content.catalogs;
  const catalogs = {
    cellTypes: parse(CellTypesFileSchema, c.cellTypes).cellTypes,
    items: parse(ItemsFileSchema, c.items).items,
    lootTables: parse(LootTablesFileSchema, c.lootTables).lootTables,
    carTemplates: parse(CarTemplatesFileSchema, c.carTemplates).cars,
  };
  return { base: content.base, catalogs, variants, groups, presets };
}

/**
 * A preset with everything it inherits through `extends`: the variants and values of the
 * presets it builds on, oldest first, with its own replacing theirs.
 */
function flattenPreset(loaded: LoadedContent, id: string): { preset: Preset & { file: string }; variants: Record<string, string>; values: unknown } {
  const chain: (Preset & { file: string })[] = [];
  for (let at: string | undefined = id, from = 'presets'; at !== undefined;) {
    const p = loaded.presets.get(at);
    if (!p) throw new ConfigError(from, chain.length ? 'extends' : '', `unknown preset ${at}`);
    if (chain.includes(p)) throw new ConfigError(p.file, 'extends', `preset ${p.id} extends itself through ${chain.map((c) => c.id).join(' -> ')}`);
    chain.push(p);
    from = p.file;
    at = p.extends;
  }
  let variants: Record<string, string> = {}, values: unknown = {};
  for (const p of chain.reverse()) {
    variants = { ...variants, ...p.variants };
    if (p.values) values = merge(values, p.values);
  }
  return { preset: chain[chain.length - 1]!, variants, values };
}

/**
 * `?set=` entries as overrides: each `path=value` becomes a nested value at that dotted path, so
 * `countdown.scale=4` gives `{ countdown: { scale: 4 } }`. Values are read as JSON (numbers,
 * booleans, null, arrays) and fall back to the plain string. A later entry for a path wins.
 */
export function overridesFromSet(entries: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const path = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    if (!path) continue;
    const raw = eq < 0 ? '' : entry.slice(eq + 1);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }
    // Built by hand rather than with merge, which would drop a null instead of keeping it as "remove this key".
    let at = out;
    const keys = path.split('.');
    // A URL can carry anything, so never let it reach an object's prototype.
    if (keys.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype' || k === '')) continue;
    keys.slice(0, -1).forEach((key) => { at = (isObject(at[key]) ? at[key] : (at[key] = {})) as Record<string, unknown>; });
    at[keys[keys.length - 1]!] = value;
  }
  return out;
}

/** Overrides back to `path=value` entries, the inverse of overridesFromSet, for showing them. */
export function setEntries(overrides: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(overrides).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isObject(v) ? setEntries(v, path) : [`${path}=${JSON.stringify(v)}`];
  });
}

/** Steps 2 to 5: merge, validate, derive, freeze and hash. */
export function resolveConfig(loaded: LoadedContent, sel: Selection): ResolvedConfig {
  const flat = flattenPreset(loaded, sel.preset);
  const preset = flat.preset;
  const chosen: Record<string, string> = { ...flat.variants, ...sel.variants };
  for (const group of loaded.groups.keys()) {
    if (!(group in chosen)) throw new ConfigError(preset.file, `variants.${group}`, `no variant chosen for group ${group}`);
  }

  let merged: unknown = merge(loaded.base.data, loaded.catalogs);
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
  // Preset values, then run-time overrides, both after the variants (step 2).
  merged = merge(merged, flat.values);
  const overrides = sel.overrides ?? {};
  merged = merge(merged, overrides);

  const file = `${loaded.base.file} merged with preset ${preset.id}`;
  const game = parse(GameSchema, { file, data: merged });
  const bad = checkReferences(game);
  if (bad) throw new ConfigError(file, bad.path, bad.message);
  let values: Derived<Game>;
  try {
    values = derive(game, game.sim.tickRateHz);
  } catch (e) {
    throw new ConfigError(loaded.base.file, '', (e as Error).message);
  }
  deepFreeze(values);
  return { values, hash: hashState(values), preset: preset.id, variants: chosen, overrides };
}
