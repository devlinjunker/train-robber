// The isometric world: terrain and track, boulders and cars drawn with height that depth-sort
// against the horse (cars in two-tile slices, boulders in strips), the mud cue, entry markers and
// the debug overlays.
import { Container, Graphics } from 'pixi.js';
import { CAR_TEMPLATES, carEntryPoints, HORSE_RADIUS, WALKER_RADIUS, type BoardingCheck, type BoardingState, type CarPose } from '@train-robber/sim';
import type { MapDef } from '@train-robber/config';
import { boxCorners, drawBox, groundEllipse, isoPoly, shade, sidePanel, type Box } from './draw';
import { drawIsoMapOverlay, drawTerrain } from './terrain';
import { carHides } from './occlusion';
import { createRocks } from './rocks';
import { createHeightField, createHeightLayer } from './height';
import { createMud } from './mud';
import { depthOf, isoX, isoY, TILE_H } from '../projection';
import type { ActorPose } from '../interp';
import { flashOn, GOOD_COLOUR, HIT_COLOUR, PERFECT_COLOUR } from '../cues';

const PERFECT_RING_SEC = 0.8;

export const CAR_COLOURS: Record<string, number> = { engine: 0x4a4a58, 'blank-car': 0x9a5534 };
const DOOR_COLOUR = 0xe8c872;
/** Slice length along a car, in tiles; each slice sorts on its own. */
export const SLICE_TILES = 2;
const CAR_HEIGHT = 2.4;
/** The car you are in is drawn open: no roof, low walls and a plank floor, so you show inside it. */
const OPEN_WALL_HEIGHT = 0.9, OPEN_WALL_THICK = 0.3, FLOOR_COLOUR = 0x846446;
const PLAYER_COLOUR = 0x6bd3ff;
const HORSE_COLOUR = 0x8a5a32, RIDER_COLOUR = 0x6bd3ff, MUDDY_LEGS = 0x3d2a18;
/**
 * When a car hides the horse and rider (or you aboard), a round hole is cut through the cars in
 * front of them, so they and the ground around them show through (Devlin, 2026-10-10). Radius in
 * tiles.
 */
const HIDDEN_HEIGHTS = [0.6, 1.6], CUTOUT_RADIUS = 2.55;
/**
 * Seeing the gap to the train (Devlin, 2026-10-12, in place of a line and a number): within
 * GAP_HOLE_TILES on the far side, the hole stretches from the horse to the car side so the ground
 * between them shows, narrowing to GAP_HOLE_END_RADIUS tiles at the car. Within GAP_GLOW_TILES on
 * either side, the bottom edge of the car nearest the horse glows, longer and brighter as it closes,
 * and turns red within GAP_DANGER_TILES (Devlin, PR #20 playtest).
 */
export const GAP_HOLE_TILES = 8, GAP_GLOW_TILES = 6, GAP_DANGER_TILES = 1;
const GAP_HOLE_END_RADIUS = 1.4, GAP_GLOW_COLOUR = 0xffe9a8, GAP_DANGER_COLOUR = 0xff4a3a;

const MARKER_COLOURS: Record<BoardingState, number> = { 'too far': 0xc8c8c8, 'too slow': 0xff9f43, 'too fast': 0xff9f43, eligible: 0x6bff8a };

export interface WorldSceneInput {
  cars: readonly CarPose[];
  /** The horse, unless it is abstract (its rider is aboard). */
  horse: ActorPose | null;
  stunned: boolean;
  /** Seconds since a crash cost health, while its red flash lasts, else null. */
  hitAge: number | null;
  /** Aboard: the good-landing stumble is on (amber flash and a wobble), and seconds since a perfect landing for its ring burst. */
  stumbling: boolean;
  perfectAge: number | null;
  /** The boarding rule against the committed train, or the nearest one while idle. */
  check: BoardingCheck | null;
  /** The train the check is against: only its markers show. */
  trainId: string | null;
  rangeTiles: number;
  timeSec: number;
  /** The car the player is aboard, drawn open, and the player's world position in it. */
  aboard: { trainId: string; index: number; x: number; y: number } | null;
  /** The horse's speed in tiles per second, and whether it is in mud, for the mud cue. */
  horseSpeed: number;
  inMud: boolean;
  /** The band of the screen in view, top and bottom in unzoomed iso y pixels, for hiding far boulders. */
  viewTop: number;
  viewBottom: number;
  /** The nearest point on the run's train to the horse, for the stretched hole and the edge glow; null hides both. */
  gap?: { trainId: string; index: number; x: number; y: number; distance: number } | null;
}

