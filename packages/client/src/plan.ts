// Planning the boarding (G10): the engine crew's sight cone, meet-here markers on the track, and
// lookouts that open the view wide. Client only: the sim decides when the crew spots you
// (sim world/engineSight.ts); this only shows where they look and helps you plan.
import { Terrain, terrainAt, travelAt, trainSpeed, type CarPose, type GameState, type HorseState, type SimConfig, type SimRoute, type WorldMap } from '@train-robber/sim';
import type { MapDef } from '@train-robber/config';
import type { ConeView } from './guards';
import type { StretchView } from './stretches';
import { stretchAt, type MapStretch, type MapSetPiece } from './stretches';

/** Rays across the engine's cone. */
const ENGINE_RAYS = 36;
const RAY_STEP = 0.5;

/**
 * The engine crew's view, as a cone polygon on the ground: out to the range for the rider's speed
 * now, cut short by blocked ground. `seen` colours it as the crew having spotted you.
 */
export function engineCone(map: WorldMap, config: SimConfig, engine: CarPose, h: HorseState | null, seen: boolean): ConeView {
  const es = config.values.boarding.engineSight;
  const slow = !!h && h.speed <= es.slowSpeedTilesPerTick * config.values.sim.tickRateHz;
  const range = slow ? es.slowRangeTiles : es.rangeTiles;
  const half = Math.acos(Math.max(-1, Math.min(1, es.coneCos)));
  const base = Math.atan2(engine.uy, engine.ux);
  const points: [number, number][] = [[engine.x, engine.y]];
  for (let i = 0; i <= ENGINE_RAYS; i++) {
    const a = base - half + (2 * half * i) / ENGINE_RAYS, dx = Math.cos(a), dy = Math.sin(a);
    let r = RAY_STEP;
    while (r < range && terrainAt(map, engine.x + dx * r, engine.y + dy * r) !== Terrain.Blocked) r += RAY_STEP;
    points.push([engine.x + dx * Math.min(r, range), engine.y + dy * Math.min(r, range)]);
  }
  return { id: -1, car: 0, state: seen ? 'alert' : 'unaware', points, faint: true, roof: false };
}

export type MapLookout = NonNullable<MapDef['lookouts']>[number];

/** A meet-here marker on the track. */
export interface PlanMarker { id: number; route: string; d: number; x: number; y: number; name: string }

/** How a marker reads now: its train's time there and yours, and the colour of the margin. */
export interface MarkerReading { marker: PlanMarker; trainSec: number | null; riderSec: number; colour: number; text: string }

export const MARKER_GREEN = 0x5fd35f, MARKER_AMBER = 0xffb02e, MARKER_RED = 0xff5a4e, MARKER_GREY = 0xc8c8c8;

