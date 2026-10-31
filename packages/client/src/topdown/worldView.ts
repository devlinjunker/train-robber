// Top-down debug view of the sim's trains and horse, in tile units like the map overlay. The
// isometric view is the game's; V switches to this one to check what the sim really holds.
import { Container, Graphics } from 'pixi.js';
import { COMMITTED_COLOUR, flashOn, SWITCH_CANDIDATE_COLOUR, SWITCH_FLASH_SEC, type TrainFocus } from '../cues';
import { HORSE_RADIUS, WALKER_RADIUS, carEntryPoints, carTemplate, type BoardingCheck, type BoardingState, type CarPose } from '@train-robber/sim';
import type { SceneContent } from '../iso/worldScene';
import { CATEGORY_COLOURS, colourOf } from '../iso/interior';
import { GUARD_STATE_COLOURS, type ConeView, type GuardView } from '../guards';
import { drawEar, drawEye, drawQuestion } from '../iso/worldScene';

/** The debug view colours every cell by its catalog colour, so the layout the sim walks is what shows. */
function drawCar(content: SceneContent, template: string): Graphics {
  const t = carTemplate(content.catalog, template);
  const hl = t.size.cols / 2, hw = t.size.rows / 2;
  const g = new Graphics();
  // Local x runs toward the car's front, local y toward its right side; col 0 is the front (local x = +hl), row 0 the left side (local y = -hw).
  t.cells.forEach((cell, i) => {
    const col = i % t.size.cols, row = Math.floor(i / t.size.cols);
    g.rect(hl - col - 1, -hw + row, 1, 1).fill(colourOf(content.cellTypes[cell]!.colour));
  });
  g.rect(-hl, -hw, hl * 2, hw * 2).stroke({ width: 0.15, color: 0x111111 });
  // Platforms at both ends, ledges along both sides, and the coupling plate behind (outside.*).
  const o = content.outside;
  if (o) {
    const P = o.platformDepthTiles, L = o.ledgeWidthTiles, G = o.couplingGapTiles, w = Math.min(hw * 2, o.gangwayWidthTiles);
    if (P > 0) g.rect(hl, -hw, P, hw * 2).rect(-hl - P, -hw, P, hw * 2).fill(0x5e4330);
    if (L > 0) g.rect(-hl - P, -hw - L, hl * 2 + 2 * P, L).rect(-hl - P, hw, hl * 2 + 2 * P, L).fill(o.ledges ? 0x6e5038 : 0x42302a);
    if (G > 0) g.rect(-hl - P - G, -w / 2, G, w).fill({ color: 0x3c3c44, alpha: 0.8 });
  }
  // A notch at the front so the direction of travel reads at a glance.
  g.poly([hl - 1.5, -1, hl - 0.3, 0, hl - 1.5, 1]).fill({ color: 0xffffff, alpha: 0.6 });
  return g;
}

/** What the view draws besides the cars, read from the sim each frame. */
export interface ViewInput {
  /** The horse, unless it is abstract (its rider is aboard). */
  horse: { x: number; y: number; hx: number; hy: number } | null;
  /** The boarding rule against the committed train, or the nearest one while idle. */
  check: BoardingCheck | null;
  rangeTiles: number;
  /** The player's world position while aboard. */
  aboard: { x: number; y: number } | null;
  /** Loot lying in the committed train, by car index in its frame. */
  loot?: readonly { car: number; x: number; y: number; item: string; hidden: boolean }[];
  trainId?: string | null;
  /** Flash colours: the horse red after a crash, the player amber while stumbling; null draws the usual colour. */
  horseFlash?: number | null;
  playerFlash?: number | null;
  /** Crouching aboard: the player dot is drawn smaller. */
  crouched?: boolean;
  /** Up on a roof: the player dot is drawn bigger, nearer the camera. */
  onRoof?: boolean;
  /** Outlines on the committed train and the one Tab would switch to. */
  focus?: TrainFocus;
  /** The run's guards in the world, and their sight cones (debug), if shown. */
  guards?: readonly GuardView[];
  cones?: readonly ConeView[] | null;
  /** How far the player's footsteps carry aboard, or null when silent. */
  noise?: { x: number; y: number; r: number; running: boolean } | null;
  /** Trains whose doors a cash-out shut: their doors show red and have no boarding zone. */
  closedTrains?: ReadonlySet<string>;
}

