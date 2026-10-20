// The track: a closed loop drawn through seeded control points round the map centre, smoothed
// and baked into half-tile samples the same way `tools build-maps` bakes a Tiled route, but with
// deterministic maths only (see dmath.ts).
import type { MapGenSettings, Route } from '@train-robber/config';
import { dcos, dlen, dsin, TAU, type Rng } from './dmath';

export interface Vec { x: number; y: number }

export const SAMPLE_SPACING_TILES = 0.5;
const DENSE_PER_TILE = 16;
/** Passes of easing the tightest curves before a shape is given up. */
const EASE_PASSES = 24;

const dist = (a: Vec, b: Vec) => dlen(b.x - a.x, b.y - a.y);
const lerp = (a: Vec, b: Vec, t0: number, t1: number, t: number): Vec => {
  const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
};

/** Centripetal Catmull-Rom (alpha 0.5, so dist^alpha is a square root). */
function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, u: number): Vec {
  const t1 = Math.sqrt(dist(p0, p1));
  const t2 = t1 + Math.sqrt(dist(p1, p2));
  const t3 = t2 + Math.sqrt(dist(p2, p3));
  const t = t1 + (t2 - t1) * u;
  const a1 = lerp(p0, p1, 0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
  const b1 = lerp(a1, a2, 0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
  return lerp(b1, b2, t1, t2, t);
}

function smoothClosed(points: readonly Vec[]): Vec[] {
  const n = points.length;
  const at = (i: number) => points[((i % n) + n) % n]!;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const p1 = at(i), p2 = at(i + 1);
    const steps = Math.max(8, Math.ceil(dist(p1, p2) * DENSE_PER_TILE));
    for (let k = 0; k < steps; k++) out.push(catmullRom(at(i - 1), p1, p2, at(i + 2), k / steps));
  }
  out.push(at(0));
  return out;
}

/** Equal arc-length samples of a closed dense polyline; the last point (equal to the first) is dropped. */
function resampleClosed(dense: readonly Vec[], maxSpacing: number): { length: number; spacing: number; points: Vec[]; s: number[] } {
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1]! + dist(dense[i - 1]!, dense[i]!));
  const length = cum[cum.length - 1]!;
  const count = Math.max(1, Math.ceil(length / maxSpacing));
  const spacing = length / count;
  const points: Vec[] = [];
  const s: number[] = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = i * spacing;
    while (j < cum.length - 2 && cum[j + 1]! < target) j++;
    points.push(lerp(dense[j]!, dense[j + 1]!, cum[j]!, cum[j + 1]!, target));
    s.push(target);
  }
  return { length, spacing, points, s };
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface Track { route: Route; points: Vec[]; tangents: Vec[]; minRadiusTiles: number; attempts: number }

/** Bake control points into a route, as build-maps does; null if a curve is tighter than `minRadius`. */
export function bakeLoop(id: string, control: Vec[], minRadius: number): Track | null {
  return bake(id, control, minRadius).track;
}

/** As bakeLoop, also giving the samples where a curve is too tight. */
function bake(id: string, control: Vec[], minRadius: number): { track: Track | null; tight: Vec[] } {
  const rs = resampleClosed(smoothClosed(control), SAMPLE_SPACING_TILES);
  const n = rs.points.length;
  // Rounded first, so the tangents and the radius check see exactly the samples the sim gets.
  const pts = rs.points.map((p) => ({ x: r4(p.x), y: r4(p.y) }));
  const tangents: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    const len = dlen(b.x - a.x, b.y - a.y);
    tangents.push({ x: (b.x - a.x) / len, y: (b.y - a.y) / len });
  }
  // The checks measure radius as spacing / turn angle between tangents; turn <= spacing / R
  // is the same as dot >= cos(spacing / R), which needs no acos.
  const limit = dcos(rs.spacing / minRadius);
  let minDot = 1;
  const tight: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = tangents[(i - 1 + n) % n]!, b = tangents[i]!;
    const dot = a.x * b.x + a.y * b.y;
    minDot = Math.min(minDot, dot);
    if (dot < limit) tight.push(pts[i]!);
  }
  if (tight.length) return { track: null, tight };
  // Reported radius, for logs only (asin of the cross product would be exact; this is close enough).
  const turn = Math.sqrt(Math.max(0, 2 * (1 - minDot)));
  return { track: {
    route: {
      id, closed: true, smoothing: 'catmull-rom',
      points: control.map((p) => ({ x: r4(p.x), y: r4(p.y) })),
      length: r4(rs.length), spacing: r6(rs.spacing),
      samples: {
        x: pts.map((p) => p.x), y: pts.map((p) => p.y), s: rs.s.map(r4),
        tx: tangents.map((t) => r6(t.x)), ty: tangents.map((t) => r6(t.y)), speedScale: pts.map(() => 1),
      },
    },
    points: pts, tangents, minRadiusTiles: turn > 0 ? rs.spacing / turn : Infinity, attempts: 0,
  }, tight };
}

