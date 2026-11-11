// Stretches of the open line (G10a): the line is cut into named stretches along the track, each one
// a profile (open flats, broken country, timber, a river valley, mesa country) that moves the noise
// thresholds and sets how many rivers, cuts and ridges it gets. A seeded director picks the order so
// quiet stretches come between the big ones. Land belongs to the stretch whose map x range it is in
// (the line runs along x), and the thresholds blend over `blendTiles` at each border.
import type { MapGenSettings, StretchPace, StretchProfile } from '@train-robber/config';
import { rng } from './dmath';

type StretchSettings = MapGenSettings['line']['stretches'];

export interface LineStretch {
  index: number;
  name: string;
  profileId: string;
  profile: StretchProfile;
  /** Along the track. */
  d0: number; d1: number;
  /** Track samples it covers, [i0, i1). */
  i0: number; i1: number;
  /** Map x range (east-running coordinates); the first starts at -Infinity and the last ends at Infinity. */
  x0: number; x1: number;
}

export interface StretchPlan {
  list: LineStretch[];
  /** x of each border between stretch k and k + 1, ascending. */
  borders: number[];
  blendTiles: number;
}

/** Lay out the stretches along a track of `n` samples `spacing` apart whose sample x's are `xs`. */
export function planStretches(seed: string, c: StretchSettings, xs: readonly number[], spacing: number): StretchPlan {
  const n = xs.length, L = (n - 1) * spacing;
  const r = rng(`${seed}/stretches`);
  const ids = Object.keys(c.profiles);
  const pick = (allowed: (id: string) => boolean): string => {
    let pool = ids.filter((id) => allowed(id) && c.profiles[id]!.weight > 0);
    if (!pool.length) pool = ids.filter((id) => c.profiles[id]!.weight > 0);
    if (!pool.length) pool = ids;
    const total = pool.reduce((t, id) => t + Math.max(c.profiles[id]!.weight, 1e-9), 0);
    let roll = r.next() * total;
    for (const id of pool) { roll -= Math.max(c.profiles[id]!.weight, 1e-9); if (roll < 0) return id; }
    return pool[pool.length - 1]!;
  };
  // Cut the track into lengths; a short last piece joins the one before it.
  const cuts: number[] = [0];
  for (let d = 0; ;) {
    d += r.range(c.lengthTiles[0], c.lengthTiles[1]);
    if (d >= L - c.lengthTiles[0] / 2) break;
    cuts.push(d);
  }
  cuts.push(L);
  const list: LineStretch[] = [];
  const names = new Set<string>(), prefixes = new Set<string>();
  let prev: { id: string; pace: StretchPace } | null = null;
  for (let k = 0; k + 1 < cuts.length; k++) {
    const p: { id: string; pace: StretchPace } | null = prev;
    const id = pick((q) => {
      const pace = c.profiles[q]!.pace;
      if (k === 0 && c.firstPace) return pace === c.firstPace;
      if (p && q === p.id) return false;
      if (p?.pace === 'big' && (pace === 'big' || (c.quietAfterBig && pace !== 'quiet'))) return false;
      return true;
    });
    const profile = c.profiles[id]!;
    // A name not used on this line yet, with a first word not used yet while there are some left.
    let name = '', prefix = '';
    for (let tries = 0; tries < 12 && (!name || names.has(name) || (prefixes.has(prefix) && prefixes.size < c.namePrefixes.length)); tries++) {
      prefix = c.namePrefixes[r.int(0, c.namePrefixes.length - 1)]!;
      name = `${prefix} ${profile.names[r.int(0, profile.names.length - 1)]!}`;
    }
    names.add(name); prefixes.add(prefix);
    const d0 = cuts[k]!, d1 = cuts[k + 1]!;
    list.push({ index: k, name, profileId: id, profile, d0, d1, i0: Math.ceil(d0 / spacing - 1e-9), i1: k + 2 === cuts.length ? n : Math.ceil(d1 / spacing - 1e-9), x0: -Infinity, x1: Infinity });
    prev = { id, pace: profile.pace };
  }
  // Borders in x, kept ascending even where the line turns back on itself a little.
  const borders: number[] = [];
  for (let k = 1; k < list.length; k++) {
    const x = xs[Math.min(n - 1, list[k]!.i0)]!;
    borders.push(Math.max(x, (borders[borders.length - 1] ?? -Infinity) + 1));
  }
  list.forEach((s, k) => { s.x0 = k === 0 ? -Infinity : borders[k - 1]!; s.x1 = k === list.length - 1 ? Infinity : borders[k]!; });
  return { list, borders, blendTiles: c.blendTiles };
}

