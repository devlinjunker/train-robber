// The isometric world: terrain and track, cars drawn as flat-shaded boxes in two-tile slices
// that depth-sort one by one against the horse, entry markers and the debug overlays.
import { Container, Graphics } from 'pixi.js';
import { CAR_TEMPLATES, carEntryPoints, HORSE_RADIUS, WALKER_RADIUS, type BoardingCheck, type BoardingState, type CarPose } from '@train-robber/sim';
import type { MapDef } from '@train-robber/config';
import { boxCorners, drawBox, groundEllipse, isoPoly, shade, sidePanel, type Box } from './draw';
import { drawIsoMapOverlay, drawTerrain } from './terrain';
import { hiddenByCars } from './occlusion';
import { depthOf, isoX, isoY } from '../projection';
import type { ActorPose } from '../interp';

export const CAR_COLOURS: Record<string, number> = { engine: 0x4a4a58, 'blank-car': 0x9a5534 };
const DOOR_COLOUR = 0xe8c872;
/** Slice length along a car, in tiles; each slice sorts on its own. */
export const SLICE_TILES = 2;
const CAR_HEIGHT = 2.4;
/** The car the player is in is drawn open: no roof, low walls and a plank floor, so they show inside it. */
const OPEN_WALL_HEIGHT = 0.9, OPEN_WALL_THICK = 0.3, FLOOR_COLOUR = 0x846446;
const PLAYER_COLOUR = 0x6bd3ff;
const HORSE_COLOUR = 0x8a5a32, RIDER_COLOUR = 0x6bd3ff;
/** Behind a car, the horse and rider (or the player) show through it as a flat see-through silhouette. */
const XRAY_COLOUR = 0xdff4ff, XRAY_ALPHA = 0.5, XRAY_HEIGHTS = [0.6, 1.6];

const MARKER_COLOURS: Record<BoardingState, number> = { 'too far': 0xc8c8c8, 'too slow': 0xff9f43, 'too fast': 0xff9f43, eligible: 0x6bff8a };

export interface WorldSceneInput {
  cars: readonly CarPose[];
  /** The horse, unless it is abstract (its rider is aboard). */
  horse: ActorPose | null;
  stunned: boolean;
  /** The boarding rule against the committed train, or the nearest one while idle. */
  check: BoardingCheck | null;
  /** The train the check is against: only its markers show. */
  trainId: string | null;
  rangeTiles: number;
  timeSec: number;
  /** The car the player is aboard, drawn open, and the player's world position in it. */
  aboard: { trainId: string; index: number; x: number; y: number } | null;
}

