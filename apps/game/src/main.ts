import { createApp, createCarScene, createGameClient, showFatal } from '@train-robber/client';
import { commandLogWriter, createSim, eventLogWriter, mapHash, type LogKind, type RunHeader, type SimEvent } from '@train-robber/sim';
import pkg from '../package.json';
import { download, IndexedDbLogSink } from './logSink';
import { setupFromUrl } from './setup';
import type { MapDef, SceneryDef } from '@train-robber/config';
import { mapIdFromUrl, sessionMap } from './map';
import { RingBuffer } from './ringBuffer';
import { createRunTracker, type RunRecord } from './runTracker';
import { getTester } from './tester';
import { installLogDrop, replaySourceFromUrl } from './logDrop';
import { bootReplay } from './replay';
import { addToLeaderboard, LocalStorageStore, type KeyValueStorage, type LoadResult, type SaveData } from './save';
import { installLeaveNotes, leaveNotesEnabled, type LeaveNotes } from './leaveNotes';

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

/** localStorage, or an in-memory stand-in when the browser blocks it (the save then lasts this page only). */
function saveStorage(): KeyValueStorage {
  try { if (window.localStorage) return window.localStorage; } catch { /* blocked site data */ }
  const mem = new Map<string, string>();
  return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
}

/**
 * `?resetSave=1` (G28): confirm, then wipe the save. The parameter is taken off the URL either way,
 * so a reload does not ask again.
 */
async function resetSaveFromUrl(store: LocalStorageStore): Promise<boolean> {
  const q = new URLSearchParams(location.search);
  if (q.get('resetSave') !== '1') return false;
  q.delete('resetSave');
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
  if (!confirm('Reset save? This sets wanted level, bank and lifetime earned back to 0 and clears the local leaderboard.')) return false;
  await store.reset();
  return true;
}

