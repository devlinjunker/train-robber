import { createSim, parseLog, replayCommandLog, type CommandLogLine, type ReplayResult } from '@train-robber/sim';
import { gameVersion, loadConfig } from './content';

export interface ReplayReport extends ReplayResult { warnings: string[] }

/** Rebuild the run from a commands log header and compare the logged hashes. */
export function replayText(text: string): ReplayReport {
  const log = parseLog<CommandLogLine>(text);
  const h = log.header;
  const warnings: string[] = [];
  const config = loadConfig({ preset: h.preset, variants: h.variants, overrides: h.overrides });
  if (h.configHash !== config.hash) warnings.push(`config hash differs: log ${h.configHash}, current ${config.hash}`);
  if (h.tickRateHz !== config.values.sim.tickRateHz) warnings.push(`tick rate differs: log ${h.tickRateHz}, config ${config.values.sim.tickRateHz}`);
  if (h.gameVersion !== gameVersion()) warnings.push(`game version differs: log ${h.gameVersion}, current ${gameVersion()}`);
  const sim = createSim({ config, seed: h.seed, playerIds: h.playerIds, persistent: h.persistentAtStart });
  return { ...replayCommandLog(log, sim), warnings };
}