export interface WorldScene {
  root: Container;
  mapOverlay: Container;
  zoneOverlay: Graphics;
  update(input: WorldSceneInput): void;
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

export function createWorldScene(map: MapDef): WorldScene {
  const root = new Container();
  root.label = 'iso-world';
  const terrain = drawTerrain(map);
  const shadows = new Graphics();
  const floors = new Graphics();
  const objects = new Container();
  objects.sortableChildren = true;
  const markers = new Graphics();
  const zoneOverlay = new Graphics();
  const xray = new Graphics();
  xray.alpha = XRAY_ALPHA;
  const mapOverlay = drawIsoMapOverlay(map);
  mapOverlay.visible = false;
  root.addChild(terrain, mapOverlay, shadows, floors, objects, xray, zoneOverlay, markers);

  const slicePool: Graphics[] = [];
  const horseG = new Graphics();
  const playerG = new Graphics();
  objects.addChild(horseG, playerG);
  const piece = () => {
    let g = slicePool[used];
    if (!g) { g = new Graphics(); slicePool.push(g); objects.addChild(g); }
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
    update(input) {
      // Cars: every slice is its own sortable child, redrawn at the car's current angle.
      used = 0;
      shadows.clear();
      floors.clear();
      for (const car of input.cars) {
        const colour = CAR_COLOURS[car.template] ?? 0x777777;
        const doors = doorSpans(car.template);
        // A soft shadow under the car, offset down-right like the light.
        const shadow = boxCorners({ ...car, x: car.x + 0.5, y: car.y + 0.5, halfWidth: car.halfWidth + 0.4, z0: 0, z1: 0 });
        shadows.poly(isoPoly(shadow)).fill({ color: 0x000000, alpha: 0.22 });
        const open = input.aboard && input.aboard.trainId === car.trainId && input.aboard.index === car.index;
        for (const s of carSlices(car)) {
          if (open) { drawOpenSlice(s, doors, colour); continue; }
          const g = piece();
          // Inner slice ends are hidden by their neighbours; only the car's real ends are drawn.
          drawBox(g, s.box, colour, [!s.first, false, !s.last, false]);
          for (const d of doors) {
            const a0 = Math.max(d.a0, s.along0), a1 = Math.min(d.a1, s.along1);
            if (a1 <= a0) continue;
            // sidePanel measures along the slice from its own centre.
            const mid = (s.along0 + s.along1) / 2;
            sidePanel(g, s.box, d.side, a0 - mid, a1 - mid, 0.15, CAR_HEIGHT - 0.4, DOOR_COLOUR);
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

      // Cars that can hide someone: every closed car (the open one has low walls).
      const closed = input.aboard ? input.cars.filter((c) => !(c.trainId === input.aboard!.trainId && c.index === input.aboard!.index)) : input.cars;
      const hidden = (x: number, y: number) => hiddenByCars(closed, CAR_HEIGHT, x, y, XRAY_HEIGHTS);
      xray.clear();

      // The player aboard, walking in the open car.
      playerG.clear();
      playerG.visible = input.aboard !== null;
      if (input.aboard) {
        const p = input.aboard;
        groundEllipse(playerG, p.x, p.y, WALKER_RADIUS).fill({ color: 0x000000, alpha: 0.3 });
        drawBox(playerG, { x: p.x, y: p.y, ux: 1, uy: 0, halfLength: WALKER_RADIUS, halfWidth: WALKER_RADIUS, z0: 0, z1: 1.7 }, PLAYER_COLOUR);
        playerG.zIndex = depthOf(p.x, p.y);
        if (hidden(p.x, p.y)) drawBox(xray, { x: p.x, y: p.y, ux: 1, uy: 0, halfLength: WALKER_RADIUS, halfWidth: WALKER_RADIUS, z0: 0, z1: 1.7 }, XRAY_COLOUR);
      }

      // The horse: a body box along its heading, a head, and the rider on top.
      horseG.clear();
      horseG.visible = input.horse !== null;
      if (input.horse) {
        const h = input.horse;
        const flash = input.stunned && Math.floor(input.timeSec * 8) % 2 === 0;
        groundEllipse(shadows, h.x + 0.2, h.y + 0.2, HORSE_RADIUS * 0.9).fill({ color: 0x000000, alpha: 0.25 });
        const body: Box = { x: h.x - h.hx * 0.15, y: h.y - h.hy * 0.15, ux: h.hx, uy: h.hy, halfLength: 0.75, halfWidth: 0.3, z0: 0.45, z1: 1.15 };
        const head: Box = { x: h.x + h.hx * 0.75, y: h.y + h.hy * 0.75, ux: h.hx, uy: h.hy, halfLength: 0.28, halfWidth: 0.2, z0: 0.9, z1: 1.5 };
        const legs: Box = { ...body, halfLength: 0.6, halfWidth: 0.22, z0: 0, z1: 0.45 };
        const rider: Box = { x: h.x - h.hx * 0.2, y: h.y - h.hy * 0.2, ux: h.hx, uy: h.hy, halfLength: 0.22, halfWidth: 0.22, z0: 1.15, z1: 2.05 };
        const c = flash ? 0xffffff : HORSE_COLOUR;
        drawBox(horseG, legs, shade(c, 0.7));
        drawBox(horseG, body, c);
        drawBox(horseG, head, c);
        drawBox(horseG, rider, flash ? 0xffffff : RIDER_COLOUR);
        horseG.zIndex = depthOf(h.x, h.y);
        if (hidden(h.x, h.y)) for (const b of [legs, body, head, rider]) drawBox(xray, b, XRAY_COLOUR);
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

