// Scripted golden run. `npm run golden:update` rewrites the checked-in replay
// after a deliberate sim change; the replay test then guards it.
import { commandLogWriter, createSim, mapHash, type InputFrame, type RunHeader } from '@train-robber/sim';
import { DEFAULT_MAP, gameVersion, loadConfig, loadMapDef } from './content';

const TICKS = 900;

// Default variants (heading-relative steering, coast throttle): ride up toward the bottom
// straight, turn with move.x (steer commands are recorded but ignored), ease off and coast,
// brake, then cancel and start another run.
function script(t: number): InputFrame[] {
  const commands: InputFrame['commands'] =
    t === 5 ? [{ type: 'startRun' }, { type: 'move', x: 0, y: -127 }]
    : t === 120 ? [{ type: 'steer', x: -127, y: -127 }]
    : t === 180 ? [{ type: 'steer', x: -127, y: 0 }, { type: 'move', x: 127, y: 0 }]
    : t === 420 ? [{ type: 'move', x: 0, y: 127 }]
    : t === 480 ? [{ type: 'cancelRun' }, { type: 'move', x: 0, y: -64 }, { type: 'steer', x: 0, y: 0 }]
    : t === 600 ? [{ type: 'startRun' }, { type: 'move', x: 0, y: 0 }]
    : [];
  return [{ player: 1, commands }];
}

export function recordGolden(): string {
  const config = loadConfig({ preset: 'alpha-default', variants: { boardingFailure: 'time-only' } });
  const map = loadMapDef(DEFAULT_MAP);
  const lines: string[] = [];
  const header: RunHeader = {
    gameVersion: gameVersion(), configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed: 'golden-1', mapId: map.id, mapHash: mapHash(map), tickRateHz: config.values.sim.tickRateHz, playerIds: [1],
    persistentAtStart: { wantedLevel: 1, bank: 120, lifetimeEarned: 450 }, startedAt: '2026-10-09T00:00:00Z',
  };
  const sim = createSim({ config, map, seed: header.seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
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