/** The stretch the land at map x belongs to. */
export function stretchAtX(plan: StretchPlan, x: number): LineStretch {
  const b = plan.borders;
  let lo = 0, hi = b.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x >= b[mid]!) lo = mid + 1; else hi = mid; }
  return plan.list[lo]!;
}

export type FeatureThresholds = { mud: Float64Array; rocks: Float64Array; forest: Float64Array; lakes: Float64Array; deep: Float64Array; mesas: Float64Array; hills: Float64Array };

const clamp01 = (v: number) => Math.max(0, Math.min(0.9999, v));

/**
 * Each feature's noise threshold for the `w` columns from x0, as `s` sets them, moved by the
 * stretch there and blended across borders. Without a plan every column gets `s`'s own value.
 */
export function columnThresholds(s: MapGenSettings, plan: StretchPlan | null, x0: number, w: number): FeatureThresholds {
  const out: FeatureThresholds = {
    mud: new Float64Array(w).fill(s.mud.threshold), rocks: new Float64Array(w).fill(s.rocks.threshold), forest: new Float64Array(w).fill(s.forest.threshold),
    lakes: new Float64Array(w).fill(s.lakes.threshold), deep: new Float64Array(w).fill(s.lakes.deepThreshold), mesas: new Float64Array(w).fill(s.mesas.threshold),
    hills: new Float64Array(w).fill(s.hills.threshold),
  };
  if (!plan) return out;
  const B = plan.blendTiles;
  for (let i = 0; i < w; i++) {
    const cx = x0 + i + 0.5;
    const here = stretchAtX(plan, cx);
    let sh = here.profile.shift;
    // Blend with the neighbour across the nearest border within half the blend width.
    const k = here.index;
    const left = k > 0 ? plan.borders[k - 1]! : -Infinity, right = k < plan.borders.length ? plan.borders[k]! : Infinity;
    let other: typeof sh | null = null, t = 0;
    if (B > 0 && cx - left < B / 2) { other = plan.list[k - 1]!.profile.shift; t = 0.5 - (cx - left) / B; }
    else if (B > 0 && right - cx < B / 2) { other = plan.list[k + 1]!.profile.shift; t = 0.5 - (right - cx) / B; }
    if (other) {
      // t runs 0 (deep in this stretch) to 0.5 (on the border); smoothstep the share of the other.
      const u = 0.5 + t, wgt = (u * u * (3 - 2 * u)) - 0.5;
      const a = sh, b = other;
      sh = { mud: a.mud + (b.mud - a.mud) * wgt, rocks: a.rocks + (b.rocks - a.rocks) * wgt, forest: a.forest + (b.forest - a.forest) * wgt,
        lakes: a.lakes + (b.lakes - a.lakes) * wgt, mesas: a.mesas + (b.mesas - a.mesas) * wgt, hills: a.hills + (b.hills - a.hills) * wgt };
    }
    out.mud[i] = clamp01(s.mud.threshold + sh.mud);
    out.rocks[i] = clamp01(s.rocks.threshold + sh.rocks);
    out.forest[i] = clamp01(s.forest.threshold + sh.forest);
    out.lakes[i] = clamp01(s.lakes.threshold + sh.lakes);
    out.deep[i] = clamp01(s.lakes.deepThreshold + sh.lakes);
    out.mesas[i] = clamp01(s.mesas.threshold + sh.mesas);
    out.hills[i] = clamp01(s.hills.threshold + sh.hills);
  }
  return out;
}
