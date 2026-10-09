// Centripetal Catmull-Rom smoothing and arc-length resampling for track routes.
// Runs at build time only; the sim reads the baked samples.

export interface Vec { x: number; y: number }

const ALPHA = 0.5; // centripetal: no cusps or self-intersections on uneven spacing
const DENSE_PER_TILE = 16;

const dist = (a: Vec, b: Vec) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: Vec, b: Vec, t0: number, t1: number, t: number): Vec => {
  const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
};

/** Point on the segment p1 -> p2 at u in [0, 1] (Barry-Goldman form). */
function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, u: number): Vec {
  const t0 = 0;
  const t1 = t0 + dist(p0, p1) ** ALPHA;
  const t2 = t1 + dist(p1, p2) ** ALPHA;
  const t3 = t2 + dist(p2, p3) ** ALPHA;
  const t = t1 + (t2 - t1) * u;
  const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
  const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
  return lerp(b1, b2, t1, t2, t);
}

/** Dense polyline through every control point. Closed routes wrap; open routes extrapolate the ends. */
export function smooth(points: readonly Vec[], closed: boolean): Vec[] {
  const n = points.length;
  const at = (i: number): Vec => {
    if (closed) return points[((i % n) + n) % n]!;
    if (i < 0) { const a = points[0]!, b = points[1]!; return { x: 2 * a.x - b.x, y: 2 * a.y - b.y }; }
    if (i >= n) { const a = points[n - 1]!, b = points[n - 2]!; return { x: 2 * a.x - b.x, y: 2 * a.y - b.y }; }
    return points[i]!;
  };
  const segments = closed ? n : n - 1;
  const out: Vec[] = [];
  for (let i = 0; i < segments; i++) {
    const p1 = at(i), p2 = at(i + 1);
    const steps = Math.max(8, Math.ceil(dist(p1, p2) * DENSE_PER_TILE));
    for (let k = 0; k < steps; k++) out.push(catmullRom(at(i - 1), p1, p2, at(i + 2), k / steps));
  }
  out.push(closed ? at(0) : at(n - 1));
  return out;
}

export interface Resampled { length: number; spacing: number; points: Vec[]; s: number[] }

/**
 * Resample a dense polyline at equal arc-length steps no longer than `maxSpacing`.
 * A closed route omits the last point, since it equals the first.
 */
export function resample(dense: readonly Vec[], closed: boolean, maxSpacing: number): Resampled {
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1]! + dist(dense[i - 1]!, dense[i]!));
  const length = cum[cum.length - 1]!;
  const count = Math.max(1, Math.ceil(length / maxSpacing));
  const spacing = length / count;
  const points: Vec[] = [];
  const s: number[] = [];
  let j = 0;
  for (let i = 0; i < (closed ? count : count + 1); i++) {
    const target = Math.min(i * spacing, length);
    while (j < cum.length - 2 && cum[j + 1]! < target) j++;
    points.push(lerp(dense[j]!, dense[j + 1]!, cum[j]!, cum[j + 1]!, target));
    s.push(target);
  }
  return { length, spacing, points, s };
}
