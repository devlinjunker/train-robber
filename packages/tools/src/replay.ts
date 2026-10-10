import { createSim, mapHash, parseLog, replayCommandLog, type CommandLogLine, type ReplayResult } from '@train-robber/sim';
import { configDiff, headerWarnings } from '@train-robber/config';
import { DEFAULT_MAP, gameVersion, loadConfig, loadMapDef } from './content';

export { configDiff };

export interface ReplayReport extends ReplayResult {
  warnings: string[];
  /** Playtester comments in the log, in order. */
  notes: { t: number; text: string }[];
}

/** Rebuild the run from a commands log header and compare the logged hashes. */
export function replayText(text: string): ReplayReport {
  const log = parseLog<CommandLogLine>(text);
  const h = log.header;
  const config = loadConfig({ preset: h.preset, variants: h.variants, overrides: h.overrides });
  // Logs from before M2 carry no map; they were played on the default one.
  const mapId = h.mapId ?? DEFAULT_MAP;
  const map = loadMapDef(mapId);
  const warnings = headerWarnings(h, { config, gameVersion: gameVersion(), mapHash: mapHash(map), tickRateHz: config.values.sim.tickRateHz });
  if (!h.mapId) warnings.push(`log names no map, using ${DEFAULT_MAP}`);
  const sim = createSim({ config, map, seed: h.seed, playerIds: h.playerIds, persistent: h.persistentAtStart });
  const notes = log.lines.flatMap((l) => (l.k === 'note' ? [{ t: l.t, text: l.text }] : []));
  return { ...replayCommandLog(log, sim), warnings, notes };
}