async function boot() {
  const app = await createApp();
  // Dropping a .commands.log anywhere on the page opens it in the replay viewer.
  installLogDrop();
  const replay = replaySourceFromUrl();
  if (replay) return bootReplay(app, replay);

  // ?car=<id>: one car template on its own, for checking a layout made in Tiled.
  const carId = new URLSearchParams(location.search).get('car');
  if (carId !== null) return createCarScene(app, setupFromUrl().config, carId);

  let setup: ReturnType<typeof setupFromUrl>;
  try {
    setup = setupFromUrl();
  } catch (e) {
    // A typo in ?preset=, ?v= or ?set= names the bad value on screen instead of a blank page.
    showFatal(app, `Bad setup in the URL: ${(e as Error).message}`);
    throw e;
  }
  // ?map=gen builds the map from the run seed, so the seed in the debug panel and the log replays it.
  const mapId = mapIdFromUrl();
  let map: MapDef, scenery: SceneryDef | null;
  try {
    ({ map, scenery } = await sessionMap(mapId, setup.seed, setup.config));
  } catch (e) {
    showFatal(app, (e as Error).message);
    throw e;
  }
  const { config, seed } = setup;
  // The save (phase 2 M5): wanted level, bank, lifetime earned and the local leaderboard.
  const store = new LocalStorageStore(saveStorage());
  const wasReset = await resetSaveFromUrl(store);
  const loaded: LoadResult = await store.load();
  let save: SaveData = loaded.data;
  const tickRateHz = config.values.sim.tickRateHz;
  const STEP_MS = 1000 / tickRateHz;
  const startedAt = new Date().toISOString();
  const header: RunHeader = {
    gameVersion: pkg.version, configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed, mapId: map.id, mapHash: mapHash(map), tickRateHz, playerIds: [1], persistentAtStart: { ...save.persistent }, startedAt,
    config: config.values, url: location.search,
  };
  const session = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const sink = await openSink(session, startedAt);
  const cmdLog = commandLogWriter(header, sink.writer('commands'), { hashEveryTicks: config.values.logging.hashEveryTicks });
  const recent = new RingBuffer<string>(8);
  const storeEvent = sink.writer('events');
  const evLog = eventLogWriter(header, (line) => { storeEvent(line); recent.push(line); }, { allow: config.values.logging.events });

  const tracker = createRunTracker({
    session, tester: getTester(), gameVersion: header.gameVersion, configHash: header.configHash, preset: header.preset, variants: header.variants, overrides: header.overrides,
    seed, mapId: header.mapId, url: location.search, tickRateHz, saveId: save.saveId,
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
  const saveNote = (text: string) => {
    cmdLog.note(simTick, text); evLog.note(simTick, text); saveRun(tracker.note(simTick, text, new Date().toISOString()));
    leave?.noted();
  };
  const note = (question: string) => {
    const text = prompt(question)?.trim();
    if (text) saveNote(text);
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

  // Closing the tab after a run asks for notes (?leaveNotes=off turns it off).
  const leave: LeaveNotes | null = leaveNotesEnabled(location.search) ? installLeaveNotes(saveNote, () => client.releaseKeys()) : null;

  // The client draws the sim and turns keys into commands; this loop only steps the sim at a fixed rate.
  const resetSave = () => {
    if (!confirm('Reset save? This sets wanted level, bank and lifetime earned back to 0 and clears the local leaderboard. The page reloads.')) return;
    // Nothing more is saved from this page: the reload starts from the empty save.
    saving = false;
    void store.reset().then(() => location.reload());
  };
  const client = createGameClient(app, {
    sim, map, scenery, config, onExportLogs: exportLogs, onAddNote: addNote,
    bestRuns: () => save.leaderboard, debugActions: [{ label: 'Reset save', run: resetSave }],
  });
  if (loaded.problem) {
    client.notify(`Your save ${loaded.problem === 'newer' ? 'is from a newer version of the game' : 'could not be read'}: it was backed up (${loaded.backupKey}) and reset`, 'bad', 8000);
  } else if (wasReset) client.notify('Save reset: wanted level, bank and leaderboard are back to 0', 'info', 4000);
  // Retired config keys or presets in the URL (M6b) load with a warning instead of failing.
  if (config.warnings.length) client.notify(`Config: ${config.warnings.join('; ')}`, 'info', 6000);

  // Save at each run end (PersistentChanged). Practice runs (wanted.forceLevel) save nothing (G9).
  let saving = true;
  let runInfo = { trainId: '', wantedLevel: 0 };
  let banked: { score: number; outcome: string } | null = null;
  const persist = (events: readonly SimEvent[]) => {
    for (const e of events) {
      if (e.type === 'RunStarted') runInfo = { trainId: e.trainId, wantedLevel: e.wantedLevel };
      else if (e.type === 'RunEnded') banked = e.practice ? null : { score: e.cashOut, outcome: e.outcome };
      else if (e.type === 'PersistentChanged' && !e.practice && saving) {
        let leaderboard = save.leaderboard;
        if (banked) {
          leaderboard = addToLeaderboard(leaderboard, {
            score: banked.score, seed, configHash: config.hash, preset: config.preset, variants: config.variants, date: new Date().toISOString(),
            gameVersion: header.gameVersion, outcome: banked.outcome, trainId: runInfo.trainId, mapId: map.id, wantedLevel: runInfo.wantedLevel,
          });
        }
        banked = null;
        save = { ...save, persistent: { ...e.after }, leaderboard };
        void store.save(save);
      } else if (e.type === 'WantedDecayed' && !e.practice && saving) {
        // A new day's wanted decay (M6b) is saved too.
        save = { ...save, persistent: { ...save.persistent, wantedLevel: e.to } };
        void store.save(save);
      }
    }
  };
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
      if (res.events.length) {
        persist(res.events);
        for (const run of tracker.events(res.events, new Date().toISOString())) saveRun(run);
        if (res.events.some((e) => e.type === 'RunStarted')) leave?.runStarted();
      }
      client.afterTick(res.events);
      acc -= STEP_MS; steps++;
    }
    if (steps === MAX_CATCHUP) acc = 0;
    fps = fps * 0.9 + app.ticker.FPS * 0.1;
    client.render(acc / STEP_MS, { fps, tickMs, seed, recentEvents: recent.toArray() });
  });
}
void boot();
