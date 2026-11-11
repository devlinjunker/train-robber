// The open line (G3): one railway running east, built piece by piece. Each piece is about 200
// tiles long and picks a heading within maxHeadingDeg of east. Past 90 degrees the line runs back a
// little while it heads north or south, so it steers east early whenever its way ahead would come
// within selfGapTiles of track it already laid, and never crosses itself. A piece depends only on
// the seed, its index and the line so far, so `growLine` can go on forever; `bakeOpen` turns any prefix of it into the same samples
// the sim reads, and a longer line starts with exactly the samples of a shorter one.
// Deterministic maths only (see dmath.ts).
import type { MapGenSettings, Route } from '@train-robber/config';
import { dcos, dlen, dsin, PI, rng } from './dmath';
import { catmullRom, DENSE_PER_TILE, dist, lerp, r4, r6, SAMPLE_SPACING_TILES, type Track, type Vec } from './track';

export type LineSettings = MapGenSettings['line'];

/** One piece of the line: its control points (after the end of the piece before) and the heading it ends on. */
export interface LinePiece {
  index: number; points: Vec[]; heading: number; end: Vec;
  /** Set when the piece is a horseshoe bend (G10b): `dir` -1 loops north, 1 south; it leaves the line at `from` and rejoins it at `to`, both heading east. */
  horseshoe?: { dir: 1 | -1; from: Vec; to: Vec };
}

const DEG = PI / 180;
/** Turns per control point are held this far under stepTiles / minRadiusTiles: where a turn starts or stops at a control point, the smoothed curve bends about twice as tight there (measured over 200 seeds). */
const TURN_MARGIN = 2.8;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (u: number) => u * u * (3 - 2 * u);

/**
 * The line's pieces in order, forever. It starts `leadInTiles` plus one step off the west edge at a
 * seeded height near the middle of a map `rows` tall. Each piece picks a target heading (pulled back
 * toward the middle by `centrePull`) and sometimes a swing out and back, then lays control points
 * `stepTiles` apart, turning at most stepTiles / (TURN_MARGIN x minRadiusTiles) per point so no curve is
 * tighter than minRadiusTiles. Near the margin it stops heading further out.
 */
