// Scripted golden run. `npm run golden:update` rewrites the checked-in replay
// after a deliberate sim change; the replay test then guards it.
import { commandLogWriter, createSim, type InputFrame } from '@train-robber/sim';
import { gameVersion, loadConfig } from './content';

const TICKS = 600;

function script(t: number): InputFrame[] {
  const commands: InputFrame['commands'] =
    t === 5 ? [{ type: 'startRun' }, { type: 'move', x: 127, y: -40 }]
    : t === 90 ? [{ type: 'move', x: 0, y: 127 }]
    : t === 300 ? [{ type: 'cancelRun' }, { type: 'move', x: -64, y: 0 }]
    : t === 420 ? [{ type: 'startRun' }]
    : [];
  return [{ player: 1, commands }];
}

export function recordGolden(): string {
  const config = loadConfig({ preset: 'alpha-default', variants: { boardingFailure: 'time-only' } });
  const lines: string[] = [];
  const header = {
    gameVersion: gameVersion(), configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed: 'golden-1', tickRateHz: config.values.sim.tickRateHz, playerIds: [1], persistentAtStart: { wantedLevel: 1, bank: 120, lifetimeEarned: 450 },
    startedAt: '2026-10-09T00:00:00Z',
  };
  const sim = createSim({ config, seed: header.seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
  const log = commandLogWriter(header, (l) => lines.push(l), { hashEveryTicks: config.values.logging.hashEveryTicks });
  for (let t = 0; t < TICKS; t++) {
    const inputs = script(t);
    log.step(t, inputs);
    sim.step(inputs);
    log.checkpoint(t + 1, () => sim.hash());
  }
  log.end(TICKS, sim.hash());
  return lines.join('\n') + '\n';
}
