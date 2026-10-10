import { createApp, createGameClient, showFatal } from '@train-robber/client';
import { commandLogWriter, createSim, eventLogWriter, mapHash, type LogKind, type RunHeader } from '@train-robber/sim';
import pkg from '../package.json';
import { download, IndexedDbLogSink } from './logSink';
import { setupFromUrl } from './setup';
import type { MapDef } from '@train-robber/config';
import { loadMap, mapIdFromUrl } from './map';
import { RingBuffer } from './ringBuffer';
import { createRunTracker, type RunRecord } from './runTracker';
import { getTester } from './tester';

const MAX_CATCHUP = 5;

interface Sink { writer(log: LogKind): (line: string) => void; read(log: LogKind): Promise<string>; flush(): Promise<void>; saveRun?(run: RunRecord): void }

async function openSink(session: string, startedAt: string): Promise<Sink> {
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
  const app = await createApp();

  const mapId = mapIdFromUrl();
  let map: MapDef;
  try {
    map = await loadMap(mapId);
  } catch (e) {
    showFatal(app, (e as Error).message);
    throw e;
  }
  const { config, seed } = setupFromUrl();
  const tickRateHz = config.values.sim.tickRateHz;
  const STEP_MS = 1000 / tickRateHz;
  const startedAt = new Date().toISOString();
  const header: RunHeader = {
    gameVersion: pkg.version, configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed, mapId: map.id, mapHash: mapHash(map), tickRateHz, playerIds: [1], persistentAtStart: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, startedAt,
    config: config.values, url: location.search,
  };
  const session = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const sink = await openSink(session, startedAt);
  const cmdLog = commandLogWriter(header, sink.writer('commands'), { hashEveryTicks: config.values.logging.hashEveryTicks });
  const recent = new RingBuffer<string>(8);
  const storeEvent = sink.writer('events');
  const evLog = eventLogWriter(header, (line) => { storeEvent(line); recent.push(line); }, { allow: config.values.logging.events });

  const tracker = createRunTracker({
    session, tester: getTester(), gameVersion: header.gameVersion, configHash: header.configHash, preset: header.preset, variants: header.variants,
    seed, mapId: header.mapId, url: location.search, tickRateHz,
  });
  const saveRun = (run: RunRecord | null) => { if (run) sink.saveRun?.(run); };

  const sim = createSim({ config, map, seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
  let simTick = 0;
  // Dev server only: the sim on window for poking at state from the console.
  if (import.meta.env.DEV) (window as unknown as { trainRobber: unknown }).trainRobber = { sim, config };
  const endLogs = () => {
    saveRun(tracker.abandon(simTick, new Date().toISOString()));
    const h = sim.hash();
    cmdLog.end(simTick, h); evLog.end(simTick, h);
    void sink.flush();
  };
  addEventListener('pagehide', endLogs);
  // Comments go into both logs at the current tick, so they travel with whichever file is shared.
  const note = (question: string) => {
    const text = prompt(question)?.trim();
    if (text) { cmdLog.note(simTick, text); evLog.note(simTick, text); saveRun(tracker.note(simTick, text)); }
  };
  const addNote = () => note(`Note at tick ${simTick}:`);
  const exportLogs = () => {
    note('Comment on this run (optional), saved in the exported logs:');
    // The export gets an end line at the current tick so it replays on its own; the stored log continues.
    const end = JSON.stringify({ k: 'end', t: simTick, h: sim.hash() }) + '\n';
    const stamp = `${session}-t${simTick}`.replace(/[:.]/g, '-');
    // NDJSON inside, but .log so GitHub accepts the files as issue and PR attachments.
    void sink.read('commands').then((t) => download(`${stamp}.commands.log`, t + end));
    void sink.read('events').then((t) => download(`${stamp}.events.log`, t + end));
  };
  const button = document.createElement('button');
  button.textContent = 'Export logs';
  button.style.cssText = 'position:fixed;top:8px;right:8px;font:12px monospace;padding:4px 8px;z-index:1';
  button.addEventListener('click', (e) => { exportLogs(); client.releaseKeys(); (e.currentTarget as HTMLButtonElement).blur(); });
  document.body.appendChild(button);
  const history = document.createElement('a');
  history.textContent = 'Playtests';
  history.href = 'playtests.html';
  history.target = '_blank';
  history.style.cssText = 'position:fixed;top:8px;right:110px;font:12px monospace;padding:4px 8px;z-index:1;background:#eee;color:#111;text-decoration:none;border:1px solid #888';
  document.body.appendChild(history);

  // The client draws the sim and turns keys into commands; this loop only steps the sim at a fixed rate.
  const client = createGameClient(app, { sim, map, config, onExportLogs: exportLogs, onAddNote: addNote });
  let acc = 0, last = performance.now(), fps = 0, tickMs = 0;
  app.ticker.add(() => {
    const now = performance.now();
    acc += now - last; last = now;
    let steps = 0;
    while (acc >= STEP_MS && steps < MAX_CATCHUP) {
      const inputs = [{ player: 1, commands: client.poll() }];
      cmdLog.step(simTick, inputs);
      const t0 = performance.now();
      const res = sim.step(inputs);
      tickMs = tickMs * 0.95 + (performance.now() - t0) * 0.05;
      simTick = res.tick;
      cmdLog.checkpoint(simTick, () => sim.hash());
      evLog.events(res.events);
      if (res.events.length) for (const run of tracker.events(res.events, new Date().toISOString())) saveRun(run);
      client.afterTick(res.events);
      acc -= STEP_MS; steps++;
    }
    if (steps === MAX_CATCHUP) acc = 0;
    fps = fps * 0.9 + app.ticker.FPS * 0.1;
    client.render(acc / STEP_MS, { fps, tickMs, seed, recentEvents: recent.toArray() });
  });
}
void boot();
