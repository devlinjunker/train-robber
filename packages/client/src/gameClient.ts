// The game client: draws the sim (isometric by default, top-down with V), maps the keyboard into
// commands, and keeps the HUD. It reads sim state and events and never decides an outcome.
import { Application, Container, Text } from 'pixi.js';
import {
  boardingCheck, commitTarget, distanceToTrain, meterPosition, meterZones, parseCarFrame, runPhase, terrainAt, Terrain,
  type Command, type Sim, type SimEvent,
} from '@train-robber/sim';
import type { MapDef, ResolvedConfig } from '@train-robber/config';
import { InputMapper, KeyboardSource, type MapContext, type ViewAction } from './input';
import { Interpolator } from './interp';
import { follow, lookAheadTarget } from './camera';
import { clampZoom, DEFAULT_ZOOM, isoX, isoY, keyDirToWorld, stepZoom, worldToScreen, type Camera } from './projection';
import { createWorldScene } from './iso/worldScene';
import { createInteriorScene, interiorDirToCar } from './iso/interiorScene';
import { createScreenOverlay, type MeterView, type TrainPointer } from './screenOverlay';
import { createHud } from './hud';
import { createWorldView } from './topdown/worldView';
import { drawMapOverlay } from './topdown/mapOverlay';

/** Pixels per tile in the top-down debug view at zoom 1. */
const TOPDOWN_PX = 32;
/** Seconds for the camera ease into the train scene, and back out. */
const EASE_IN_SEC = 0.5, EASE_OUT_SEC = 0.3;
/** A camera target this far away (a reset or a quick retry) snaps instead of easing. */
const SNAP_TILES = 30;

export type ViewMode = 'iso' | 'topdown';

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

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const params = new URLSearchParams(location.search);