/** m:ss for a time in seconds. */
export const clock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The nearest sample of `route` to (x, y), as a distance along it, and how far off the track the point is. */
export function nearestOnRoute(route: SimRoute, x: number, y: number): { d: number; x: number; y: number; off: number } {
  const sm = route.samples;
  let best = 0, bd = Infinity;
  for (let i = 0; i < sm.x.length; i++) {
    const dx = sm.x[i]! - x, dy = sm.y[i]! - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return { d: sm.s[best]!, x: sm.x[best]!, y: sm.y[best]!, off: Math.sqrt(bd) };
}

/** The name of the place at distance `d` along the track: a set piece there, a town close by, a lookout beside it, else the stretch. */
export function placeName(map: Pick<MapDef, 'setPieces' | 'towns' | 'stretches' | 'lookouts'>, d: number, x: number, y: number): string {
  const piece = (map.setPieces ?? []).find((q: MapSetPiece) => d >= q.d0 - 40 && d <= q.d1 + 40);
  if (piece) return piece.name;
  const towns = map.towns ?? [];
  const ti = towns.findIndex((t) => Math.abs(t.d - d) < t.radiusTiles + 60);
  if (ti >= 0) return `Town ${ti + 1}`;
  const look = (map.lookouts ?? []).find((q) => Math.hypot(q.sign.x - x, q.sign.y - y) < 80);
  if (look) return `below ${look.name}`;
  const st = stretchAt((map.stretches ?? []) as MapStretch[], x);
  return st ? st.name : 'Marker';
}

/**
 * Meet-here markers (`hud.markersMax`): P drops one on the track nearest the mouse (or the rider),
 * named after the place; P on an existing one picks it up; Shift+P clears them all.
 */
export function createMarkers(max: number) {
  let list: PlanMarker[] = [];
  let next = 1;
  return {
    get list(): readonly PlanMarker[] { return list; },
    /** Drop a marker at (d, x, y), or pick up the one within `pickTiles`; returns what happened. */
    toggle(route: string, d: number, x: number, y: number, name: string, pickTiles = 8): 'added' | 'removed' | 'replaced' | 'off' {
      if (max <= 0) return 'off';
      const near = list.find((m) => m.route === route && Math.abs(m.d - d) < pickTiles);
      if (near) { list = list.filter((m) => m !== near); return 'removed'; }
      // Two markers in one place get numbers.
      const same = list.filter((m) => m.name === name || m.name.startsWith(`${name} `)).length;
      const marker = { id: next++, route, d, x, y, name: same ? `${name} ${same + 1}` : name };
      const replaced = list.length >= max;
      list = [...(replaced ? list.slice(1) : list), marker].sort((a, b) => a.d - b.d);
      return replaced ? 'replaced' : 'added';
    },
    clear(): void { list = []; },
  };
}

/**
 * When a train's engine gets to distance `d` on `route` from where it is now, in seconds; null when it
 * has passed it (an open line) or runs on another route. Slow track counts for more, as the sim runs it.
 */
export function trainEta(config: SimConfig, route: SimRoute, t: Pick<GameState['world']['trains'][number], 'type' | 'route' | 'd' | 'speedUpTicks'>, d: number): number | null {
  const v = trainSpeed(config, t.type) * (t.speedUpTicks ? config.values.boarding.engineSight.speedUpScale : 1);
  if (v <= 0) return null;
  const follow = config.values.world.trainsFollowTrackSpeed;
  if (route.closed) {
    const ahead = ((d - t.d) % route.length + route.length) % route.length;
    return ahead / v;
  }
  if (d < t.d) return null;
  return (follow ? travelAt(route, d) - travelAt(route, t.d) : d - t.d) / v;
}

/**
 * Each marker's reading: the committed train's time there (or, with no run, the next train's), your
 * time riding straight there at top speed, and the colour of what is left to spare.
 */
export function readMarkers(state: GameState, map: WorldMap, config: SimConfig, markers: readonly PlanMarker[], h: HorseState | null, marginSec: number): MarkerReading[] {
  const run = state.run;
  const top = config.values.horse.maxSpeed;
  return markers.map((m) => {
    const route = map.routes.get(m.route);
    let trainSec: number | null = null;
    if (route) {
      for (const t of state.world.trains) {
        if (run && t.id !== run.trainId) continue;
        if ((t.route ?? config.values.trains[t.type]?.route) !== m.route) continue;
        const eta = trainEta(config, route, t, m.d);
        if (eta !== null && (trainSec === null || eta < trainSec)) trainSec = eta;
      }
    }
    const riderSec = h ? Math.hypot(m.x - h.x, m.y - h.y) / Math.max(0.1, top) : 0;
    const spare = trainSec === null ? null : trainSec - riderSec;
    const colour = spare === null ? MARKER_GREY : spare >= marginSec ? MARKER_GREEN : spare >= 0 ? MARKER_AMBER : MARKER_RED;
    const who = run ? 'train' : 'next train';
    const text = `${m.name}\n${trainSec === null ? `${who} passed` : `${who} ${clock(trainSec)}`} / you ${clock(riderSec)}`;
    return { marker: m, trainSec, riderSec, colour, text };
  });
}

/** Whether (x, y) is up on a lookout's top, and which. */
export function lookoutAt(list: readonly MapLookout[], x: number, y: number): MapLookout | null {
  for (const q of list) if (Math.hypot(x - q.x, y - q.y) <= q.topRadiusTiles) return q;
  return null;
}

const FADE_SEC = 0.6;
const REANNOUNCE_SEC = 20;

/** The lookout banner: shown on riding up onto a lookout's top, for `bannerSec`. */
export function createLookoutTracker(list: readonly MapLookout[], bannerSec: number) {
  let on: MapLookout | null = null, shown: MapLookout | null = null, shownAt = -Infinity;
  const last = new Map<string, number>();
  return {
    update(x: number, y: number, nowSec: number): { on: MapLookout | null; banner: StretchView['banner'] } {
      const here = lookoutAt(list, x, y);
      if (here && here !== on && bannerSec > 0 && nowSec - (last.get(here.id) ?? -Infinity) > REANNOUNCE_SEC) {
        shown = here; shownAt = nowSec; last.set(here.id, nowSec);
      }
      on = here;
      const age = nowSec - shownAt;
      const banner = shown && age < bannerSec
        ? { title: shown.name, sub: 'lookout: watch the line, and P marks where to meet a train', alpha: Math.max(0, Math.min(1, age / FADE_SEC, (bannerSec - age) / FADE_SEC)) }
        : null;
      return { on, banner };
    },
    reset() { on = null; shown = null; shownAt = -Infinity; last.clear(); },
  };
}