export interface WorldView {
  layer: Container;
  /** The boarding range circles (B toggles them). */
  zones: Graphics;
  update(cars: readonly CarPose[], input: ViewInput): void;
}

const ZONE_COLOURS: Record<BoardingState, number> = { 'too far': 0xffffff, 'too slow': 0xff9f43, 'too fast': 0xff9f43, eligible: 0x6bff8a };

export function createWorldView(content: SceneContent): WorldView {
  const layer = new Container();
  layer.label = 'world-view';
  const carLayer = new Container();
  const entries = new Graphics();
  const outlines = new Graphics();
  const lootG = new Graphics();
  const guardG = new Graphics();
  const zones = new Graphics();
  zones.visible = false;
  const horse = new Graphics(), player = new Graphics();
  const drawHorse = (c: number) => horse.clear()
    .circle(0, 0, HORSE_RADIUS).fill({ color: c, alpha: 0.35 }).stroke({ width: 0.08, color: c })
    .poly([0.75, 0, -0.45, -0.4, -0.45, 0.4]).fill(c);
  const drawPlayer = (c: number) => player.clear().circle(0, 0, WALKER_RADIUS).fill(c).stroke({ width: 0.08, color: 0x0b2a3a });
  let horseColour = -1, playerColour = -1;
  layer.addChild(zones, carLayer, lootG, guardG, outlines, entries, horse, player);
  const pool: Graphics[] = [];

  return {
    layer,
    zones,
    update(cars, input) {
      cars.forEach((car, i) => {
        let g = pool[i];
        if (!g || g.label !== car.template) {
          g?.destroy();
          g = drawCar(content, car.template);
          g.label = car.template;
          pool[i] = g;
          carLayer.addChildAt(g, Math.min(i, carLayer.children.length));
        }
        g.position.set(car.x, car.y);
        g.rotation = Math.atan2(car.uy, car.ux);
      });
      for (const g of pool.splice(cars.length)) g.destroy();
      // The committed train flashes gold just after a commit or switch; the one Tab would switch to is outlined pale blue.
      outlines.clear();
      const f = input.focus;
      if (f) {
        const flashing = f.switchAge !== null && f.switchAge < SWITCH_FLASH_SEC && flashOn(f.switchAge, 6);
        for (const car of cars) {
          const committed = car.trainId === f.committed && flashing;
          if (!committed && car.trainId !== f.candidate) continue;
          // Left of travel is (uy, -ux).
          const lx = car.uy * car.halfWidth, ly = -car.ux * car.halfWidth, fx = car.ux * car.halfLength, fy = car.uy * car.halfLength;
          const pts = [car.x + fx + lx, car.y + fy + ly, car.x + fx - lx, car.y + fy - ly, car.x - fx - lx, car.y - fy - ly, car.x - fx + lx, car.y - fy + ly];
          if (committed) outlines.poly(pts).fill({ color: COMMITTED_COLOUR, alpha: 0.5 });
          outlines.poly(pts).stroke({ width: 0.35, color: committed ? COMMITTED_COLOUR : SWITCH_CANDIDATE_COLOUR });
        }
      }
      // Entry points come from the sim's shared function, as the isometric markers do.
      entries.clear();
      zones.clear();
      const shut = (car: CarPose) => input.closedTrains?.has(car.trainId) ?? false;
      for (const car of cars) {
        if (shut(car)) continue;
        for (const ep of carEntryPoints(car, content.catalog)) {
          entries.circle(ep.x, ep.y, 0.35);
          zones.circle(ep.x, ep.y, input.rangeTiles);
        }
      }
      entries.fill({ color: 0x6bff8a, alpha: 0.9 });
      for (const car of cars) if (shut(car)) for (const ep of carEntryPoints(car, content.catalog)) entries.circle(ep.x, ep.y, 0.35);
      entries.fill({ color: 0xe0503a, alpha: 0.9 });
      // Loot as dots in each car, coloured by category; a hidden stash is dark.
      lootG.clear();
      for (const l of input.loot ?? []) {
        const car = cars.find((c) => c.trainId === input.trainId && c.index === l.car);
        if (!car) continue;
        const along = car.halfLength - l.x, left = car.halfWidth - l.y;
        lootG.circle(car.x + car.ux * along + car.uy * left, car.y + car.uy * along - car.ux * left, 0.3)
          .fill(l.hidden ? 0x3a2e24 : CATEGORY_COLOURS[content.items[l.item]?.category ?? ''] ?? 0xe8b830).stroke({ width: 0.06, color: 0x111111 });
      }
      // Guards as dark dots with a nose the way they face, ringed by their awareness; cones under them.
      guardG.clear();
      for (const cone of input.cones ?? []) {
        const col = GUARD_STATE_COLOURS[cone.state];
        guardG.poly(cone.points.flat()).fill({ color: col, alpha: (cone.state === 'unaware' ? 0.15 : 0.28) * (cone.faint ? 0.5 : 1) });
      }
      // How far your footsteps carry: a guard inside the ring hears you.
      if (input.noise) guardG.circle(input.noise.x, input.noise.y, input.noise.r).stroke({ width: 0.08, color: 0xffffff, alpha: input.noise.running ? 0.45 : 0.2 });
      for (const v of input.guards ?? []) {
        guardG.circle(v.x, v.y, WALKER_RADIUS).fill(0x2c3e66).stroke({ width: 0.1, color: GUARD_STATE_COLOURS[v.state] });
        guardG.moveTo(v.x, v.y).lineTo(v.x + v.fx * 0.6, v.y + v.fy * 0.6).stroke({ width: 0.12, color: GUARD_STATE_COLOURS[v.state] });
        if (v.heard && v.state !== 'alert') drawEar(guardG, v.x, v.y - 0.9, GUARD_STATE_COLOURS.suspicious, 0.04);
        else if (v.searching) drawQuestion(guardG, v.x, v.y - 0.9, GUARD_STATE_COLOURS.alert, 0.04);
        if (v.remembers) drawEye(guardG, v.x + 0.75, v.y - 0.9, 0.04);
      }
      zones.stroke({ width: 0.08, color: 0xffffff, alpha: 0.5 });
      // The nearest door on the riding side fills by the sim's verdict.
      const c = input.check;
      if (input.horse && c?.at && c.state !== 'too far') {
        zones.circle(c.at.x, c.at.y, input.rangeTiles).fill({ color: ZONE_COLOURS[c.state], alpha: 0.3 }).stroke({ width: 0.12, color: ZONE_COLOURS[c.state] });
      }
      const hc = input.horseFlash ?? 0xffd34d, pc = input.playerFlash ?? 0x6bd3ff;
      if (hc !== horseColour) { drawHorse(hc); horseColour = hc; }
      if (pc !== playerColour) { drawPlayer(pc); playerColour = pc; }
      horse.visible = input.horse !== null;
      if (input.horse) {
        horse.position.set(input.horse.x, input.horse.y);
        horse.rotation = Math.atan2(input.horse.hy, input.horse.hx);
      }
      player.visible = input.aboard !== null;
      if (input.aboard) { player.position.set(input.aboard.x, input.aboard.y); player.scale.set((input.crouched ? 0.7 : 1) * (input.onRoof ? 1.35 : 1)); }
    },
  };
}
