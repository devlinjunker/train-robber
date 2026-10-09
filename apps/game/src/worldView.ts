// Top-down debug drawing of the sim's trains and horse, in tile units like the map overlay.
// The isometric renderer replaces this in M4.
import { Container, Graphics } from 'pixi.js';
import { CAR_TEMPLATES, HORSE_RADIUS, WALKER_RADIUS, carEntryPoints, type BoardingCheck, type BoardingState, type CarPose, type HorseState } from '@train-robber/sim';

const CAR_COLOURS: Record<string, number> = { engine: 0x3a3a46, 'blank-car': 0x8a4b2d };

function drawCar(template: string): Graphics {
  const t = CAR_TEMPLATES[template]!;
  const hl = t.size.cols / 2, hw = t.size.rows / 2;
  const g = new Graphics();
  // Local x runs toward the car's front, local y toward its right side.
  g.rect(-hl, -hw, hl * 2, hw * 2).fill(CAR_COLOURS[template] ?? 0x777777).stroke({ width: 0.15, color: 0x111111 });
  // Door cells: col 0 is the front (local x = +hl), row 0 the left side (local y = -hw).
  t.cells.forEach((cell, i) => {
    if (cell !== 'door') return;
    const col = i % t.size.cols, row = Math.floor(i / t.size.cols);
    g.rect(hl - col - 1, -hw + row, 1, 1);
  });
  g.fill(0xe8c872);
  // A notch at the front so the direction of travel reads at a glance.
  g.poly([hl - 1.5, -1, hl - 0.3, 0, hl - 1.5, 1]).fill({ color: 0xffffff, alpha: 0.6 });
  return g;
}

/** What the view draws besides the cars, read from the sim each frame. */
export interface ViewInput {
  /** The horse, unless it is abstract (its rider is aboard). */
  horse: HorseState | null;
  /** The boarding rule against the committed train, or the nearest one while idle. */
  check: BoardingCheck | null;
  rangeTiles: number;
  /** The meter while approaching: marker position, zones, and whether it is sweeping. */
  meter: { position: number; perfect: [number, number]; good: [number, number]; sweeping: boolean; matched: boolean } | null;
  /** The player's world position while aboard. */
  aboard: { x: number; y: number } | null;
}

export interface WorldView {
  layer: Container;
  update(cars: readonly CarPose[], input: ViewInput): void;
}

const ZONE_COLOURS: Record<BoardingState, number> = { 'too far': 0xffffff, 'too slow': 0xff9f43, 'too fast': 0xff9f43, eligible: 0x6bff8a };

/** Meter size in tiles, drawn above the horse. */
const METER_W = 5, METER_H = 0.5, METER_UP = 2.2;

export function createWorldView(): WorldView {
  const layer = new Container();
  layer.label = 'world-view';
  const carLayer = new Container();
  const entries = new Graphics();
  const zones = new Graphics();
  const horse = new Graphics()
    .circle(0, 0, HORSE_RADIUS).fill({ color: 0xffd34d, alpha: 0.35 }).stroke({ width: 0.08, color: 0xffd34d })
    .poly([0.75, 0, -0.45, -0.4, -0.45, 0.4]).fill(0xffd34d);
  const meter = new Graphics();
  const player = new Graphics().circle(0, 0, WALKER_RADIUS).fill(0x6bd3ff).stroke({ width: 0.06, color: 0x0b2a3a });
  layer.addChild(zones, carLayer, entries, horse, player, meter);
  const pool: Graphics[] = [];

  return {
    layer,
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
      // Entry points come from the sim's shared function, as the M4 markers will.
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
      horse.visible = input.horse !== null;
      meter.clear();
      if (input.horse) {
        const h = input.horse;
        horse.position.set(h.x, h.y);
        horse.rotation = Math.atan2(h.hy, h.hx);
        const m = input.meter;
        if (m) {
          // Track, good zone, perfect zone, then the marker; dim while not sweeping.
          const x0 = h.x - METER_W / 2, y0 = h.y - METER_UP - METER_H;
          const a = m.sweeping ? 1 : 0.4;
          meter.rect(x0, y0, METER_W, METER_H).fill({ color: 0x1b1b1f, alpha: 0.85 * a });
          meter.rect(x0 + m.good[0] * METER_W, y0, (m.good[1] - m.good[0]) * METER_W, METER_H).fill({ color: 0xe8c872, alpha: a });
          meter.rect(x0 + m.perfect[0] * METER_W, y0, (m.perfect[1] - m.perfect[0]) * METER_W, METER_H).fill({ color: 0x6bff8a, alpha: a });
          // White marker on the slow, speed-matched sweep; orange on the fast one.
          meter.rect(x0 + m.position * METER_W - 0.06, y0 - 0.15, 0.12, METER_H + 0.3).fill({ color: m.matched ? 0xffffff : 0xff9f43, alpha: a });
          meter.rect(x0, y0, METER_W, METER_H).stroke({ width: 0.06, color: 0xffffff, alpha: 0.6 * a });
        }
      }
      player.visible = input.aboard !== null;
      if (input.aboard) player.position.set(input.aboard.x, input.aboard.y);
    },
  };
}
