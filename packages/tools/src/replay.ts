import { createSim, mapHash, parseLog, replayCommandLog, type CommandLogLine, type ReplayResult } from '@train-robber/sim';
import { DEFAULT_MAP, gameVersion, loadConfig, loadMapDef } from './content';

export interface ReplayReport extends ReplayResult {
  warnings: string[];
  /** Playtester comments in the log, in order. */
  notes: { t: number; text: string }[];
}

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

/** Rebuild the run from a commands log header and compare the logged hashes. */
export function replayText(text: string): ReplayReport {
  const log = parseLog<CommandLogLine>(text);
  const h = log.header;
  const warnings: string[] = [];
  const config = loadConfig({ preset: h.preset, variants: h.variants, overrides: h.overrides });
  if (h.configHash !== config.hash) {
    warnings.push(`config hash differs: log ${h.configHash}, current ${config.hash}`);
    // Logs that carry their config values say which parameters changed.
    if (h.config !== undefined) for (const d of configDiff(h.config, config.values)) warnings.push(`  ${d}`);
  }
  if (h.tickRateHz !== config.values.sim.tickRateHz) warnings.push(`tick rate differs: log ${h.tickRateHz}, config ${config.values.sim.tickRateHz}`);
  if (h.gameVersion !== gameVersion()) warnings.push(`game version differs: log ${h.gameVersion}, current ${gameVersion()}`);
  // Logs from before M2 carry no map; they were played on the default one.
  const mapId = h.mapId ?? DEFAULT_MAP;
  if (!h.mapId) warnings.push(`log names no map, using ${DEFAULT_MAP}`);
  const map = loadMapDef(mapId);
  const hash = mapHash(map);
  if (h.mapHash && h.mapHash !== hash) warnings.push(`map hash differs: log ${h.mapHash}, current ${hash}`);
  const sim = createSim({ config, map, seed: h.seed, playerIds: h.playerIds, persistent: h.persistentAtStart });
  const notes = log.lines.flatMap((l) => (l.k === 'note' ? [{ t: l.t, text: l.text }] : []));
  return { ...replayCommandLog(log, sim), warnings, notes };
}
