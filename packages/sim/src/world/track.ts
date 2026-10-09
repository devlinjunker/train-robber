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
  samples: { x: readonly number[]; y: readonly number[]; s: readonly number[]; tx: readonly number[]; ty: readonly number[] };
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

/** Wrap a distance onto a closed route, or clamp it onto an open one. */
export function wrapDistance(route: Pick<TrackRoute, 'closed' | 'length'>, d: number): number {
  if (!route.closed) return d < 0 ? 0 : d > route.length ? route.length : d;
  const w = d % route.length;
  // `+ 0` turns the -0 that `%` gives for negative multiples into 0, so hashes agree.
  return w < 0 ? w + route.length : w + 0;
}

/** Position and unit tangent at distance `d` along the route. Writes into `out` when given. */
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
  // An open route's last sample stores the tangent of the segment into it, so this holds there too.
  out.tx = tx[i]!;
  out.ty = ty[i]!;
  return out;
}