export function* growLine(seed: string, s: LineSettings, rows: number): Generator<LinePiece> {
  const start = rng(`${seed}/line/start`);
  const maxH = s.maxHeadingDeg * DEG;
  const lo = s.marginTiles, hi = rows - s.marginTiles, mid = rows / 2, span = Math.max(1, (hi - lo) / 2);
  const maxTurn = s.stepTiles / (TURN_MARGIN * s.minRadiusTiles);
  let heading = start.range(-0.5, 0.5) * maxH * s.curviness;
  let p: Vec = { x: -s.leadInTiles - s.stepTiles, y: mid + start.range(-0.25, 0.25) * span };
  // Every control point so far, for keeping clear of the line's own track.
  const laid: Vec[] = [{ ...p }];
  // Points this recent are the track just behind, always close by; older ones must stay selfGapTiles away.
  const recent = Math.ceil((2 * s.selfGapTiles) / s.stepTiles) + 2;
  const ahead = Math.ceil((3 * s.selfGapTiles) / s.stepTiles);
  const gap2 = s.selfGapTiles * s.selfGapTiles;
  /** True when running straight on along `h` from `from` would come within selfGapTiles of older track. */
  const blocked = (from: Vec, h: number): boolean => {
    const old = laid.length - recent;
    if (old <= 0) return false;
    const cx = dcos(h), sy = dsin(h);
    for (let k = 1; k <= ahead; k++) {
      const x = from.x + cx * s.stepTiles * k, y = from.y + sy * s.stepTiles * k;
      for (let i = 0; i < old; i++) {
        const q = laid[i]!;
        const dx = q.x - x, dy = q.y - y;
        if (dx * dx + dy * dy < gap2) return true;
      }
    }
    return false;
  };
  // The first point is a phantom before the start, so the first stretch of curve has a lead-in.
  yield { index: -1, points: [{ ...p }], heading, end: { ...p } };
  const hs = s.setPieces.enabled ? s.setPieces.horseshoe : null;
  let lastHorseshoeX = -Infinity;
  for (let index = 0; ; index++) {
    // A horseshoe bend instead of an ordinary piece, where it fits (G10b).
    if (hs && index >= hs.fromPiece && hs.chance > 0 && p.x - lastHorseshoeX >= hs.minGapTiles) {
      const hr = rng(`${seed}/line/${index}/horseshoe`);
      if (hr.next() < hs.chance) {
        const leg = hr.range(hs.legTiles[0], hs.legTiles[1]), top = hr.range(hs.topTiles[0], hs.topTiles[1]);
        const first: 1 | -1 = p.y > mid ? -1 : 1;
        let laidBend = false;
        for (const dir of [first, (first === 1 ? -1 : 1) as 1 | -1]) {
          const bend = horseshoePoints(p, heading, dir, leg, top, s.stepTiles, maxTurn);
          if (!bend.points.every((q) => q.y >= lo && q.y <= hi)) continue;
          // Clear of the line's older track all the way round.
          const old = laid.length - recent;
          if (old > 0 && bend.points.some((q) => laid.slice(0, old).some((o) => (o.x - q.x) ** 2 + (o.y - q.y) ** 2 < gap2))) continue;
          heading = 0;
          p = { ...bend.points[bend.points.length - 1]! };
          for (const q of bend.points) laid.push({ ...q });
          lastHorseshoeX = p.x;
          laidBend = true;
          yield { index, points: bend.points, heading, end: { ...p }, horseshoe: { dir, from: bend.from, to: bend.to } };
          break;
        }
        if (laidBend) continue;
      }
    }
    const r = rng(`${seed}/line/${index}`);
    const len = r.range(s.pieceTiles[0], s.pieceTiles[1]);
    const steps = Math.max(2, Math.round(len / s.stepTiles));
    const off = clamp((p.y - mid) / span, -1.5, 1.5);
    const target = clamp((r.range(-1, 1) * s.curviness - s.centrePull * off) * maxH, -maxH, maxH);
    const swing = r.next() < s.swingChance ? r.range(-1, 1) * s.swingDeg * DEG * s.curviness : 0;
    // The turn happens over part of the piece, then it runs straight: bends and straights, not one long arc.
    const bend = r.range(s.bendShare[0], s.bendShare[1]);
    const from = heading;
    const points: Vec[] = [];
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      let want = from + (target - from) * smooth(Math.min(1, u / bend)) + swing * dsin(PI * u);
      // Within 40 tiles of the margin the heading may point less and less further out, and past it
      // it must point back in. The bounds move smoothly with y, so the turns do too.
      const top = clamp((lo + 40 - p.y) / 60, 0, 1), bottom = clamp((p.y - (hi - 40)) / 60, 0, 1);
      want = clamp(want, -maxH + top * 1.5 * maxH, maxH - bottom * 1.5 * maxH);
      // Heading back toward older track: turn east (only lines past 90 degrees can).
      if (maxH > PI / 2 && blocked(p, heading)) want = 0;
      heading += clamp(want - heading, -maxTurn, maxTurn);
      p = { x: p.x + s.stepTiles * dcos(heading), y: p.y + s.stepTiles * dsin(heading) };
      points.push({ ...p });
      laid.push({ ...p });
    }
    yield { index, points, heading, end: { ...p } };
  }
}

/**
 * The control points of a horseshoe bend from `start` heading `heading`: straighten to east, turn
 * a quarter toward `dir` (-1 north), run `leg`, turn back east, run `top`, turn a quarter the other
 * way, run `leg` back, turn east. Every turn is at most `maxTurn` per point, as in `growLine`, and
 * the two halves mirror, so it rejoins the line on the height it left it.
 */
function horseshoePoints(start: Vec, heading: number, dir: 1 | -1, leg: number, top: number, step: number, maxTurn: number): { points: Vec[]; from: Vec; to: Vec } {
  const points: Vec[] = [];
  let h = heading, q = { ...start };
  const advance = () => { q = { x: q.x + step * dcos(h), y: q.y + step * dsin(h) }; points.push({ ...q }); };
  const turnTo = (target: number) => { while (Math.abs(target - h) > 1e-9) { h += clamp(target - h, -maxTurn, maxTurn); advance(); } };
  const run = (len: number) => { for (let k = Math.round(len / step); k > 0; k--) advance(); };
  turnTo(0);
  advance();
  const from = { ...q };
  turnTo((dir * PI) / 2); run(leg); turnTo(0); run(top); turnTo((-dir * PI) / 2); run(leg); turnTo(0);
  const to = { ...q };
  advance();
  return { points, from, to };
}