export interface WorldScene {
  root: Container;
  mapOverlay: Container;
  zoneOverlay: Graphics;
  /** Ground height under a world point, in tiles of z (0 on maps without elevation). */
  groundZ(x: number, y: number): number;
  update(input: WorldSceneInput): void;
}

/** The hole's mask: a circle round the horse or player, or a tapered band from it to the car side. */
function drawHole(m: Graphics, hole: { x: number; y: number; to: { x: number; y: number } | null }): void {
  const r0 = CUTOUT_RADIUS * TILE_H;
  m.circle(hole.x, hole.y, r0).fill(0xffffff);
  if (!hole.to) return;
  const r1 = GAP_HOLE_END_RADIUS * TILE_H, { x, y } = hole.to;
  const dx = x - hole.x, dy = y - hole.y, n = Math.hypot(dx, dy) || 1, px = -dy / n, py = dx / n;
  m.circle(x, y, r1).fill(0xffffff);
  m.poly([hole.x + px * r0, hole.y + py * r0, x + px * r1, y + py * r1, x - px * r1, y - py * r1, hole.x - px * r0, hole.y - py * r0]).fill(0xffffff);
}

/** A warm strip on the ground along the car side nearest the horse: `t` from 0 (just in reach) to 1 (touching). */
function drawGapGlow(g: Graphics, car: CarPose, at: { x: number; y: number }, t: number, colour: number): void {
  const along = (at.x - car.x) * car.ux + (at.y - car.y) * car.uy;
  const s = (at.x - car.x) * car.uy - (at.y - car.y) * car.ux >= 0 ? 1 : -1;
  const lx = car.uy * s, ly = -car.ux * s;
  const half = 1 + 3 * t;
  const a0 = Math.max(-car.halfLength, along - half), a1 = Math.min(car.halfLength, along + half);
  const strip = (out: number, alpha: number) => {
    const p = (a: number, o: number): [number, number] => [car.x + car.ux * a + lx * (car.halfWidth + o), car.y + car.uy * a + ly * (car.halfWidth + o)];
    g.poly(isoPoly([p(a0, 0), p(a1, 0), p(a1, out), p(a0, out)], 0.01)).fill({ color: colour, alpha });
  };
  strip(0.15 + 0.4 * t, 0.1 + 0.2 * t);
  strip(0.06 + 0.1 * t, 0.25 + 0.45 * t);
}

/** One slice of a car: its box, and which of its faces are the car's real ends. */
function carSlices(car: CarPose): { box: Box; along0: number; along1: number; first: boolean; last: boolean }[] {
  const n = Math.ceil((car.halfLength * 2) / SLICE_TILES);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a1 = car.halfLength - i * SLICE_TILES, a0 = Math.max(-car.halfLength, a1 - SLICE_TILES);
    const mid = (a0 + a1) / 2;
    out.push({
      box: { x: car.x + car.ux * mid, y: car.y + car.uy * mid, ux: car.ux, uy: car.uy, halfLength: (a1 - a0) / 2, halfWidth: car.halfWidth, z0: 0, z1: CAR_HEIGHT },
      along0: a0, along1: a1, first: i === 0, last: i === n - 1,
    });
  }
  return out;
}