export function createGameClient(app: Application, opts: { sim: Sim; map: MapDef; config: ResolvedConfig; onExportLogs(): void }): GameClient {
  const { sim, map, config } = opts;
  const b = config.values.boarding;
  const horseCfg = config.values.horse;
  const tickRateHz = config.values.sim.tickRateHz;

  // Toggles; the view can start top-down with ?view=topdown.
  let mode: ViewMode = params.get('view') === 'topdown' ? 'topdown' : 'iso';
  let zoom = DEFAULT_ZOOM;
  let showDebug = true;

  // Isometric scenes.
  const isoWorld = createWorldScene(map);
  const interior = createInteriorScene();
  interior.root.visible = false;
  // Top-down debug view.
  const topdown = new Container();
  const topdownOverlay = drawMapOverlay(map);
  const topdownView = createWorldView();
  topdown.addChild(topdownOverlay, topdownView.layer);
  const overlay = createScreenOverlay();
  app.stage.addChild(isoWorld.root, interior.root, topdown, overlay.root);
  const hud = createHud();

  const onView = (a: ViewAction) => {
    if (a === 'zoomIn' || a === 'zoomOut') zoom = stepZoom(zoom, a === 'zoomIn' ? 1 : -1);
    else if (a === 'toggleView') mode = mode === 'iso' ? 'topdown' : 'iso';
    else if (a === 'toggleMapOverlay') { const o = mode === 'iso' ? isoWorld.mapOverlay : topdownOverlay; o.visible = !o.visible; }
    else if (a === 'toggleZones') isoWorld.zoneOverlay.visible = topdownView.zones.visible = !topdownView.zones.visible;
    else if (a === 'toggleDebug') showDebug = !showDebug;
    else opts.onExportLogs();
  };
  // O toggles the active view's map overlay. The top-down one starts on (it is that view's only
  // terrain); the iso one starts off, since the iso view draws the ground and track itself.
  const keyboard = new KeyboardSource(onView);
  addEventListener('wheel', (e) => { zoom = clampZoom(zoom * (e.deltaY > 0 ? 0.9 : 1 / 0.9)); }, { passive: true });
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
      const n = Math.hypot(dx, dy);
      if (n === 0) return [0, 0];
      if (mode === 'iso') return interiorDirToCar(...keyDirToWorld(dx, dy));
      // Top-down keeps the world's orientation, so turn the screen direction into the car's axes.
      const car = carOf(sim.state.players[0]!.placement.frame);
      if (!car) return null;
      const wx = dx / n, wy = dy / n;
      return [wx * car.ux + wy * car.uy, wy * car.ux - wx * car.uy];
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
  let scene: 'world' | 'interior' = 'world';
  let sceneT0 = -Infinity;
  let doorScreen = { x: 0, y: 0 };
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
      const aboardCar = parseCarFrame(placement.frame) ? carOf(placement.frame) : null;

      // Camera: lead the horse along its velocity; aboard, hold where it was.
      if (horse) {
        const target = lookAheadTarget(horse.x, horse.y, horse.hx, horse.hy, horseState.speed);
        follow(cam, target, dt, Math.hypot(target.x - cam.x, target.y - cam.y) > SNAP_TILES);
      }
      const W = app.screen.width, H = app.screen.height;
      const camera: Camera = { x: cam.x, y: cam.y, zoom, width: W, height: H };

      const iso = mode === 'iso';
      isoWorld.root.visible = iso;
      interior.root.visible = iso;
      topdown.visible = !iso;
      let project: (x: number, y: number, z: number) => { x: number; y: number };

      if (iso) {
        isoWorld.update({ cars, horse, stunned: horseState.stunTicks > 0, check, trainId: readTrain, rangeTiles: b.rangeTiles, timeSec: now / 1000 });
        isoWorld.root.scale.set(zoom);
        isoWorld.root.pivot.set(isoX(cam.x, cam.y), isoY(cam.x, cam.y));
        isoWorld.root.position.set(W / 2, H / 2);
        project = (x, y, z) => worldToScreen(x, y, z, camera);
        if (check?.at && scene === 'world') doorScreen = project(check.at.x, check.at.y, 1);

        // The train scene: on boarding, ease from the door on screen into the car.
        const want = aboardCar ? 'interior' : 'world';
        if (want !== scene) { scene = want; sceneT0 = now; }
        if (scene === 'interior' && aboardCar) {
          const trainD = interp.trainD(aboardCar.trainId, alpha) ?? 0;
          const at = interior.update(aboardCar.template, placement, trainD);
          const k = easeInOut(clamp01((now - sceneT0) / 1000 / EASE_IN_SEC));
          interior.root.alpha = k;
          isoWorld.root.alpha = 1 - k;
          interior.root.scale.set(zoom * (0.35 + 0.65 * k));
          interior.root.pivot.set(isoX(at.x, at.y), isoY(at.x, at.y));
          interior.root.position.set(doorScreen.x + (W / 2 - doorScreen.x) * k, doorScreen.y + (H / 2 - doorScreen.y) * k);
        } else {
          const k = clamp01((now - sceneT0) / 1000 / EASE_OUT_SEC);
          interior.root.alpha = 1 - k;
          interior.root.visible = k < 1;
          isoWorld.root.alpha = k;
        }
      } else {
        // Top-down keeps the world's orientation; aboard, it follows the player's place on the car.
        scene = 'world';
        isoWorld.root.alpha = 1;
        const aboardAt = aboardCar ? sim.world.toWorld(s, player.placement) : null;
        topdownView.update(cars, { horse, check, rangeTiles: b.rangeTiles, aboard: aboardAt });
        const focus = aboardAt ?? cam;
        topdown.scale.set(TOPDOWN_PX * zoom);
        topdown.pivot.set(focus.x, focus.y);
        topdown.position.set(W / 2, H / 2);
        project = (x, y) => ({ x: (x - focus.x) * TOPDOWN_PX * zoom + W / 2, y: (y - focus.y) * TOPDOWN_PX * zoom + H / 2 });
      }

      // Screen-space cues: meter and speed above the horse, arrows to trains off screen.
      const trains: TrainPointer[] = [];
      if (horse && scene === 'world') {
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
        horse: horse && scene === 'world' ? project(horse.x, horse.y, iso ? 2.2 : 0) : null,
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
          `view ${mode} (V)  zoom ${zoom.toFixed(2)}x  map overlay ${(iso ? isoWorld.mapOverlay : topdownOverlay).visible ? 'on' : 'off'} (O)  zones ${topdownView.zones.visible ? 'on' : 'off'} (B)`,
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
