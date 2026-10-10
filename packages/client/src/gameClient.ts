// The game client: draws the sim (isometric by default, top-down with V), maps the keyboard into
// commands, and keeps the HUD. It reads sim state and events and never decides an outcome.
import { Application, Container, Text } from 'pixi.js';
import {
  boardingCheck, carToWorld, commitTarget, distanceToTrain, trainSpeed, meterPosition, meterZones, parseCarFrame, runPhase, terrainAt, Terrain,
  type Command, type Sim, type SimEvent,
} from '@train-robber/sim';
import type { MapDef, ResolvedConfig } from '@train-robber/config';
import { InputMapper, KeyboardSource, worldDirToCar, type MapContext, type ViewAction } from './input';
import { Interpolator } from './interp';
import { follow, FOLLOW_RATE, lookAheadTarget } from './camera';
import { clampZoom, DEFAULT_ZOOM, isoX, isoY, keyDirToWorld, stepZoom, worldToScreen, type Camera } from './projection';
import { createWorldScene } from './iso/worldScene';
import { createScreenOverlay, type MeterView, type TrainPointer } from './screenOverlay';
import { createHud } from './hud';
import { createWorldView } from './topdown/worldView';
import { drawMapOverlay } from './topdown/mapOverlay';

/** Pixels per tile in the top-down debug view at zoom 1 (as before M4, so zoom values mean the same there). */
export type ViewMode = 'iso' | 'topdown';

const TOPDOWN_PX = 24;
/**
 * Committing to a train locks the zoom until the run ends, aboard too (Devlin, 2026-10-10): the
 * wheel and zoom keys do nothing during a run, and the riding zoom comes back after it. Devlin
 * picked 1.75 in the top-down view and 1 in iso; `?runZoom=` overrides both for playtests.
 */
export const RUN_ZOOM: Record<ViewMode, number> = { iso: 1, topdown: 1.75 };
/** How fast the shown zoom closes on its target, per second (about 0.7 s to settle). */
const ZOOM_RATE = 5;
/** A camera target this far away (a reset or a quick retry) snaps instead of easing. */
const SNAP_TILES = 30;


/** Numbers only the host knows, for the debug readout. */
export interface HostStats {
  fps: number;
  tickMs: number;
  seed: string;
  recentEvents: readonly string[];
}

export interface GameClient {
  readonly app: Application;
  /** This tick's commands from the keyboard. */
  poll(): Command[];
  /** After each sim step: record positions for interpolation and read the events. */
  afterTick(events: readonly SimEvent[]): void;
  /** Draw a frame `alpha` of the way from the previous tick to the current one. */
  render(alpha: number, host: HostStats): void;
}

export async function createApp(): Promise<Application> {
  const app = new Application();
  await app.init({ resizeTo: window, background: '#1e2a1c', antialias: true });
  document.body.appendChild(app.canvas);
  return app;
}

/** Show an error on the canvas, for a map that failed to load. */
export function showFatal(app: Application, message: string): void {
  app.stage.addChild(new Text({ text: message, style: { fill: '#ff8080', fontSize: 14, fontFamily: 'monospace' } })).position.set(8, 8);
}

const params = new URLSearchParams(location.search);
const runZoomParam = Number(params.get('runZoom'));
const runZoom = (mode: ViewMode) => clampZoom(runZoomParam > 0 ? runZoomParam : RUN_ZOOM[mode]);

