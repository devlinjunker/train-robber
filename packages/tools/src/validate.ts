// `tools validate`: resolve every preset (steps 1 to 5) and every single-variant
// swap from it, so a broken variant fails CI even if no preset picks it yet.
import { join, relative } from 'node:path';
import { MapDefSchema, resolveConfig } from '@train-robber/config';
import { CAR_TEMPLATES } from '@train-robber/sim';
import { CONTENT_DIR, REPO_ROOT, jsonFiles, loadContentDir, readJson } from './content';

export interface ValidateResult { errors: string[]; resolved: { preset: string; variants: Record<string, string>; hash: string }[] }

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
  for (const preset of content.presets.values()) {
    const selections: Record<string, string>[] = [{}];
    for (const [group, ids] of content.groups) {
      for (const id of ids) if (preset.variants[group] !== id) selections.push({ [group]: id });
    }
    for (const variants of selections) {
      try {
        const r = resolveConfig(content, { preset: preset.id, variants });
        for (const [id, train] of Object.entries(r.values.trains)) {
          for (const car of train.cars) {
            if (!CAR_TEMPLATES[car.template]) throw new Error(`train ${id} uses unknown car template ${car.template}`);
          }
        }
        resolved.push({ preset: r.preset, variants: r.variants, hash: r.hash });
      } catch (e) {
        const swap = Object.entries(variants).map(([g, id]) => ` with ${g}:${id}`).join('');
        errors.push(`preset ${preset.id}${swap}: ${(e as Error).message}`);
      }
    }
  }
  for (const path of jsonFiles(join(dir ?? CONTENT_DIR, 'base/maps'))) {
    const r = MapDefSchema.safeParse(readJson(path));
    if (!r.success) {
      const issue = r.error.issues[0]!;
      errors.push(`${relative(REPO_ROOT, path)} at ${issue.path.join('.')}: ${issue.message}`);
    }
  }
  return { errors, resolved };
}
