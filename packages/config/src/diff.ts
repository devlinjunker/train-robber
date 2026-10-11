import type { RunHeader } from '@train-robber/sim';

/** Leaf paths where two config value trees differ, as `path: log → current`. */
export function configDiff(logged: unknown, current: unknown, path = ''): string[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(logged) && isObj(current)) {
    const keys = [...new Set([...Object.keys(logged), ...Object.keys(current)])].sort();
    return keys.flatMap((k) => configDiff(logged[k], current[k], path ? `${path}.${k}` : k));
  }
  const a = JSON.stringify(logged), b = JSON.stringify(current);
  return a === b ? [] : [`${path}: log ${a ?? 'missing'}, current ${b ?? 'missing'}`];
}

/** What this build has, to compare against a log header. */
export interface BuildFacts { config: { hash: string; values: unknown }; gameVersion: string; mapHash: string }

/**
 * Why a log might not replay the same on this build: config hash (with each differing parameter
 * when the header carries `config`), tick rate, game version and map hash.
 */
export function headerWarnings(h: Pick<RunHeader, 'configHash' | 'config' | 'tickRateHz' | 'gameVersion' | 'mapHash'>, build: BuildFacts & { tickRateHz: number }): string[] {
  const warnings: string[] = [];
  if (h.configHash !== build.config.hash) {
    warnings.push(`config hash differs: log ${h.configHash}, current ${build.config.hash}`);
    // Logs that carry their config values say which parameters changed.
    if (h.config !== undefined) for (const d of configDiff(h.config, build.config.values)) warnings.push(`  ${d}`);
  }
  if (h.tickRateHz !== build.tickRateHz) warnings.push(`tick rate differs: log ${h.tickRateHz}, config ${build.tickRateHz}`);
  if (h.gameVersion !== build.gameVersion) warnings.push(`game version differs: log ${h.gameVersion}, current ${build.gameVersion}`);
  if (h.mapHash && h.mapHash !== build.mapHash) warnings.push(`map hash differs: log ${h.mapHash}, current ${build.mapHash}`);
  return warnings;
}
