import { Application, Graphics, Text } from 'pixi.js';
import { commandLogWriter, createSim, eventLogWriter, type Command, type LogKind, type RunHeader } from '@train-robber/sim';
import pkg from '../package.json';
import { download, IndexedDbLogSink } from './logSink';
import { setupFromUrl } from './setup';

const MAX_CATCHUP = 5;
const TILE = 24;

const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));

async function openSink(session: string, startedAt: string): Promise<{ writer(log: LogKind): (line: string) => void; read(log: LogKind): Promise<string>; flush(): Promise<void> }> {
  try {
    return await IndexedDbLogSink.open(session, startedAt);
  } catch (e) {
    // Private windows can refuse IndexedDB; keep the session in memory instead.
    console.warn('IndexedDB unavailable, logging to memory', e);
    const mem: Record<LogKind, string[]> = { commands: [], events: [] };
    return { writer: (log) => (line) => void mem[log].push(line), read: async (log) => mem[log].join('\n') + '\n', flush: async () => {} };
  }
}

async function boot() {
  const app = new Application();
  await app.init({ resizeTo: window, background: '#2b3a2b', antialias: true });
  document.body.appendChild(app.canvas);

  const { config, seed } = setupFromUrl();
  const tickRateHz = config.values.sim.tickRateHz;
  const STEP_MS = 1000 / tickRateHz;
  const startedAt = new Date().toISOString();
  const header: RunHeader = {
    gameVersion: pkg.version, configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed, tickRateHz, playerIds: [1], persistentAtStart: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, startedAt,
  };
  const session = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const sink = await openSink(session, startedAt);
  const cmdLog = commandLogWriter(header, sink.writer('commands'), { hashEveryTicks: config.values.logging.hashEveryTicks });
  const evLog = eventLogWriter(header, sink.writer('events'), { allow: config.values.logging.events });

  const sim = createSim({ config, seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
  let simTick = 0;
  const endLogs = () => {
    const h = sim.hash();
    cmdLog.end(simTick, h); evLog.end(simTick, h);
    void sink.flush();
  };
  addEventListener('pagehide', endLogs);
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyL' || e.repeat) return;
    // The export gets an end line at the current tick so it replays on its own; the stored log continues.
    const end = JSON.stringify({ k: 'end', t: simTick, h: sim.hash() }) + '\n';
    const stamp = `${session}-t${simTick}`.replace(/[:.]/g, '-');
    void sink.read('commands').then((t) => download(`${stamp}.commands.ndjson`, t + end));
    void sink.read('events').then((t) => download(`${stamp}.events.ndjson`, t + end));
  });

  const player = new Graphics().circle(0, 0, 8).fill(0xffd34d);
  const overlay = new Text({ text: '', style: { fill: '#ffffff', fontSize: 12, fontFamily: 'monospace' } });
  overlay.position.set(8, 8);
  app.stage.addChild(player, overlay);

  let acc = 0, last = performance.now(), fps = 0, tickMs = 0;
  const variantText = Object.entries(config.variants).map(([g, id]) => `${g}:${id}`).join(' ');
  let lastMove = { x: 0, y: 0 };
  app.ticker.add(() => {
    const now = performance.now();
    acc += now - last; last = now;
    let steps = 0;
    while (acc >= STEP_MS && steps < MAX_CATCHUP) {
      const x = (keys.has('KeyD') ? 127 : 0) - (keys.has('KeyA') ? 127 : 0);
      const y = (keys.has('KeyS') ? 127 : 0) - (keys.has('KeyW') ? 127 : 0);
      // Commands are intents: only send a move when the axes change, which keeps the log small.
      const commands: Command[] = x !== lastMove.x || y !== lastMove.y ? [{ type: 'move', x, y }] : [];
      lastMove = { x, y };
      const inputs = [{ player: 1, commands }];
      cmdLog.step(simTick, inputs);
      const t0 = performance.now();
      const res = sim.step(inputs);
      tickMs = tickMs * 0.95 + (performance.now() - t0) * 0.05;
      simTick = res.tick;
      cmdLog.checkpoint(simTick, () => sim.hash());
      evLog.events(res.events);
      acc -= STEP_MS; steps++;
    }
    if (steps === MAX_CATCHUP) acc = 0;
    const s = sim.snapshot();
    const p = s.players[0]!;
    player.position.set(app.screen.width / 2 + p.x * TILE, app.screen.height / 2 + p.y * TILE);
    fps = fps * 0.9 + app.ticker.FPS * 0.1;
    overlay.text = [
      `tick ${s.tick}  tick time ${tickMs.toFixed(3)} ms  fps ${fps.toFixed(0)}`,
      `seed ${seed}  config ${config.hash}  state ${sim.hash()}`,
      `preset ${config.preset}  ${variantText}`,
      'WASD to move  L to download logs',
    ].join('\n');
  });
}
void boot();
