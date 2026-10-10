import { Application, Container, Text } from 'pixi.js';
import {
  boardingCheck, commandLogWriter, commitTarget, createSim, distanceToTrain, eventLogWriter, mapHash, meterPosition, meterZones, parseCarFrame, runPhase,
  terrainAt, Terrain, type Command, type LogKind, type RunHeader, type SimEvent,
} from '@train-robber/sim';
import pkg from '../package.json';
import { download, IndexedDbLogSink } from './logSink';
import { setupFromUrl } from './setup';
import type { MapDef } from '@train-robber/config';
import { loadMap, mapIdFromUrl } from './map';
import { drawMapOverlay } from './mapOverlay';
import { createWorldView } from './worldView';
import { RingBuffer } from './ringBuffer';

const MAX_CATCHUP = 5;
/** Walking aboard uses half the move axis, so half of `player.speedTilesPerSec`; Shift runs at full. */
const WALK_AXIS = 64;
const TILE = 24;
const ZOOM_MIN = 0.1, ZOOM_MAX = 4;

const keys = new Set<string>();
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
/** One-shot actions, queued on key press and sent with the next tick. */
const ACTIONS: Record<string, 'commit' | 'jump' | 'cancel' | 'retry'> = { KeyE: 'commit', Space: 'jump', Escape: 'cancel', KeyR: 'retry' };
const pressed: ('commit' | 'jump' | 'cancel' | 'retry')[] = [];
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (ARROWS.has(e.code)) e.preventDefault();
  const a = ACTIONS[e.code];
  if (a && !e.repeat) pressed.push(a);
});
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

  const mapId = mapIdFromUrl();
  let map: MapDef;
  try {
    map = await loadMap(mapId);
  } catch (e) {
    app.stage.addChild(new Text({ text: (e as Error).message, style: { fill: '#ff8080', fontSize: 14, fontFamily: 'monospace' } })).position.set(8, 8);
    throw e;
  }
  const { config, seed } = setupFromUrl();
  const tickRateHz = config.values.sim.tickRateHz;
  const STEP_MS = 1000 / tickRateHz;
  const startedAt = new Date().toISOString();
  const header: RunHeader = {
    gameVersion: pkg.version, configHash: config.hash, preset: config.preset, variants: config.variants, overrides: config.overrides,
    seed, mapId: map.id, mapHash: mapHash(map), tickRateHz, playerIds: [1], persistentAtStart: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, startedAt,
  };
  const session = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const sink = await openSink(session, startedAt);
  const cmdLog = commandLogWriter(header, sink.writer('commands'), { hashEveryTicks: config.values.logging.hashEveryTicks });
  const recent = new RingBuffer<string>(8);
  const storeEvent = sink.writer('events');
  const evLog = eventLogWriter(header, (line) => { storeEvent(line); recent.push(line); }, { allow: config.values.logging.events });

  const sim = createSim({ config, map, seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
  let simTick = 0;
  // Dev server only: the sim on window for poking at state from the console.
  if (import.meta.env.DEV) (window as unknown as { trainRobber: unknown }).trainRobber = { sim, config };
  const endLogs = () => {
    const h = sim.hash();
    cmdLog.end(simTick, h); evLog.end(simTick, h);
    void sink.flush();
  };
  addEventListener('pagehide', endLogs);
  const exportLogs = () => {
    // The export gets an end line at the current tick so it replays on its own; the stored log continues.
    const end = JSON.stringify({ k: 'end', t: simTick, h: sim.hash() }) + '\n';
    const stamp = `${session}-t${simTick}`.replace(/[:.]/g, '-');
    void sink.read('commands').then((t) => download(`${stamp}.commands.ndjson`, t + end));
    void sink.read('events').then((t) => download(`${stamp}.events.ndjson`, t + end));
  };
  addEventListener('keydown', (e) => { if (e.code === 'KeyL' && !e.repeat) exportLogs(); });
  const button = document.createElement('button');
  button.textContent = 'Export logs';
  button.style.cssText = 'position:fixed;top:8px;right:8px;font:12px monospace;padding:4px 8px';
  button.addEventListener('click', (e) => { exportLogs(); (e.currentTarget as HTMLButtonElement).blur(); });
  document.body.appendChild(button);

  // The world is drawn top-down in tile units inside a container the camera scales and moves.
  const world = new Container();
  const mapOverlay = drawMapOverlay(map);
  const view = createWorldView();
  world.addChild(mapOverlay, view.layer);
  const overlay = new Text({ text: '', style: { fill: '#ffffff', fontSize: 12, fontFamily: 'monospace' } });
  overlay.position.set(8, 8);
  app.stage.addChild(world, overlay);
  let zoom = 1;
  addEventListener('keydown', (e) => { if (e.code === 'KeyO' && !e.repeat) mapOverlay.visible = !mapOverlay.visible; });
  addEventListener('wheel', (e) => { zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * (e.deltaY > 0 ? 0.9 : 1 / 0.9))); }, { passive: true });
  const routeText = map.routes.map((r) => `${r.id} ${r.length.toFixed(0)} tiles`).join(', ');

  let acc = 0, last = performance.now(), fps = 0, tickMs = 0;
  const variantText = Object.entries(config.variants).map(([g, id]) => `${g}:${id}`).join(' ');
  const horseCfg = config.values.horse;
  const screenSteering = horseCfg.steering === 'screen';
  const controls = `${screenSteering ? 'arrows steer  W/S throttle' : 'A/D steer  W/S throttle'}  E commit  Space jump  Esc cancel${config.values.playtest.quickRetry ? '  R quick retry' : ''}`;
  const axis = (pos: string, neg: string) => (keys.has(pos) ? 127 : 0) - (keys.has(neg) ? 127 : 0);
  const TERRAIN_NAMES = { [Terrain.Open]: 'open', [Terrain.Slow]: 'slow', [Terrain.Blocked]: 'blocked' };
  let lastMove = { x: 0, y: 0 }, lastSteer = { x: 0, y: 0 };
  // Aboard, the sim takes walking intent in the car's frame (+x toward its front, +y toward its
  // right side). The top-down view shows the car at its real angle, so turn the screen keys into
  // that frame; walking is half the axis and Shift runs at the full `player.speedTilesPerSec`.
  const walkAxes = (sx: number, sy: number, run: boolean): [number, number] => {
    const n = Math.hypot(sx, sy);
    const frame = parseCarFrame(sim.state.players[0]!.placement.frame);
    const car = frame && sim.cars().find((c) => c.trainId === frame.trainId && c.index === frame.car);
    if (n === 0 || !car) return [0, 0];
    const k = (run ? 127 : WALK_AXIS) / n;
    const fx = sx * k, fy = sy * k;
    return [Math.round(fx * car.ux + fy * car.uy), Math.round(fy * car.ux - fx * car.uy)];
  };
  let zoneSec = 0, bestZoneSec = 0;
  // Short-lived notices from events: the last rejection and how the last run ended.
  let notice = '', noticeUntil = 0;
  const show = (text: string, ms: number) => { notice = text; noticeUntil = performance.now() + ms; };
  const noticeFor = (e: SimEvent) => {
    if (e.type === 'CommandRejected') show(`${e.command} rejected: ${e.reason.toUpperCase()}`, 1500);
    else if (e.type === 'BoardingAttempt') show(`jump ${e.attempt}: ${e.result.toUpperCase()} (meter ${e.meter.toFixed(2)})`, 2000);
    else if (e.type === 'RunEnded') show(e.outcome === 'died' ? 'YOU DIED - back to the spawn' : e.retry ? 'quick retry: catch the train' : 'run cancelled', 2500);
  };
  app.ticker.add(() => {
    const now = performance.now();
    acc += now - last; last = now;
    let steps = 0;
    while (acc >= STEP_MS && steps < MAX_CATCHUP) {
      // W/S throttle in both steering variants. Heading-relative: A/D turn the horse.
      // Screen-relative: the arrow keys give a screen direction the horse turns to face;
      // the top-down view maps screen to world one to one (M4's isometric view will not).
      // Aboard, WASD walk screen-relative in both steering variants, Shift to run.
      const aboard = runPhase(sim.state) === 'aboard';
      let x = screenSteering && !aboard ? 0 : axis('KeyD', 'KeyA');
      let y = axis('KeyS', 'KeyW');
      if (aboard) [x, y] = walkAxes(x, y, keys.has('ShiftLeft') || keys.has('ShiftRight'));
      const sx = screenSteering ? axis('ArrowRight', 'ArrowLeft') : 0;
      const sy = screenSteering ? axis('ArrowDown', 'ArrowUp') : 0;
      // Commands are intents: only send one when its axes change, which keeps the log small.
      const commands: Command[] = [];
      if (x !== lastMove.x || y !== lastMove.y) commands.push({ type: 'move', x, y });
      if (sx !== lastSteer.x || sy !== lastSteer.y) commands.push({ type: 'steer', x: sx, y: sy });
      lastMove = { x, y }; lastSteer = { x: sx, y: sy };
      for (const a of pressed.splice(0)) {
        if (a === 'commit') {
          // Ask the sim which train, if any, can be committed; with none, interact gets the reason.
          const target = commitTarget(sim.state, sim.map, config, sim.state.world.horses[0]!);
          commands.push(target ? { type: 'startRun', trainId: target } : { type: 'interact', held: false });
        } else if (a === 'jump') commands.push({ type: 'jump' });
        else if (a === 'cancel') commands.push({ type: 'cancelRun' });
        else commands.push({ type: 'quickRetry' });
      }
      const inputs = [{ player: 1, commands }];
      cmdLog.step(simTick, inputs);
      const t0 = performance.now();
      const res = sim.step(inputs);
      tickMs = tickMs * 0.95 + (performance.now() - t0) * 0.05;
      simTick = res.tick;
      cmdLog.checkpoint(simTick, () => sim.hash());
      evLog.events(res.events);
      for (const e of res.events) noticeFor(e);
      acc -= STEP_MS; steps++;
    }
    if (steps === MAX_CATCHUP) acc = 0;
    const s = sim.state;
    const horse = s.world.horses[0]!;
    const player = s.players[0]!;
    const phase = runPhase(s);
    const run = s.run?.players[player.id];
    // The boarding readout is against the committed train, or the nearest one while idle.
    const readTrain = s.run?.trainId ?? [...s.world.trains].sort((a, b) => distanceToTrain(s, sim.map, config, a.id, horse.x, horse.y) - distanceToTrain(s, sim.map, config, b.id, horse.x, horse.y))[0]?.id;
    const train = s.world.trains.find((t) => t.id === readTrain);
    const check = horse.mode === 'physical' && readTrain ? boardingCheck(s, sim.map, config, readTrain, horse) : null;
    const b = config.values.boarding;
    const meter = phase === 'approach' && run
      ? { position: meterPosition(run.meter.phase), ...meterZones(run.meter, b.meter.zoneWidths), sweeping: check !== null && check.state !== 'too far', matched: check?.state === 'eligible' }
      : null;
    const frame = parseCarFrame(player.placement.frame);
    const aboardAt = frame ? sim.world.toWorld(s, player.placement) : null;
    view.update(sim.cars(), { horse: horse.mode === 'physical' ? horse : null, check, rangeTiles: b.rangeTiles, meter, aboard: aboardAt, zoom });
    // Seconds spent continuously in the boarding zone, to judge how hard it is to hold.
    if (check?.state === 'eligible') { zoneSec += app.ticker.deltaMS / 1000; bestZoneSec = Math.max(bestZoneSec, zoneSec); } else zoneSec = 0;
    // The camera keeps the world's orientation aboard, so the train runs the same way on screen.
    const focus = aboardAt ?? horse;
    world.scale.set(TILE * zoom);
    world.pivot.set(focus.x, focus.y);
    world.position.set(app.screen.width / 2, app.screen.height / 2);
    const heading = ((Math.atan2(horse.hx, -horse.hy) * 180) / Math.PI + 360) % 360;
    const target = phase === 'idle' ? commitTarget(s, sim.map, config, horse) : null;
    fps = fps * 0.9 + app.ticker.FPS * 0.1;
    overlay.text = [
      `tick ${s.tick}  tick time ${tickMs.toFixed(3)} ms  fps ${fps.toFixed(0)}`,
      `seed ${seed}  config ${config.hash}  state ${sim.hash()}`,
      `preset ${config.preset}  ${variantText}`,
      `map ${map.id} ${map.size.cols}x${map.size.rows}  route ${routeText}`,
      `horse ${horse.speed.toFixed(2)} tiles/s${horseCfg.throttleModel === 'cruise' ? ` (target ${horse.cruiseTarget.toFixed(2)})` : ''}  heading ${heading.toFixed(0)}°  at ${horse.x.toFixed(1)}, ${horse.y.toFixed(1)} on ${TERRAIN_NAMES[terrainAt(sim.map, horse.x, horse.y)]}`,
      `run: ${phase.toUpperCase()}${s.run ? `  train ${s.run.trainId}  health ${run?.health ?? '-'}/${config.values.health.max}  jumps ${run?.boardingAttempts ?? 0}` : ''}${run && run.stumbleTicks > 0 ? '  STUMBLE' : ''}${horse.stunTicks > 0 ? `  STUNNED ${(horse.stunTicks / tickRateHz).toFixed(1)} s` : ''}`,
      target ? `>>> E: commit to ${target} <<<` : phase === 'idle' ? 'ride within commit range of a train to commit' : phase === 'aboard' ? `aboard ${player.placement.frame} at cell ${player.placement.x.toFixed(1)}, ${player.placement.y.toFixed(1)}  WASD walk, Shift run` : '',
      check ? `boarding: ${check.state.toUpperCase()}  ${check.side} side  door ${Number.isFinite(check.distance) ? check.distance.toFixed(1) : '-'} tiles (range ${b.rangeTiles})  speed vs train ${check.speedDelta >= 0 ? '+' : ''}${check.speedDelta.toFixed(2)} (±${b.speedToleranceTilesPerSec})  in zone ${zoneSec.toFixed(1)} s, best ${bestZoneSec.toFixed(1)} s` : 'boarding: -',
      meter ? `meter ${meter.position.toFixed(2)}${!meter.sweeping ? ' (parked: ride within range of a door)' : meter.matched ? ' (speed matched: slow)' : ' (speed off: fast)'}  good ${meter.good[0].toFixed(2)}-${meter.good[1].toFixed(2)}  perfect ${meter.perfect[0].toFixed(2)}-${meter.perfect[1].toFixed(2)}` : '',
      performance.now() < noticeUntil ? `!! ${notice}` : '',
      `steering ${horseCfg.steering}  throttle ${horseCfg.throttleModel}${train ? `  train ${train.id} at ${train.d.toFixed(1)} tiles, ${config.values.trains[train.type]!.speedTilesPerSec} tiles/s` : ''}`,
      `${controls}  wheel zooms (${zoom.toFixed(2)}x)  O map overlay ${mapOverlay.visible ? 'on' : 'off'}  L or the button exports logs`,
      ...(recent.toArray().length ? ['recent events:', ...recent.toArray().slice(-4)] : []),
    ].join('\n');
  });
}
void boot();