/** Door spans on each side of a template, as [from, to] along the car from its centre toward the front. */
function doorSpans(template: string): { side: 'left' | 'right'; a0: number; a1: number }[] {
  const t = CAR_TEMPLATES[template];
  if (!t) return [];
  const hl = t.size.cols / 2, spans: { side: 'left' | 'right'; a0: number; a1: number }[] = [];
  t.cells.forEach((cell, i) => {
    if (cell !== 'door') return;
    const col = i % t.size.cols, row = Math.floor(i / t.size.cols);
    spans.push({ side: row === 0 ? 'left' : 'right', a0: hl - col - 1, a1: hl - col });
  });
  return spans;
}

function drawPlayer(g: Graphics, p: { x: number; y: number }, colour = PLAYER_COLOUR): void {
  drawBox(g, { x: p.x, y: p.y, ux: 1, uy: 0, halfLength: WALKER_RADIUS, halfWidth: WALKER_RADIUS, z0: 0, z1: 1.7 }, colour);
}

/** The horse: a body box along its heading, a head, legs, and the rider on top. */
/** Mix two colours, `t` of the way from a to b. */
const mix = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * (1 - t) + ((b >> s) & 0xff) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

function drawHorse(g: Graphics, h: ActorPose, flash: number | null, muddiness: number, gz = 0): void {
  const body: Box = { x: h.x - h.hx * 0.15, y: h.y - h.hy * 0.15, ux: h.hx, uy: h.hy, halfLength: 0.75, halfWidth: 0.3, z0: 0.45, z1: 1.15 };
  const head: Box = { x: h.x + h.hx * 0.75, y: h.y + h.hy * 0.75, ux: h.hx, uy: h.hy, halfLength: 0.28, halfWidth: 0.2, z0: 0.9, z1: 1.5 };
  const legs: Box = { ...body, halfLength: 0.6, halfWidth: 0.22, z0: 0, z1: 0.45 };
  const rider: Box = { x: h.x - h.hx * 0.2, y: h.y - h.hy * 0.2, ux: h.hx, uy: h.hy, halfLength: 0.22, halfWidth: 0.22, z0: 1.15, z1: 2.05 };
  for (const b of [body, head, legs, rider]) { b.z0 += gz; b.z1 += gz; }
  const c = flash ?? HORSE_COLOUR;
  drawBox(g, legs, flash ?? mix(shade(c, 0.7), MUDDY_LEGS, muddiness));
  drawBox(g, body, c);
  drawBox(g, head, c);
  drawBox(g, rider, flash ?? RIDER_COLOUR);
}

