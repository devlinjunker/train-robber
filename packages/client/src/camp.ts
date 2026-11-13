// Making camp (Devlin, PR #74 review, 2026-11-13): the camp builds up beside the horse while C is
// held (bedroll, fire ring, firewood, tent, then the fire catches), stays while you are camped, and
// once camp is made the sun runs through dusk and night to the next dawn as a short time-lapse.
import type { Graphics } from 'pixi.js';
import { DUSK_TINT, NIGHT_TINT, clockFace } from './cues';

/** The parts of a camp, in the order they appear while the hold builds up. */
export const CAMP_PARTS = ['bedroll', 'stones', 'firewood', 'tent', 'fire'] as const;
export type CampPart = (typeof CAMP_PARTS)[number];

/** Which parts show at hold `progress` (0 to 1): each appears at its share of the hold, the fire only when camp is made. */
export function campParts(progress: number): CampPart[] {
  const p = Math.max(0, Math.min(1, progress));
  if (p >= 1) return [...CAMP_PARTS];
  const n = CAMP_PARTS.length - 1;
  return CAMP_PARTS.slice(0, n).filter((_, i) => p >= (i + 0.5) / (n + 0.5));
}

/**
 * Draw the camp at screen point (x, y) on the ground, `scale` pixels per unit (about a tile), with
 * the parts `progress` has reached. `t` (seconds) flickers the fire.
 */
export function drawCamp(g: Graphics, x: number, y: number, progress: number, scale: number, t: number): void {
  const parts = new Set(campParts(progress));
  const s = scale;
  if (parts.has('bedroll')) {
    g.roundRect(x - 1.9 * s, y + 0.3 * s, 1.3 * s, 0.5 * s, 0.2 * s).fill(0x7a4a2a).stroke({ color: 0x2b1a0e, width: 1.5 });
    g.ellipse(x - 1.75 * s, y + 0.55 * s, 0.2 * s, 0.2 * s).fill(0xd8c8a0);
  }
  if (parts.has('stones')) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      g.ellipse(x + Math.cos(a) * 0.55 * s, y + Math.sin(a) * 0.3 * s, 0.14 * s, 0.1 * s).fill(0x8a8a8a).stroke({ color: 0x3a3a3a, width: 1 });
    }
  }
  if (parts.has('firewood')) {
    g.moveTo(x - 0.35 * s, y + 0.12 * s).lineTo(x + 0.35 * s, y - 0.12 * s).stroke({ color: 0x5a3a1a, width: Math.max(2, 0.14 * s) });
    g.moveTo(x - 0.35 * s, y - 0.12 * s).lineTo(x + 0.35 * s, y + 0.12 * s).stroke({ color: 0x6b4423, width: Math.max(2, 0.14 * s) });
  }
  if (parts.has('tent')) {
    const tx = x + 1.5 * s, ty = y - 0.1 * s;
    g.poly([tx - 0.9 * s, ty + 0.5 * s, tx, ty - 0.9 * s, tx + 0.9 * s, ty + 0.5 * s]).fill(0xd9c9a3).stroke({ color: 0x5a4a30, width: 1.5 });
    g.poly([tx - 0.2 * s, ty + 0.5 * s, tx, ty - 0.1 * s, tx + 0.2 * s, ty + 0.5 * s]).fill(0x3a2a18);
  }
  if (parts.has('fire')) {
    const f = 0.85 + 0.15 * Math.sin(t * 11) + 0.08 * Math.sin(t * 23);
    g.ellipse(x, y - 0.2 * s * f, 0.3 * s, 0.5 * s * f).fill({ color: 0xff7a1a, alpha: 0.9 });
    g.ellipse(x, y - 0.1 * s * f, 0.16 * s, 0.3 * s * f).fill({ color: 0xffd34d, alpha: 0.95 });
    g.circle(x, y, 1.6 * s).fill({ color: 0xffa040, alpha: 0.08 * f });
  }
}

/**
 * The time-lapse after making camp, `u` from 0 to 1: dusk from the time camp was made to
 * nightfall, night through to the next dawn, then the dark lifts. The sun box shows the clock
 * running; `tint` drives the screen wash as the day clock's own phases do.
 */
export function timelapseView(fromMinutes: number, dawnHour: number, nightfallHour: number, u: number):
  { phase: 'day' | 'dusk' | 'night'; share: number; text: string; tint: number; time: string } {
  const nightfall = nightfallHour * 60, dawn = (dawnHour + 24) * 60;
  const from = Math.min(fromMinutes, nightfall);
  const k = Math.max(0, Math.min(1, u));
  if (k < 0.3) {
    const a = k / 0.3;
    return { phase: 'dusk', share: 0, text: 'making camp', tint: DUSK_TINT * a, time: clockFace(from + (nightfall - from) * a) };
  }
  if (k < 0.75) {
    const a = (k - 0.3) / 0.45;
    return { phase: 'night', share: 0, text: 'night passes', tint: NIGHT_TINT, time: clockFace(nightfall + (dawn - nightfall) * a) };
  }
  const a = (k - 0.75) / 0.25;
  return { phase: 'day', share: 1, text: 'dawn', tint: NIGHT_TINT * (1 - a), time: clockFace(dawn) };
}
