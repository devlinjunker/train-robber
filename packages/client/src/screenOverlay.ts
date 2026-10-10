// Screen-space cues drawn over the world at a fixed size, whatever the zoom: the boarding meter
// and speed readout above the horse, and edge arrows with distances to trains off screen.
import { Container, Graphics, Text } from 'pixi.js';
import type { BoardingCheck } from '@train-robber/sim';
import { speedLabel } from './cues';

/**
 * Meter size in screen pixels, the same at every zoom. It matches PR #6's widened top-down meter
 * (14 by 0.9 tiles at 24 px and zoom 1.75), which Devlin asked for after the M3 playtest, and
 * never takes more than 90% of a narrow screen.
 */
export const METER_W = 588, METER_H = 38;
const METER_ABOVE = 96;
const EDGE_MARGIN = 36;

export interface MeterView {
  position: number;
  perfect: [number, number];
  good: [number, number];
  sweeping: boolean;
  matched: boolean;
}

export interface TrainPointer {
  id: string;
  /** Screen position of the train's nearest car. */
  sx: number;
  sy: number;
  distanceTiles: number;
  committed: boolean;
}

export interface ScreenOverlayInput {
  width: number;
  height: number;
  /** The horse's screen position, or null when it is not drawn. */
  horse: { x: number; y: number } | null;
  meter: MeterView | null;
  check: BoardingCheck | null;
  toleranceTilesPerSec: number;
  showSpeed: boolean;
  trains: readonly TrainPointer[];
}

const style = (size: number, fill = 0xffffff) => ({ fill, fontSize: size, fontFamily: 'monospace', fontWeight: 'bold' as const, stroke: { color: 0x000000, width: 4 } });

export function createScreenOverlay(): { root: Container; update(input: ScreenOverlayInput): void } {
  const root = new Container();
  root.label = 'screen-overlay';
  const meter = new Graphics();
  const speed = new Text({ text: '', style: style(18) });
  speed.anchor.set(0.5, 0);
  const arrows = new Graphics();
  const labels: Text[] = [];
  root.addChild(arrows, meter, speed);

  return {
    root,
    update(input) {
      meter.clear();
      speed.visible = false;
      if (input.horse) {
        const w = Math.min(METER_W, input.width * 0.9);
        const x0 = input.horse.x - w / 2, y0 = input.horse.y - METER_ABOVE - METER_H;
        const m = input.meter;
        if (m) {
          // Track, good zone, perfect zone, then the marker; dim while parked out of range.
          const a = m.sweeping ? 1 : 0.45;
          meter.roundRect(x0 - 4, y0 - 4, w + 8, METER_H + 8, 6).fill({ color: 0x000000, alpha: 0.55 * a });
          meter.rect(x0, y0, w, METER_H).fill({ color: 0x2a2a30, alpha: a });
          meter.rect(x0 + m.good[0] * w, y0, (m.good[1] - m.good[0]) * w, METER_H).fill({ color: 0xe8c872, alpha: a });
          meter.rect(x0 + m.perfect[0] * w, y0, (m.perfect[1] - m.perfect[0]) * w, METER_H).fill({ color: 0x6bff8a, alpha: a });
          // White marker on the slow, speed-matched sweep; orange on the fast one.
          meter.rect(x0 + m.position * w - 3, y0 - 8, 6, METER_H + 16).fill({ color: m.matched ? 0xffffff : 0xff9f43, alpha: a }).stroke({ width: 1.5, color: 0x000000, alpha: a });
          meter.rect(x0, y0, w, METER_H).stroke({ width: 2, color: 0xffffff, alpha: 0.7 * a });
        }
        if (input.showSpeed && input.check) {
          const l = speedLabel(input.check, input.toleranceTilesPerSec);
          speed.text = l.text;
          speed.style.fill = l.colour;
          speed.position.set(input.horse.x, (m ? y0 + METER_H + 10 : input.horse.y - METER_ABOVE));
          speed.visible = true;
        }
      }

      // Edge arrows: a train whose nearest car is off screen gets an arrow on the edge toward it.
      arrows.clear();
      let used = 0;
      const cx = input.width / 2, cy = input.height / 2;
      for (const t of input.trains) {
        const inside = t.sx >= 0 && t.sx <= input.width && t.sy >= 0 && t.sy <= input.height;
        if (inside) continue;
        const dx = t.sx - cx, dy = t.sy - cy;
        const k = Math.min((cx - EDGE_MARGIN) / Math.abs(dx || 1e-9), (cy - EDGE_MARGIN) / Math.abs(dy || 1e-9));
        const ax = cx + dx * k, ay = cy + dy * k;
        const n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n;
        const colour = t.committed ? 0xffd34d : 0xffffff;
        arrows.poly([ax + ux * 18, ay + uy * 18, ax - uy * 12 - ux * 6, ay + ux * 12 - uy * 6, ax + uy * 12 - ux * 6, ay - ux * 12 - uy * 6])
          .fill(colour).stroke({ width: 2, color: 0x000000 });
        let label = labels[used];
        if (!label) { label = new Text({ text: '', style: style(14) }); label.anchor.set(0.5); labels.push(label); root.addChild(label); }
        label.visible = true;
        label.text = `${t.id} ${t.distanceTiles.toFixed(0)}t`;
        label.style.fill = colour;
        label.position.set(ax - ux * 34, ay - uy * 26);
        used++;
      }
      for (let i = used; i < labels.length; i++) labels[i]!.visible = false;
    },
  };
}