/**
 * Ease the curves that are too tight instead of giving up the whole shape: each pass moves the
 * control points nearest a tight sample (and their neighbours) toward the midpoint of their
 * neighbours, so the bends elsewhere keep their shape. Null if `passes` are not enough.
 */
function easeLoop(id: string, control: Vec[], minRadius: number, passes: number): Track | null {
  const pts = control.map((p) => ({ ...p }));
  const n = pts.length;
  for (let pass = 0; pass <= passes; pass++) {
    const { track, tight } = bake(id, pts, minRadius);
    if (track) return track;
    if (pass === passes) break;
    const move = new Uint8Array(n);
    for (const q of tight) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (pts[i]!.x - q.x) * (pts[i]!.x - q.x) + (pts[i]!.y - q.y) * (pts[i]!.y - q.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      for (const k of [-1, 0, 1]) move[(best + k + n) % n] = 1;
    }
    const prev = pts.map((p) => ({ ...p }));
    for (let i = 0; i < n; i++) {
      if (!move[i]) continue;
      const a = prev[(i - 1 + n) % n]!, b = prev[(i + 1) % n]!, c = prev[i]!;
      pts[i] = { x: c.x * 0.5 + (a.x + b.x) * 0.25, y: c.y * 0.5 + (a.y + b.y) * 0.25 };
    }
  }
  return null;
}

/** Closest approach between two parts of the loop that are at least 3 x `gap` apart along it. */
function selfGap(t: Track, gap: number): number {
  const p = t.points, n = p.length, step = 4, apart = Math.ceil((3 * gap) / t.route.spacing);
  let min = Infinity;
  for (let i = 0; i < n; i += step) {
    for (let j = i + apart; j <= i + n - apart && j < n; j += step) {
      const dx = p[i]!.x - p[j]!.x, dy = p[i]!.y - p[j]!.y;
      min = Math.min(min, dx * dx + dy * dy);
    }
  }
  return Math.sqrt(min);
}

/**
 * A closed loop round the map centre: an ellipse that fills the map less `marginTiles`, pulled in
 * toward the centre by a few low harmonics (2 up to the `harmonics` pick), so it bends into kidney,
 * bean and S shapes rather than wobbling. The dent at each angle is at most curviness x maxDent of
 * the way in. Pulling in only keeps the loop inside the margin. Curves tighter than `minRadiusTiles`
 * are eased locally (easeLoop), so the other bends keep their shape. A shape is kept when no two
 * parts of the loop pass within `selfGapTiles` (which also rules out crossing itself); otherwise
 * fresh shapes are tried, then shallower ones; the last resort is the plain ellipse.
 */
export function generateTrack(r: Rng, cols: number, rows: number, s: MapGenSettings['track']): Track {
  const cx = cols / 2, cy = rows / 2;
  const ax = cols / 2 - s.marginTiles, ay = rows / 2 - s.marginTiles;
  const phase = r.next() * TAU;
  const n = s.controlPoints;
  const loop = (waves: { k: number; w: number; phi: number }[], depth: number) => {
    const total = waves.reduce((m, h) => m + h.w, 0) || 1;
    const pts: Vec[] = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (TAU * i) / n;
      let dent = 0;
      for (const h of waves) dent += (h.w * (1 + dcos(h.k * a + h.phi))) / 2;
      const f = 1 - depth * (dent / total);
      // Dents bend the long sides most (sin^2 weight); the ends, already the tightest part of the ellipse, barely move.
      const sn = dsin(a), side = sn * sn;
      pts.push({ x: cx + ax * (1 - (1 - f) * (1 - side) * 0.5) * dcos(a), y: cy + ay * (1 - (1 - f) * (0.5 + 0.5 * side)) * sn });
    }
    return pts;
  };
  const fresh = 16, soft = 8;
  const depth = s.curviness * s.maxDent;
  let waves: { k: number; w: number; phi: number }[] = [];
  for (let k = 0; k < fresh + soft; k++) {
    if (k < fresh) {
      const top = r.int(s.harmonics[0], s.harmonics[1]);
      waves = [];
      for (let h = 2; h <= top; h++) waves.push({ k: h, w: r.next() * r.next(), phi: r.next() * TAU });
    }
    const t = easeLoop('main', loop(waves, k < fresh ? depth : depth * (1 - (k - fresh + 1) / (soft + 1))), s.minRadiusTiles, EASE_PASSES);
    if (t && selfGap(t, s.selfGapTiles) >= s.selfGapTiles) return { ...t, attempts: k + 1 };
  }
  // A plain ellipse; its tightest curve is ay^2 / ax.
  const t = bakeLoop('main', loop([], 0), 0)!;
  return { ...t, attempts: fresh + soft + 1 };
}