/** Control points from the start of the line until one lies `beyondX` east (it and the next are kept as the curve's end). */
export function lineControlPoints(seed: string, s: LineSettings, rows: number, beyondX: number): { points: Vec[]; pieces: number; horseshoes: Horseshoe[] } {
  const points: Vec[] = [];
  const horseshoes: Horseshoe[] = [];
  let pieces = 0, past = 0;
  for (const piece of growLine(seed, s, rows)) {
    if (piece.index >= 0) pieces++;
    if (piece.horseshoe && piece.horseshoe.to.x < beyondX) horseshoes.push({ piece: piece.index, ...piece.horseshoe });
    for (const q of piece.points) {
      points.push(q);
      if (q.x >= beyondX) past++;
      if (past >= 2) return { points, pieces, horseshoes };
    }
  }
  return { points, pieces, horseshoes };
}

/** A horseshoe bend on the line: the piece it is, the way it loops, and where it leaves and rejoins. */
export interface Horseshoe { piece: number; dir: 1 | -1; from: Vec; to: Vec }

/**
 * Bake control points into an open route: a centripetal Catmull-Rom curve through points 1 to n-2
 * (the first and last only shape its ends), sampled every half tile from its start. Samples, their
 * distances and tangents depend only on the points so far, so a longer line's samples begin with
 * a shorter one's. The last sample keeps the tangent into it.
 */
export function bakeOpen(id: string, control: readonly Vec[]): Track {
  const spacing = SAMPLE_SPACING_TILES;
  const pts: Vec[] = [];
  const s: number[] = [];
  let travelled = 0, next = 0;
  let prev: Vec | null = null;
  const visit = (q: Vec) => {
    if (prev) {
      const seg = dist(prev, q);
      while (next <= travelled + seg && seg > 0) {
        const at = lerp(prev, q, travelled, travelled + seg, next);
        pts.push({ x: r4(at.x), y: r4(at.y) });
        s.push(next);
        next = s.length * spacing;
      }
      travelled += seg;
    } else {
      pts.push({ x: r4(q.x), y: r4(q.y) });
      s.push(0);
      next = spacing;
    }
    prev = q;
  };
  for (let i = 1; i < control.length - 2; i++) {
    const p0 = control[i - 1]!, p1 = control[i]!, p2 = control[i + 1]!, p3 = control[i + 2]!;
    const steps = Math.max(8, Math.ceil(dist(p1, p2) * DENSE_PER_TILE));
    for (let k = 0; k < steps; k++) visit(catmullRom(p0, p1, p2, p3, k / steps));
  }
  const n = pts.length;
  const tangents: Vec[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const len = dlen(b.x - a.x, b.y - a.y);
    tangents.push({ x: (b.x - a.x) / len, y: (b.y - a.y) / len });
  }
  tangents.push({ ...tangents[n - 2]! });
  let minDot = 1;
  for (let i = 1; i < n - 1; i++) {
    const a = tangents[i - 1]!, b = tangents[i]!;
    minDot = Math.min(minDot, a.x * b.x + a.y * b.y);
  }
  const turn = Math.sqrt(Math.max(0, 2 * (1 - minDot)));
  const length = r4(s[n - 1]!);
  const route: Route = {
    id, closed: false, smoothing: 'catmull-rom',
    points: control.map((p) => ({ x: r4(p.x), y: r4(p.y) })),
    length, spacing: r6(spacing),
    samples: {
      x: pts.map((p) => p.x), y: pts.map((p) => p.y), s: s.map(r4),
      tx: tangents.map((t) => r6(t.x)), ty: tangents.map((t) => r6(t.y)), speedScale: pts.map(() => 1),
    },
  };
  return { route, points: pts, tangents, minRadiusTiles: turn > 0 ? spacing / turn : Infinity, attempts: 1 };
}

/** The line across a map `cols` x `rows`: from leadInTiles off the west edge to leadInTiles past the east edge. */
export function generateLineTrack(seed: string, s: LineSettings, cols: number, rows: number): Track & { pieces: number; horseshoes: Horseshoe[] } {
  const { points, pieces, horseshoes } = lineControlPoints(seed, s, rows, cols + s.leadInTiles);
  return { ...bakeOpen('main', points), pieces, horseshoes };
}