export function createWorldScene(map: MapDef): WorldScene {
  const root = new Container();
  root.label = 'iso-world';
  const terrain = drawTerrain(map);
  const shadows = new Graphics();
  const floors = new Graphics();
  const objects = new Container();
  objects.sortableChildren = true;
  const markers = new Graphics();
  // Boarding range circles: off until B, which Devlin found clearer in the Phase 1 gate playtest.
  const zoneOverlay = new Graphics();
  zoneOverlay.visible = false;
  const mapOverlay = drawIsoMapOverlay(map);
  mapOverlay.visible = false;
  const field = createHeightField(map);
  const ground = createHeightLayer(map, field);
  const rocks = createRocks(map, field);
  const mud = createMud();
  root.addChild(terrain, mapOverlay, mud.prints, shadows, floors, objects, zoneOverlay, markers);
  objects.addChild(...ground.strips, ...rocks.strips, mud.clods);

  const slicePool: Graphics[] = [];
  const horseG = new Graphics();
  const playerG = new Graphics();
  objects.addChild(horseG, playerG);
  // Each pooled slice has its own copy of the hole (a mask serves one object), used inverted.
  const holes: Graphics[] = [], holed: boolean[] = [];
  // The hole around the hidden horse or player, stretched to a point on the car side (`to`) when it shows the gap.
  let hole: { x: number; y: number; to: { x: number; y: number } | null } | null = null;
  const piece = (cut = false) => {
    let g = slicePool[used];
    if (!g) {
      g = new Graphics(); slicePool.push(g); objects.addChild(g);
      const m = new Graphics(); holes.push(m); holed.push(false); root.addChild(m);
    }
    const m = holes[used]!;
    m.clear();
    if (cut && hole) drawHole(m, hole);
    if (cut !== holed[used]) { g.setMask({ mask: cut ? m : null, inverse: true }); holed[used] = cut; }
    g.visible = true;
    g.clear();
    used++;
    return g;
  };
  let used = 0;

  /** One slice of the open car: its floor on the floor layer, then low walls with gaps at the doors, each sorted on its own. */
  const drawOpenSlice = (s: ReturnType<typeof carSlices>[number], doors: ReturnType<typeof doorSpans>, colour: number) => {
    const b = s.box;
    floors.poly(isoPoly(boxCorners(b), 0.02)).fill(FLOOR_COLOUR);
    const mid = (s.along0 + s.along1) / 2;
    const wall = (a0: number, a1: number, across: number, halfWidth: number, ux: number, uy: number) => {
      const am = (a0 + a1) / 2 - mid, lx = b.uy, ly = -b.ux;
      const box: Box = { x: b.x + b.ux * am + lx * across, y: b.y + b.uy * am + ly * across, ux, uy, halfLength: (a1 - a0) / 2, halfWidth, z0: 0, z1: OPEN_WALL_HEIGHT };
      const g = piece();
      drawBox(g, box, colour);
      g.zIndex = depthOf(box.x, box.y);
    };
    const inner = b.halfWidth - OPEN_WALL_THICK / 2;
    for (const side of ['left', 'right'] as const) {
      // The side wall over this slice, minus the door openings on that side.
      let cuts = [[s.along0, s.along1]];
      for (const d of doors) {
        if (d.side !== side) continue;
        cuts = cuts.flatMap(([c0, c1]) => [[c0!, Math.min(c1!, d.a0)], [Math.max(c0!, d.a1), c1!]]).filter(([c0, c1]) => c1! - c0! > 1e-6);
      }
      for (const [c0, c1] of cuts) wall(c0!, c1!, side === 'left' ? inner : -inner, OPEN_WALL_THICK / 2, b.ux, b.uy);
    }
    // End walls on the car's real ends, across the car.
    const endWall = (along: number) => {
      const a = along - mid;
      const box: Box = { x: b.x + b.ux * a, y: b.y + b.uy * a, ux: b.ux, uy: b.uy, halfLength: OPEN_WALL_THICK / 2, halfWidth: b.halfWidth, z0: 0, z1: OPEN_WALL_HEIGHT };
      const g = piece();
      drawBox(g, box, colour);
      g.zIndex = depthOf(box.x, box.y);
    };
    if (s.first) endWall(s.along1 - OPEN_WALL_THICK / 2);
    if (s.last) endWall(s.along0 + OPEN_WALL_THICK / 2);
  };

  return {
    root, mapOverlay, zoneOverlay,
    groundZ: field.groundZ,
    update(input) {
      // Cars: every slice is its own sortable child, redrawn at the car's current angle.
      used = 0;
      rocks.cull(input.viewTop, input.viewBottom);
      ground.cull(input.viewTop, input.viewBottom);
      const horseZ = input.horse ? field.groundZ(input.horse.x, input.horse.y) : 0;
      mud.update({ horse: input.horse, speed: input.horseSpeed, inMud: input.inMud, timeSec: input.timeSec, groundZ: horseZ });
      shadows.clear();
      floors.clear();
      // Who to keep in sight: the player aboard, or the horse by its nose, middle and tail.
      const actor = input.aboard ?? input.horse;
      const keep: [number, number][] = [];
      if (input.aboard) keep.push([input.aboard.x, input.aboard.y]);
      else if (input.horse) {
        const h = input.horse;
        for (const k of [-0.8, 0, 0.8]) keep.push([h.x + h.hx * k, h.y + h.hy * k]);
      }
      // Hidden behind any car, they get a hole through every closed slice: a slice whose centre is
      // behind them can still cover the ground around them, so the hole is cut through all of them.
      const hidden = keep.some(([x, y]) => input.cars.some((car) => carHides(car, CAR_HEIGHT, x, y, HIDDEN_HEIGHTS)));
      hole = hidden && actor ? { x: isoX(actor.x, actor.y), y: isoY(actor.x, actor.y, 1), to: null } : null;
      // On the far side of the run's train, the hole reaches the car so the ground between shows.
      const gap = input.horse && !input.aboard ? input.gap ?? null : null;
      const gapCar = gap ? input.cars.find((c) => c.trainId === gap.trainId && c.index === gap.index) : undefined;
      if (gap && gapCar && input.horse && gap.distance <= GAP_HOLE_TILES && depthOf(input.horse.x, input.horse.y) < depthOf(gapCar.x, gapCar.y)) {
        const h = input.horse;
        hole = { x: isoX(h.x, h.y), y: isoY(h.x, h.y, 1), to: { x: isoX(gap.x, gap.y), y: isoY(gap.x, gap.y, 0) } };
      }
      const glow = gap && gapCar && gap.distance <= GAP_GLOW_TILES ? 1 - gap.distance / GAP_GLOW_TILES : 0;
      const glowColour = gap && gap.distance <= GAP_DANGER_TILES ? GAP_DANGER_COLOUR : GAP_GLOW_COLOUR;
      if (gap && gapCar && glow > 0) drawGapGlow(floors, gapCar, gap, glow, glowColour);
      for (const car of input.cars) {
        const colour = CAR_COLOURS[car.template] ?? 0x777777;
        const doors = doorSpans(car.template);
        // A soft shadow under the car, offset down-right like the light.
        const shadow = boxCorners({ ...car, x: car.x + 0.5, y: car.y + 0.5, halfWidth: car.halfWidth + 0.4, z0: 0, z1: 0 });
        shadows.poly(isoPoly(shadow)).fill({ color: 0x000000, alpha: 0.22 });
        const open = input.aboard?.trainId === car.trainId && input.aboard.index === car.index;
        for (const s of carSlices(car)) {
          if (open) { drawOpenSlice(s, doors, colour); continue; }
          const g = piece(hole !== null);
          // Inner slice ends are hidden by their neighbours; only the car's real ends are drawn.
          drawBox(g, s.box, colour, [!s.first, false, !s.last, false]);
          for (const d of doors) {
            const a0 = Math.max(d.a0, s.along0), a1 = Math.min(d.a1, s.along1);
            if (a1 <= a0) continue;
            // sidePanel measures along the slice from its own centre.
            const mid = (s.along0 + s.along1) / 2;
            sidePanel(g, s.box, d.side, a0 - mid, a1 - mid, 0.15, CAR_HEIGHT - 0.4, DOOR_COLOUR);
          }
          if (gap && gapCar === car && glow > 0) {
            // The glow on the near wall's bottom edge, where that face is in view.
            const along = (gap.x - car.x) * car.ux + (gap.y - car.y) * car.uy, half = 1 + 3 * glow;
            const a0 = Math.max(s.along0, along - half), a1 = Math.min(s.along1, along + half);
            const side = (gap.x - car.x) * car.uy - (gap.y - car.y) * car.ux >= 0 ? 'left' : 'right';
            const mid = (s.along0 + s.along1) / 2;
            if (a1 > a0) {
              // A faint wash up the wall, and a bright line along the bottom.
              sidePanel(g, s.box, side, a0 - mid, a1 - mid, 0, 0.1 + 0.25 * glow, glowColour, 0.12 + 0.25 * glow);
              sidePanel(g, s.box, side, a0 - mid, a1 - mid, 0, 0.05, glowColour, 0.4 + 0.5 * glow);
            }
          }
          if (s.first) {
            // A pale chevron on the roof at the front, so the direction of travel reads at a glance.
            const b = s.box, lx = b.uy, ly = -b.ux, tip = b.halfLength - 0.2, back = tip - 1.4;
            g.poly(isoPoly([
              [b.x + b.ux * tip, b.y + b.uy * tip],
              [b.x + b.ux * back + lx * 1.4, b.y + b.uy * back + ly * 1.4],
              [b.x + b.ux * back - lx * 1.4, b.y + b.uy * back - ly * 1.4],
            ], CAR_HEIGHT + 0.01)).fill({ color: 0xffffff, alpha: 0.55 });
          }
          g.zIndex = depthOf(s.box.x, s.box.y);
        }
      }
      for (let i = used; i < slicePool.length; i++) slicePool[i]!.visible = false;

      // The player aboard, walking in the open car.
      playerG.clear();
      playerG.visible = input.aboard !== null;
      if (input.aboard) {
        const p = input.aboard;
        groundEllipse(playerG, p.x, p.y, WALKER_RADIUS).fill({ color: 0x000000, alpha: 0.3 });
        if (input.perfectAge !== null && input.perfectAge < PERFECT_RING_SEC) {
          // A green ring bursting out from the feet.
          const t = input.perfectAge / PERFECT_RING_SEC;
          groundEllipse(playerG, p.x, p.y, 0.4 + t * 2.2, 0.05).stroke({ width: 4, color: PERFECT_COLOUR, alpha: 1 - t });
        }
        // Stumbling: wobble side to side and flash amber.
        const wobble = input.stumbling ? Math.sin(input.timeSec * 22) * 0.12 : 0;
        const colour = input.stumbling && flashOn(input.timeSec) ? GOOD_COLOUR : PLAYER_COLOUR;
        drawPlayer(playerG, { x: p.x + wobble, y: p.y - wobble }, colour);
        playerG.zIndex = depthOf(p.x, p.y);
      }

      // The horse: a body box along its heading, a head, and the rider on top.
      horseG.clear();
      horseG.visible = input.horse !== null;
      if (input.horse) {
        const h = input.horse;
        // A crash flashes red, a failed jump's stun white.
        const flash = input.hitAge !== null && flashOn(input.hitAge) ? HIT_COLOUR
          : input.stunned && flashOn(input.timeSec) ? 0xffffff : null;
        // The shadow goes with the horse, so raised ground drawn in front of the shadows layer cannot hide it.
        groundEllipse(horseG, h.x + 0.2, h.y + 0.2, HORSE_RADIUS * 0.9, horseZ).fill({ color: 0x000000, alpha: 0.25 });
        drawHorse(horseG, h, flash, mud.muddiness, horseZ);
        horseG.zIndex = depthOf(h.x, h.y);
      }

      // Debug zones: the boarding range around every entry point (B toggles).
      zoneOverlay.clear();
      for (const car of input.cars) for (const ep of carEntryPoints(car)) groundEllipse(zoneOverlay, ep.x, ep.y, input.rangeTiles);
      zoneOverlay.stroke({ width: 2, color: 0xffffff, alpha: 0.45 });

      // Entry markers on the riding side of the checked train: dim out of range, a ring when in
      // range at the wrong speed, highlighted when matched. They draw over the cars so a door on
      // the far side still shows.
      markers.clear();
      const c = input.check;
      if (input.horse && c && input.trainId) {
        for (const car of input.cars) {
          if (car.trainId !== input.trainId) continue;
          for (const ep of carEntryPoints(car)) {
            if (ep.side !== c.side) continue;
            const isNearest = c.car === car.index && c.entry === ep.id;
            const state: BoardingState = isNearest ? c.state : 'too far';
            const col = MARKER_COLOURS[state];
            const x = isoX(ep.x, ep.y), y = isoY(ep.x, ep.y, 1.2);
            if (state === 'eligible') groundEllipse(markers, ep.x, ep.y, input.rangeTiles).fill({ color: col, alpha: 0.28 }).stroke({ width: 3, color: col });
            else if (state !== 'too far') groundEllipse(markers, ep.x, ep.y, input.rangeTiles).stroke({ width: 3, color: col });
            const r = state === 'too far' ? 7 : 11;
            markers.poly([x, y - r * 1.4, x + r, y, x, y + r * 1.4, x - r, y])
              .fill({ color: col, alpha: state === 'too far' ? 0.45 : 1 })
              .stroke({ width: 2, color: 0x111111, alpha: state === 'too far' ? 0.3 : 0.8 });
          }
        }
      }
    },
  };
}

