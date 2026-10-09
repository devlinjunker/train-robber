// Top-down debug drawing of the sim's trains and horse, in tile units like the map overlay.
// The isometric renderer replaces this in M4.
import { Container, Graphics } from 'pixi.js';
import { CAR_TEMPLATES, HORSE_RADIUS, carEntryPoints, type CarPose, type HorseState } from '@train-robber/sim';

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

export interface WorldView {
  layer: Container;
  update(cars: readonly CarPose[], horse: HorseState): void;
}

export function createWorldView(): WorldView {
  const layer = new Container();
  layer.label = 'world-view';
  const carLayer = new Container();
  const entries = new Graphics();
  const horse = new Graphics()
    .circle(0, 0, HORSE_RADIUS).fill({ color: 0xffd34d, alpha: 0.35 }).stroke({ width: 0.08, color: 0xffd34d })
    .poly([0.75, 0, -0.45, -0.4, -0.45, 0.4]).fill(0xffd34d);
  layer.addChild(carLayer, entries, horse);
  const pool: Graphics[] = [];

  return {
    layer,
    update(cars, h) {
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
      for (const car of cars) for (const ep of carEntryPoints(car)) entries.circle(ep.x, ep.y, 0.35);
      entries.fill({ color: 0x6bff8a, alpha: 0.9 });
      horse.position.set(h.x, h.y);
      horse.rotation = Math.atan2(h.hy, h.hx);
    },
  };
}
