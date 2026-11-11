// Position and heading along a route, read from the samples `tools build-maps` bakes.
// No spline maths and no trig: a lookup is an index, one lerp and a stored tangent.

/**
 * The parts of a baked route the sim reads. `@train-robber/config`'s Route satisfies
 * this structurally, so the sim does not depend on the config package.
 */
export interface TrackRoute {
  closed: boolean;
  /** Total length in tiles; a closed route wraps from here back to distance 0. */
  length: number;
  /** Arc length between neighbouring samples (they are evenly spaced). */
  spacing: number;
  /**
   * Columnar samples: sample i sits at (x[i], y[i]) at distance s[i], and (tx[i], ty[i])
   * is the unit tangent of the segment from sample i to the next.
   */
  samples: { x: readonly number[]; y: readonly number[]; s: readonly number[]; tx: readonly number[]; ty: readonly number[]; speedScale?: readonly number[] };
}

/** One stretch of a service: segment `segment` from distance `start`, junction `from` to junction `to`. */
export interface RouteLeg { segment: string; start: number; length: number; from: string; to: string }

export interface SimRoute extends TrackRoute {
  id: string;
  /** Set on services built from shared segments; a train may switch services at a junction. */
  legs?: readonly RouteLeg[];
}

export interface TrackPoint {
  /** Distance along the route after wrapping (closed) or clamping (open), in [0, length). */
  d: number;
  x: number;
  y: number;
  /** Unit tangent in the direction of travel. */
  tx: number;
  ty: number;
}

/** True when some sample slows trains (a grade or a speed zone). */
export function hasSlowTrack(route: TrackRoute): boolean {
  const sc = route.samples.speedScale;
  return !!sc && sc.some((v) => v < 1);
}

/** Sample index at distance d (already wrapped or clamped). */
function sampleIndex(route: TrackRoute, dist: number): number {
  const n = route.samples.s.length;
  const i = Math.floor(dist / route.spacing);
  return i < 0 ? 0 : i > n - 1 ? n - 1 : i;
}

/**
 * The share of its full speed a train runs at with its engine at distance `d` (G10b: grades and
 * speed zones slow trains): the sample's `speedScale`, 1 off the ends of an open route or on a
 * route without one.
 */
export function speedScaleAt(route: TrackRoute, d: number): number {
  const sc = route.samples.speedScale;
  if (!sc || (!route.closed && (d < 0 || d > route.length))) return 1;
  return sc[sampleIndex(route, wrapDistance(route, d))]!;
}

const travelCache = new WeakMap<object, Float64Array>();
/**
 * Time-weighted distance along an open route from 0 to `d`: each tile counts 1 / speedScale, so
 * (travel(b) - travel(a)) / speed is the time a train takes from a to b. Equal to `d` on track that
 * never slows; straight on past either end.
 */
export function travelAt(route: TrackRoute, d: number): number {
  const sc = route.samples.speedScale;
  if (!sc || !hasSlowTrack(route)) return d;
  let cum = travelCache.get(route.samples);
  if (!cum) {
    cum = new Float64Array(sc.length + 1);
    for (let i = 0; i < sc.length; i++) cum[i + 1] = cum[i]! + route.spacing / sc[i]!;
    travelCache.set(route.samples, cum);
  }
  if (d <= 0) return d;
  const n = sc.length, end = n * route.spacing;
  if (d >= end) return cum[n]! + (d - end);
  const i = Math.floor(d / route.spacing);
  return cum[i]! + (d - i * route.spacing) / sc[i]!;
}

/** Wrap a distance onto a closed route, or clamp it onto an open one. */
export function wrapDistance(route: Pick<TrackRoute, 'closed' | 'length'>, d: number): number {
  if (!route.closed) return d < 0 ? 0 : d > route.length ? route.length : d;
  const w = d % route.length;
  // `+ 0` turns the -0 that `%` gives for negative multiples into 0, so hashes agree.
  return w < 0 ? w + route.length : w + 0;
}

/**
 * Position and unit tangent at distance `d` along the route. Writes into `out` when given. On an
 * open route a distance before 0 or past the end is extended straight along the end's tangent
 * (`out.d` stays clamped).
 */
export function trackAt(route: TrackRoute, d: number, out: TrackPoint = { d: 0, x: 0, y: 0, tx: 1, ty: 0 }): TrackPoint {
  const { x, y, s, tx, ty } = route.samples;
  const n = s.length;
  const dist = wrapDistance(route, d);
  // Samples are evenly spaced, so the index is a division; the stored distances are
  // rounded, so nudge the guess until s[i] <= dist < s[i + 1].
  let i = Math.floor(dist / route.spacing);
  if (i > n - 1) i = n - 1;
  if (i < 0) i = 0;
  while (i > 0 && s[i]! > dist) i--;
  while (i < n - 1 && s[i + 1]! <= dist) i++;
  const last = i === n - 1;
  // The last sample of a closed route leads back to sample 0 at distance `length`.
  const j = last ? (route.closed ? 0 : i) : i + 1;
  const sEnd = last ? (route.closed ? route.length : s[i]!) : s[j]!;
  const span = sEnd - s[i]!;
  const u = span > 0 ? (dist - s[i]!) / span : 0;
  out.d = dist;
  out.x = x[i]! + (x[j]! - x[i]!) * u;
  out.y = y[i]! + (y[j]! - y[i]!) * u;
  // An open line carries on straight past either end, so a train can enter from beyond its start
  // and leave past its end with every car on a straight line.
  if (!route.closed && d !== dist) {
    out.x += tx[i]! * (d - dist);
    out.y += ty[i]! * (d - dist);
  }
  // An open route's last sample stores the tangent of the segment into it, so this holds there too.
  out.tx = tx[i]!;
  out.ty = ty[i]!;
  return out;
}
