// Top-down debug view of the sim's trains and horse, in tile units like the map overlay. The
// isometric view is the game's; V switches to this one to check what the sim really holds.
import { Container, Graphics } from 'pixi.js';
import { CAR_TEMPLATES, HORSE_RADIUS, WALKER_RADIUS, carEntryPoints, type BoardingCheck, type BoardingState, type CarPose } from '@train-robber/sim';

const CAR_COLOURS: Record<string, number> = { engine: 0x3a3a46, 'blank-car': 0x8a4b2d };

function drawCar(template: string): Graphics {
  const t = CAR_TEMPLATES[template]!;
  const hl = t.size.cols / 2, hw = t.size.rows / 2;
  const g = new Graphics();
  // Local x runs toward the car's front, local y toward its right side.
  g.rect(-hl, -hw, hl * 2, hw * 2).fill(CAR_COLOURS[template] ?? 0x777777).stroke({ width: 0.15, color: 0x111111 });
  // Door cells: col 0 is the front (local x = +hl), row 0 the left side (local y = -hw).
  // Only fill when there are doors: an empty fill would repaint the body in the door colour.
  let doors = 0;
  t.cells.forEach((cell, i) => {
    if (cell !== 'door') return;
    const col = i % t.size.cols, row = Math.floor(i / t.size.cols);
    g.rect(hl - col - 1, -hw + row, 1, 1);
    doors++;
  });
  if (doors > 0) g.fill(0xe8c872);
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
  /** Flash colours: the horse red after a crash, the player amber while stumbling; null draws the usual colour. */
  horseFlash?: number | null;
  playerFlash?: number | null;
}

export interface WorldView {
  layer: Container;
  /** The boarding range circles (B toggles them). */
  zones: Graphics;
  update(cars: readonly CarPose[], input: ViewInput): void;
}

const ZONE_COLOURS: Record<BoardingState, number> = { 'too far': 0xffffff, 'too slow': 0xff9f43, 'too fast': 0xff9f43, eligible: 0x6bff8a };

export function createWorldView(): WorldView {
  const layer = new Container();
  layer.label = 'world-view';
  const carLayer = new Container();
  const entries = new Graphics();
  const zones = new Graphics();
  const horse = new Graphics(), player = new Graphics();
  const drawHorse = (c: number) => horse.clear()
    .circle(0, 0, HORSE_RADIUS).fill({ color: c, alpha: 0.35 }).stroke({ width: 0.08, color: c })
    .poly([0.75, 0, -0.45, -0.4, -0.45, 0.4]).fill(c);
  const drawPlayer = (c: number) => player.clear().circle(0, 0, WALKER_RADIUS).fill(c).stroke({ width: 0.08, color: 0x0b2a3a });
  let horseColour = -1, playerColour = -1;
  layer.addChild(zones, carLayer, entries, horse, player);
  const pool: Graphics[] = [];

  return {
    layer,
    zones,
    update(cars, input) {
      cars.forEach((car, i) => {
        let g = pool[i];
        if (!g || g.label !== car.template) {
          g?.destroy();
          g = drawCar(car.template);
          g.label = car.template;
          pool[i] = g;
          carLayer.addChildAt(g, Math.min(i, carLayer.children.length));
        }
        g.position.set(car.x, car.y);
        g.rotation = Math.atan2(car.uy, car.ux);
      });
      for (const g of pool.splice(cars.length)) g.destroy();
      // Entry points come from the sim's shared function, as the isometric markers do.
      entries.clear();
      zones.clear();
      for (const car of cars) {
        for (const ep of carEntryPoints(car)) {
          entries.circle(ep.x, ep.y, 0.35);
          zones.circle(ep.x, ep.y, input.rangeTiles);
        }
      }
      entries.fill({ color: 0x6bff8a, alpha: 0.9 });
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
      if (input.aboard) player.position.set(input.aboard.x, input.aboard.y);
    },
  };
}
