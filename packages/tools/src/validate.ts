// `tools validate`: resolve every preset (steps 1 to 5) and every single-variant
// swap from it, so a broken variant fails CI even if no preset picks it yet. Then the
// train-level car checks: cars that line up, end doors that join, side doors to board by.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MapDefSchema, SceneryDefSchema, resolveConfig, resolveMapGen, type ResolvedConfig } from '@train-robber/config';
import { carCatalog, cellOpen, layoutPool, type PreparedCar } from '@train-robber/sim';
import { CONTENT_DIR, REPO_ROOT, jsonFiles, loadContentDir, readJson } from './content';

export interface ValidateResult { errors: string[]; resolved: { preset: string; variants: Record<string, string>; hash: string }[] }

/** Rows with an opening (a cell that does not block movement) in a car's front or rear end wall. */
function endRows(t: PreparedCar, end: 'front' | 'rear'): number[] {
  const col = end === 'front' ? 0 : t.size.cols - 1;
  return Array.from({ length: t.size.rows }, (_, r) => r).filter((r) => cellOpen(t, col, r));
}

/** What is wrong with how a train's possible cars fit together, or nothing. */
export function trainCarErrors(config: ResolvedConfig): string[] {
  const errors: string[] = [];
  const catalog = carCatalog(config);
  for (const [id, def] of Object.entries(config.values.trains)) {
    const pool = def.carCount > 0 ? layoutPool(config, id, catalog).map((l) => catalog.get(l)!) : [];
    const engine = catalog.get(def.engine)!, caboose = def.caboose ? catalog.get(def.caboose)! : null;
    const all = [engine, ...pool, ...(caboose ? [caboose] : [])];
    const rows = new Set(all.map((t) => t.size.rows));
    if (rows.size > 1) errors.push(`train ${id}: cars have different row counts (${all.map((t) => `${t.id} ${t.size.rows}`).join(', ')}), so they do not line up end to end`);
    // Any two layouts can be coupled, so each pair of cars that can meet must share an end-door row.
    const joins: [PreparedCar, PreparedCar][] = [];
    for (const a of pool) for (const b of pool) joins.push([a, b]);
    if (caboose) for (const a of pool.length ? pool : [engine]) joins.push([a, caboose]);
    // An engine with a rear door (a walkable cab) must join whatever follows it.
    if (endRows(engine, 'rear').length) for (const b of pool.length ? pool : caboose ? [caboose] : []) joins.push([engine, b]);
    for (const [a, b] of joins) {
      const ra = endRows(a, 'rear'), rb = endRows(b, 'front');
      if (!ra.some((r) => rb.includes(r))) errors.push(`train ${id}: ${a.id}'s rear end (open rows ${ra.join(',') || 'none'}) does not join ${b.id}'s front end (open rows ${rb.join(',') || 'none'}), so you cannot walk between them`);
    }
    const sides = (['left', 'right'] as const).filter((s) => all.some((t) => t.sideDoors[s]));
    if (def.requireSideDoors === 'both' && sides.length < 2) errors.push(`train ${id}: requireSideDoors is both, but no car it can pick has a ${['left', 'right'].find((s) => !sides.includes(s as never))} side door`);
    if (def.requireSideDoors === 'one' && sides.length === 0) errors.push(`train ${id}: requireSideDoors is one, but no car it can pick has a side door`);
  }
  return [...new Set(errors)];
}

export function validateContent(dir?: string): ValidateResult {
  const errors: string[] = [];
  const resolved: ValidateResult['resolved'] = [];
  let content;
  try {
    content = loadContentDir(dir);
  } catch (e) {
    return { errors: [(e as Error).message], resolved };
  }
  if (content.presets.size === 0) errors.push('no presets found');
  const trainTypes = new Set<string>();
  for (const preset of content.presets.values()) {
    // The preset's own choices include the ones it inherits with `extends`.
    let chosen = preset.variants;
    try { chosen = resolveConfig(content, { preset: preset.id }).variants; } catch { /* reported below */ }
    const selections: Record<string, string>[] = [{}];
    for (const [group, ids] of content.groups) {
      for (const id of ids) if (chosen[group] !== id) selections.push({ [group]: id });
    }
    for (const variants of selections) {
      try {
        const r = resolveConfig(content, { preset: preset.id, variants });
        for (const t of Object.keys(r.values.trains)) trainTypes.add(t);
        const bad = trainCarErrors(r);
        if (bad.length) throw new Error(bad.join('; '));
        resolved.push({ preset: r.preset, variants: r.variants, hash: r.hash });
      } catch (e) {
        const swap = Object.entries(variants).map(([g, id]) => ` with ${g}:${id}`).join('');
        errors.push(`preset ${preset.id}${swap}: ${(e as Error).message}`);
      }
    }
  }
  for (const [folder, schema] of [['base/maps', MapDefSchema], ['base/scenery', SceneryDefSchema]] as const) {
    for (const path of jsonFiles(join(dir ?? CONTENT_DIR, folder))) {
      const r = schema.safeParse(readJson(path));
      if (!r.success) {
        const issue = r.error.issues[0]!;
        errors.push(`${relative(REPO_ROOT, path)} at ${issue.path.join('.')}: ${issue.message}`);
        continue;
      }
      const trains = 'trains' in r.data ? r.data.trains : undefined;
      trains?.forEach((t, i) => {
        if (!trainTypes.has(t.type)) errors.push(`${relative(REPO_ROOT, path)} at trains.${i}.type: unknown train ${t.type}`);
      });
    }
  }
  // The procedural generator's defaults (?map=gen).
  const mapGen = join(dir ?? CONTENT_DIR, 'base/map-gen.json');
  if (existsSync(mapGen)) {
    try { resolveMapGen(readJson(mapGen)); } catch (e) { errors.push(`${relative(REPO_ROOT, mapGen)}: ${(e as Error).message}`); }
  }
  return { errors, resolved };
}