export function createGameClient(app: Application, opts: { sim: Sim; map: MapDef; config: ResolvedConfig; onExportLogs(): void }): GameClient {
  const { sim, map, config } = opts;
  const b = config.values.boarding;
  const horseCfg = config.values.horse;
  const tickRateHz = config.values.sim.tickRateHz;

  // Toggles; the view can start top-down with ?view=topdown.
  let mode: ViewMode = params.get('view') === 'topdown' ? 'topdown' : 'iso';
  let zoom = DEFAULT_ZOOM;
  let showDebug = true;
  let zoomLocked = false, ridingZoom = zoom;
  // The zoom on screen eases toward `zoom`, so committing, the run ending and zoom keys never jump.
  let shownZoom = zoom;

  // Isometric scenes.
  const isoWorld = createWorldScene(map);
  // Top-down debug view.
  const topdown = new Container();
  const topdownOverlay = drawMapOverlay(map);
  const topdownView = createWorldView();
  topdown.addChild(topdownOverlay, topdownView.layer);
  const overlay = createScreenOverlay();
  app.stage.addChild(isoWorld.root, topdown, overlay.root);
  const hud = createHud();

  const onView = (a: ViewAction) => {
    if (a === 'zoomIn' || a === 'zoomOut') { if (!zoomLocked) zoom = stepZoom(zoom, a === 'zoomIn' ? 1 : -1); }
    else if (a === 'toggleView') { mode = mode === 'iso' ? 'topdown' : 'iso'; if (zoomLocked) zoom = runZoom(mode); }
    else if (a === 'toggleMapOverlay') { const o = mode === 'iso' ? isoWorld.mapOverlay : topdownOverlay; o.visible = !o.visible; }
    else if (a === 'toggleZones') isoWorld.zoneOverlay.visible = topdownView.zones.visible = !topdownView.zones.visible;
    else if (a === 'toggleDebug') showDebug = !showDebug;
    else opts.onExportLogs();
  };
  // O toggles the active view's map overlay. The top-down one starts on (it is that view's only
  // terrain); the iso one starts off, since the iso view draws the ground and track itself.
  const keyboard = new KeyboardSource(onView);
  addEventListener('wheel', (e) => { if (!zoomLocked) zoom = clampZoom(zoom * (e.deltaY > 0 ? 0.9 : 1 / 0.9)); }, { passive: true });
  const mapper = new InputMapper();
  const interp = new Interpolator();
  interp.push(sim.state, sim.cars());

  const carOf = (frame: string) => {
    const f = parseCarFrame(frame);
    return f ? sim.cars().find((c) => c.trainId === f.trainId && c.index === f.car) ?? null : null;
  };
  const ctx: MapContext = {
    get steering() { return horseCfg.steering; },
    get aboard() { return runPhase(sim.state) === 'aboard'; },
    keyDirToWorld(dx, dy) {
      if (mode === 'iso') return keyDirToWorld(dx, dy);
      const n = Math.hypot(dx, dy);
      return n === 0 ? [0, 0] : [dx / n, dy / n];
    },
    keyDirToCar(dx, dy) {
      // Both views show the car at its real angle in the world, so turn the key's world direction into the car's axes.
      const car = carOf(sim.state.players[0]!.placement.frame);
      if (!car) return null;
      return worldDirToCar(...ctx.keyDirToWorld(dx, dy), car);
    },
    commitTarget: () => commitTarget(sim.state, sim.map, config, sim.state.world.horses[0]!),
  };

  // Notices from events: the last rejection, jump result or run end.
  let notice = '', noticeKind: 'bad' | 'good' | 'info' = 'info', noticeUntil = 0;
  const show = (text: string, kind: typeof noticeKind, ms: number) => { notice = text; noticeKind = kind; noticeUntil = performance.now() + ms; };
  const noticeFor = (e: SimEvent) => {
    if (e.type === 'CommandRejected') show(`${e.command}: ${e.reason}`, 'bad', 1500);
    else if (e.type === 'BoardingAttempt') show(`jump ${e.attempt}: ${e.result}${e.result === 'fail' ? ' - thrown clear' : ''}`, e.result === 'fail' ? 'bad' : 'good', 2000);
    else if (e.type === 'RunEnded') show(e.outcome === 'died' ? 'You died - back to the spawn' : e.retry ? 'Quick retry: catch the train' : 'Run cancelled', e.outcome === 'died' ? 'bad' : 'info', 2500);
  };

  const cam = { x: sim.state.world.horses[0]!.x, y: sim.state.world.horses[0]!.y };
  let zoneSec = 0, bestZoneSec = 0;
  const routeText = map.routes.map((r) => `${r.id} ${r.length.toFixed(0)} tiles`).join(', ');
  const variantText = Object.entries(config.variants).map(([g, id]) => `${g}:${id}`).join(' ');
  const TERRAIN_NAMES = { [Terrain.Open]: 'open', [Terrain.Slow]: 'slow', [Terrain.Blocked]: 'blocked' };
  const controls = [
    horseCfg.steering === 'screen' ? 'arrows steer, W/S throttle' : 'A/D steer, W/S throttle',
    'E commit', 'Space jump', 'Esc cancel', ...(config.values.playtest.quickRetry ? ['R quick retry'] : []),
    'Q/Z zoom', 'V view', 'O map', 'B zones', '` debug', 'L logs',
  ].join('  ·  ');

  return {
    app,
    poll: () => mapper.commands(keyboard.poll(), ctx),
    afterTick(events) {
      interp.push(sim.state, sim.cars());
      for (const e of events) noticeFor(e);
    },
    render(alpha, host) {
      const now = performance.now();
      const dt = app.ticker.deltaMS / 1000;
      const s = sim.state;
      const horseState = s.world.horses[0]!;
      const player = s.players[0]!;
      const phase = runPhase(s);
      const run = s.run?.players[player.id];
      const physical = horseState.mode === 'physical';
      // The boarding readout is against the committed train, or the nearest one while idle.
      const readTrain = s.run?.trainId ?? [...s.world.trains].sort((a, c) => distanceToTrain(s, sim.map, config, a.id, horseState.x, horseState.y) - distanceToTrain(s, sim.map, config, c.id, horseState.x, horseState.y))[0]?.id ?? null;
      const check = physical && readTrain ? boardingCheck(s, sim.map, config, readTrain, horseState) : null;
      const meter: MeterView | null = phase === 'approach' && run
        ? { position: meterPosition(run.meter.phase), ...meterZones(run.meter, b.meter.zoneWidths), sweeping: check !== null && check.state !== 'too far', matched: check?.state === 'eligible' }
        : null;
      if (check?.state === 'eligible') { zoneSec += dt; bestZoneSec = Math.max(bestZoneSec, zoneSec); } else zoneSec = 0;

      const cars = interp.cars(alpha);
      const horse = physical ? interp.horse(alpha) : null;
      const placement = interp.placement(alpha);
      const frame = parseCarFrame(placement.frame);
      const aboardCar = frame ? cars.find((c) => c.trainId === frame.trainId && c.index === frame.car) ?? null : null;
      const aboardAt = aboardCar ? carToWorld(aboardCar, placement.x, placement.y) : null;
      // A run (committed, boarding or aboard) locks the zoom; idle gives the riding zoom back.
      if ((phase !== 'idle') !== zoomLocked) {
        zoomLocked = phase !== 'idle';
        if (zoomLocked) { ridingZoom = zoom; zoom = runZoom(mode); } else zoom = ridingZoom;
      }

      // Camera: lead the horse along its velocity. Aboard, follow the player, leading by the
      // train's velocity just enough that the ease does not trail behind the moving car.
      const camTarget = horse ? lookAheadTarget(horse.x, horse.y, horse.hx, horse.hy, horseState.speed)
        : aboardAt && aboardCar ? (() => {
          const v = trainSpeed(config, s.world.trains.find((t) => t.id === aboardCar.trainId)?.type ?? 'blank') / FOLLOW_RATE;
          return { x: aboardAt.x + aboardCar.ux * v, y: aboardAt.y + aboardCar.uy * v };
        })() : null;
      if (camTarget) follow(cam, camTarget, dt, Math.hypot(camTarget.x - cam.x, camTarget.y - cam.y) > SNAP_TILES);
      const W = app.screen.width, H = app.screen.height;
      shownZoom *= (zoom / shownZoom) ** (1 - Math.exp(-ZOOM_RATE * dt));
      if (Math.abs(shownZoom / zoom - 1) < 1e-3) shownZoom = zoom;
      const camera: Camera = { x: cam.x, y: cam.y, zoom: shownZoom, width: W, height: H };

      const iso = mode === 'iso';
      isoWorld.root.visible = iso;
      topdown.visible = !iso;
      let project: (x: number, y: number, z: number) => { x: number; y: number };

      if (iso) {
        // Aboard, the world view stays: the player's car is drawn open and they walk inside it.
        isoWorld.update({
          cars, horse, stunned: horseState.stunTicks > 0, check, trainId: readTrain, rangeTiles: b.rangeTiles, timeSec: now / 1000,
          aboard: aboardCar && aboardAt ? { trainId: aboardCar.trainId, index: aboardCar.index, ...aboardAt } : null,
        });
        isoWorld.root.scale.set(shownZoom);
        isoWorld.root.pivot.set(isoX(cam.x, cam.y), isoY(cam.x, cam.y));
        isoWorld.root.position.set(W / 2, H / 2);
        project = (x, y, z) => worldToScreen(x, y, z, camera);
      } else {
        // Top-down keeps the world's orientation; aboard, it follows the player's place on the car.
        topdownView.update(cars, { horse, check, rangeTiles: b.rangeTiles, aboard: aboardAt });
        topdown.scale.set(TOPDOWN_PX * shownZoom);
        topdown.pivot.set(cam.x, cam.y);
        topdown.position.set(W / 2, H / 2);
        project = (x, y) => ({ x: (x - cam.x) * TOPDOWN_PX * shownZoom + W / 2, y: (y - cam.y) * TOPDOWN_PX * shownZoom + H / 2 });
      }

      // Screen-space cues: meter and speed above the horse, arrows to trains off screen.
      const trains: TrainPointer[] = [];
      if (horse) {
        for (const t of s.world.trains) {
          let best = cars.find((c) => c.trainId === t.id), bestD = Infinity;
          for (const c of cars) {
            if (c.trainId !== t.id) continue;
            const d = Math.hypot(c.x - horse.x, c.y - horse.y);
            if (d < bestD) { bestD = d; best = c; }
          }
          if (!best) continue;
          const p = project(best.x, best.y, 1);
          trains.push({ id: t.id, sx: p.x, sy: p.y, distanceTiles: distanceToTrain(s, sim.map, config, t.id, horseState.x, horseState.y), committed: s.run?.trainId === t.id });
        }
      }
      overlay.update({
        width: W, height: H,
        horse: horse ? project(horse.x, horse.y, iso ? 2.2 : 0) : null,
        meter, check, toleranceTilesPerSec: b.speedToleranceTilesPerSec, showSpeed: phase === 'approach', trains,
      });

      // HUD.
      const target = phase === 'idle' ? commitTarget(s, sim.map, config, horseState) : null;
      const prompt = phase === 'idle'
        ? target ? `E: commit to ${target}` : `Ride within ${config.values.commit.rangeTiles} tiles of the train to commit`
        : phase === 'approach' ? check && check.state !== 'too far' ? 'Space: jump!' : 'Ride beside a door and match the train\'s speed'
          : phase === 'boarding' ? 'Thrown clear: the horse is stunned'
            : phase === 'aboard' ? `Aboard car ${aboardCar?.index ?? '?'}: WASD walk, Shift run` : '';
      const heading = ((Math.atan2(horseState.hx, -horseState.hy) * 180) / Math.PI + 360) % 360;
      const train = s.world.trains.find((t) => t.id === readTrain);
      hud.update({
        phase,
        health: run ? { now: run.health, max: config.values.health.max } : null,
        prompt,
        notice: now < noticeUntil ? notice : '',
        noticeKind,
        controls,
        debug: !showDebug ? null : [
          `tick ${s.tick}  tick time ${host.tickMs.toFixed(3)} ms  fps ${host.fps.toFixed(0)}`,
          `seed ${host.seed}  config ${config.hash}  state ${sim.hash()}`,
          `preset ${config.preset}  ${variantText}`,
          `map ${map.id} ${map.size.cols}x${map.size.rows}  route ${routeText}`,
          `view ${mode} (V)  zoom ${zoom.toFixed(2)}x${zoomLocked ? ' (locked for the run)' : ''}  map overlay ${(iso ? isoWorld.mapOverlay : topdownOverlay).visible ? 'on' : 'off'} (O)  zones ${topdownView.zones.visible ? 'on' : 'off'} (B)`,
          `horse ${horseState.speed.toFixed(2)} tiles/s${horseCfg.throttleModel === 'cruise' ? ` (target ${horseState.cruiseTarget.toFixed(2)})` : ''}  heading ${heading.toFixed(0)}°  at ${horseState.x.toFixed(1)}, ${horseState.y.toFixed(1)} on ${TERRAIN_NAMES[terrainAt(sim.map, horseState.x, horseState.y)]}`,
          `run: ${phase.toUpperCase()}${s.run ? `  train ${s.run.trainId}  jumps ${run?.boardingAttempts ?? 0}` : ''}${run && run.stumbleTicks > 0 ? '  STUMBLE' : ''}${horseState.stunTicks > 0 ? `  STUNNED ${(horseState.stunTicks / tickRateHz).toFixed(1)} s` : ''}${phase === 'aboard' ? `  at ${player.placement.frame} cell ${player.placement.x.toFixed(1)}, ${player.placement.y.toFixed(1)}` : ''}`,
          check ? `boarding: ${check.state.toUpperCase()}  ${check.side} side  door ${Number.isFinite(check.distance) ? check.distance.toFixed(1) : '-'} tiles (range ${b.rangeTiles})  speed vs train ${check.speedDelta >= 0 ? '+' : ''}${check.speedDelta.toFixed(2)} (±${b.speedToleranceTilesPerSec})  in zone ${zoneSec.toFixed(1)} s, best ${bestZoneSec.toFixed(1)} s` : 'boarding: -',
          meter ? `meter ${meter.position.toFixed(2)}${!meter.sweeping ? ' (parked: ride within range of a door)' : meter.matched ? ' (speed matched: slow)' : ' (speed off: fast)'}  good ${meter.good[0].toFixed(2)}-${meter.good[1].toFixed(2)}  perfect ${meter.perfect[0].toFixed(2)}-${meter.perfect[1].toFixed(2)}` : '',
          `steering ${horseCfg.steering}  throttle ${horseCfg.throttleModel}${train ? `  train ${train.id} at ${train.d.toFixed(1)} tiles, ${config.values.trains[train.type]!.speedTilesPerSec} tiles/s` : ''}`,
          ...(host.recentEvents.length ? ['recent events:', ...host.recentEvents.slice(-4)] : []),
        ].filter(Boolean).join('\n'),
      });
    },
  };
}
