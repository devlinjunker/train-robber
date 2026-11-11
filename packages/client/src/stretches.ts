// Stretches of an open line (G10a): which named stretch the rider is in, the banner that names it on
// the way in, and the zoom limit its sightlines set (`hud.stretchZoom`). Client only.
import type { MapDef } from '@train-robber/config';

export type MapStretch = NonNullable<MapDef['stretches']>[number];

/** The stretch whose land includes map x, or null on a map without stretches. */
export function stretchAt(list: readonly MapStretch[], x: number): MapStretch | null {
  if (!list.length) return null;
  for (const s of list) if (x >= s.x0 && x < s.x1) return s;
  // Off either end of the map: the nearer end stretch.
  let best = list[0]!;
  for (const s of list) if (Math.min(Math.abs(x - s.x0), Math.abs(x - s.x1)) < Math.min(Math.abs(x - best.x0), Math.abs(x - best.x1))) best = s;
  return best;
}

/** What each pace reads as under the name on the banner. */
const PACE_TEXT: Record<MapStretch['pace'], string> = { quiet: 'open country', busy: 'rough going', big: '' };
const PROFILE_TEXT: Record<string, string> = { flats: 'open flats', broken: 'broken country', timber: 'timber', river: 'river valley', mesa: 'mesa country' };

export interface StretchView {
  /** The stretch the focus is in now. */
  current: MapStretch | null;
  /** The banner: the stretch's name and kind of land, and its opacity (0 hides it). */
  banner: { title: string; sub: string; alpha: number } | null;
  /** The furthest zoom out the stretch allows, eased (Infinity-free: 0 when there is no limit). */
  zoomFloor: number;
  /** The stretch changed this frame (for `auto` zoom). */
  entered: boolean;
}

export interface StretchOptions {
  bannerSec: number;
  zoom: 'off' | 'cap' | 'auto';
  zoomOut: Readonly<Record<string, number>>;
  easeSec: number;
}

/** A border is only crossed once the focus is this far past it, so riding along it does not flicker. */
const HYSTERESIS_TILES = 6;
/** The same stretch is not announced twice within this many seconds. */
const REANNOUNCE_SEC = 20;
const FADE_SEC = 0.6;

export function createStretchTracker(list: readonly MapStretch[], o: StretchOptions) {
  let current: MapStretch | null = null;
  let shownAt = -Infinity, shown: MapStretch | null = null;
  const lastAnnounced = new Map<string, number>();
  let floor = 0;
  return {
    /** Step to time `nowSec` with the focus at map x; `dt` seconds since the last call. */
    update(x: number, nowSec: number, dt: number): StretchView {
      let entered = false;
      const first = current === null;
      if (list.length) {
        const here = stretchAt(list, x)!;
        const inside = !current || (x >= here.x0 + (here.x0 > 0 ? HYSTERESIS_TILES : -Infinity) && x < here.x1 - (here.x1 < Infinity ? HYSTERESIS_TILES : -Infinity));
        if (here !== current && (inside || !current)) {
          entered = current !== null;
          current = here;
          const last = lastAnnounced.get(here.id) ?? -Infinity;
          if (o.bannerSec > 0 && nowSec - last > REANNOUNCE_SEC) { shown = here; shownAt = nowSec; lastAnnounced.set(here.id, nowSec); }
        }
      }
      const target = o.zoom === 'off' || !current ? 0 : o.zoomOut[current.profile] ?? 0;
      // A limit that tightens eases in; one that loosens lets go at once.
      if (target <= floor || o.easeSec <= 0 || first) floor = target;
      else floor += (target - floor) * (1 - Math.exp(-(3 / o.easeSec) * dt));
      if (Math.abs(floor - target) < 1e-3) floor = target;
      let banner: StretchView['banner'] = null;
      const age = nowSec - shownAt;
      if (shown && age < o.bannerSec) {
        const alpha = Math.min(1, age / FADE_SEC, (o.bannerSec - age) / FADE_SEC);
        banner = { title: shown.name, sub: PROFILE_TEXT[shown.profile] ?? PACE_TEXT[shown.pace], alpha: Math.max(0, alpha) };
      }
      return { current, banner, zoomFloor: floor, entered };
    },
    /** Forget the banner history (a quick retry or a replay seek). */
    reset() { current = null; shown = null; shownAt = -Infinity; lastAnnounced.clear(); floor = 0; },
  };
}

export type MapSetPiece = NonNullable<MapDef['setPieces']>[number];

/** What each set piece reads as under its name on the banner. */
export const SET_PIECE_TEXT: Record<MapSetPiece['kind'], string> = {
  horseshoe: 'the track loops away: cut straight across',
  grade: 'trains slow on the climb',
  canyon: 'no room beside the cars: ride the rim and drop on',
};

/**
 * Set pieces (G10b) announce themselves on the banner as the focus comes into their box, once per
 * REANNOUNCE_SEC each, for `bannerSec`. The banner is null when none is showing.
 */
export function createSetPieceTracker(list: readonly MapSetPiece[], bannerSec: number) {
  let shown: MapSetPiece | null = null, shownAt = -Infinity, inside: MapSetPiece | null = null;
  const lastAnnounced = new Map<string, number>();
  return {
    update(x: number, y: number, nowSec: number): StretchView['banner'] {
      const here = list.find((q) => x >= q.box.x0 && x <= q.box.x1 && y >= q.box.y0 && y <= q.box.y1) ?? null;
      if (here && here !== inside && bannerSec > 0 && nowSec - (lastAnnounced.get(here.id) ?? -Infinity) > REANNOUNCE_SEC) {
        shown = here; shownAt = nowSec; lastAnnounced.set(here.id, nowSec);
      }
      inside = here;
      const age = nowSec - shownAt;
      if (!shown || age >= bannerSec) return null;
      return { title: shown.name, sub: SET_PIECE_TEXT[shown.kind], alpha: Math.max(0, Math.min(1, age / FADE_SEC, (bannerSec - age) / FADE_SEC)) };
    },
    reset() { shown = null; shownAt = -Infinity; inside = null; lastAnnounced.clear(); },
  };
}
