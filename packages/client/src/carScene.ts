// The `?car=<id>` debug scene: one car template on its own, drawn as in the game, with a walker
// you move with WASD or the arrows (blocked as aboard, so end doors lead nowhere) and overlays
// for checking a layout made in Tiled: 1 cell types, 2 cover, 3 noise, 4 reachable area per entry
// (press again to step through the entries), 5 loot slots, guard spawns and patrols. Nothing here
// runs the sim.
import { Application, Container, Graphics, Text } from 'pixi.js';
import type { ResolvedConfig } from '@train-robber/config';
import { carCatalog, cellOpen, carToWorld, trainCellWalkable, WALKER_RADIUS, type CarPose, type PreparedCar } from '@train-robber/sim';
import { drawInterior, colourOf } from './iso/interior';
import { boxCorners, drawBox, isoPoly } from './iso/draw';
import { clampZoom, depthOf, isoX, isoY, keyDirToWorld, stepZoom } from './projection';

const WALK_TILES_PER_SEC = 4;
const LABEL_STYLE = { fill: '#ffffff', fontSize: 11, fontFamily: 'monospace', stroke: { color: '#000000', width: 3 } } as const;

/** Cells reachable on foot from a cell of a template, as a row-major mask. */
export function reachableFrom(t: PreparedCar, start: readonly [number, number]): Uint8Array {
  const { cols, rows } = t.size;
  const seen = new Uint8Array(cols * rows);
  if (!cellOpen(t, start[0], start[1])) return seen;
  const stack: [number, number][] = [[start[0], start[1]]];
  seen[start[1] * cols + start[0]] = 1;
  while (stack.length) {
    const [c, r] = stack.pop()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc, nr = r + dr;
      if (!cellOpen(t, nc, nr) || seen[nr * cols + nc]) continue;
      seen[nr * cols + nc] = 1;
      stack.push([nc, nr]);
    }
  }
  return seen;
}

/** Shows the car scene for `?car=<id>`, or a list of car ids when the id is unknown. */
export function createCarScene(app: Application, config: ResolvedConfig, carId: string): void {
  const catalog = carCatalog(config);
  const t = catalog.get(carId);
  const cellTypes = config.values.cellTypes;
  if (!t) {
    const ids = [...catalog.keys()];
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;top:16px;left:16px;font:13px monospace;color:#eee';
    div.innerHTML = `<p>No car template <b>${escapeHtml(carId)}</b>. Pick one:</p>` +
      ids.map((id) => `<div><a style="color:#9fd3e8" href="?car=${encodeURIComponent(id)}">${escapeHtml(id)}</a></div>`).join('');
    document.body.appendChild(div);
    return;
  }
  const { cols, rows } = t.size;
  const def = config.values.carTemplates[carId]!;
  // The car's front points down-right on screen (world +x).
  const car: CarPose = { trainId: 'debug', index: 0, template: carId, x: 0, y: 0, ux: 1, uy: 0, halfLength: cols / 2, halfWidth: rows / 2 };
  const at = (c: number, r: number) => carToWorld(car, c, r);

  const root = new Container();
  const floor = new Graphics();
  const objects = new Container();
  objects.sortableChildren = true;
  const overlay = new Graphics();
  const labels = new Container();
  root.addChild(floor, overlay, objects, labels);
  app.stage.addChild(root);
  drawInterior(floor, () => objects.addChild(new Graphics()), { car, template: t, cellTypes, loot: [], items: {}, searching: null, inReach: null, timeSec: 0 });

  // Entry points as arrows on the car's outside, pointing in.
  for (const ep of t.entryPoints) {
    const [c, r] = ep.cell;
    const out = ep.side === 'left' ? [0, -1] : ep.side === 'right' ? [0, 1] : ep.side === 'front' ? [-1, 0] : [1, 0];
    const tip = at(c + 0.5 + out[0]! * 0.6, r + 0.5 + out[1]! * 0.6), tail = at(c + 0.5 + out[0]! * 1.6, r + 0.5 + out[1]! * 1.6);
    floor.moveTo(isoX(tail.x, tail.y), isoY(tail.x, tail.y)).lineTo(isoX(tip.x, tip.y), isoY(tip.x, tip.y)).stroke({ width: 4, color: 0xffe080 });
    floor.circle(isoX(tip.x, tip.y), isoY(tip.x, tip.y), 4).fill(0xffe080);
    addLabel(ep.id, tail.x, tail.y, '#ffe080');
  }

  function addLabel(text: string, x: number, y: number, fill = '#ffffff', z = 0): Text {
    const l = labels.addChild(new Text({ text, style: { ...LABEL_STYLE, fill } }));
    l.anchor.set(0.5);
    l.position.set(isoX(x, y), isoY(x, y, z));
    return l;
  }

  // Overlays: 0 off, 1 cell types, 2 cover, 3 noise, 4 reachable, 5 slots and spawns.
  let mode = 5;
  let entryIndex = -1; // -1: union of every entry
  const reach = t.entryPoints.map((e) => reachableFrom(t, e.cell));
  const cellQuad = (c: number, r: number, inset = 0.04) => {
    const p = at(c + 0.5, r + 0.5);
    return isoPoly(boxCorners({ x: p.x, y: p.y, ux: 1, uy: 0, halfLength: 0.5 - inset, halfWidth: 0.5 - inset, z0: 0, z1: 0 }), 0.04);
  };
  const overlayLabels = new Container();
  labels.addChild(overlayLabels);
  const cellLabel = (text: string, c: number, r: number, fill = '#ffffff') => {
    const p = at(c + 0.5, r + 0.5);
    const l = overlayLabels.addChild(new Text({ text, style: { ...LABEL_STYLE, fill, fontSize: 9 } }));
    l.anchor.set(0.5);
    l.position.set(isoX(p.x, p.y), isoY(p.x, p.y, 0.05));
  };

  function drawOverlay(): void {
    overlay.clear();
    for (const l of overlayLabels.removeChildren()) l.destroy();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const type = cellTypes[t!.cells[r * cols + c]!]!;
        if (mode === 1) {
          overlay.poly(cellQuad(c, r)).fill({ color: colourOf(type.colour), alpha: 0.85 });
          cellLabel(type.id.slice(0, 2), c, r);
        } else if (mode === 2 && type.cover > 0) {
          overlay.poly(cellQuad(c, r)).fill({ color: 0x4080ff, alpha: 0.2 + 0.6 * type.cover });
          cellLabel(String(type.cover), c, r);
        } else if (mode === 3 && type.noise !== undefined) {
          overlay.poly(cellQuad(c, r)).fill({ color: type.noise > 1 ? 0xff6040 : type.noise < 1 ? 0x60c060 : 0x808080, alpha: 0.6 });
          cellLabel(String(type.noise), c, r);
        } else if (mode === 4 && !type.blocksMove) {
          const i = r * cols + c;
          const ok = entryIndex < 0 ? reach.some((m) => m[i]) : reach[entryIndex]![i];
          overlay.poly(cellQuad(c, r)).fill({ color: ok ? 0x40c040 : 0xff3030, alpha: 0.5 });
        }
      }
    }
    if (mode === 5) {
      for (const s of def.lootSlots) {
        const [c, r] = s.cell;
        overlay.poly(cellQuad(c, r, 0.15)).stroke({ width: 2, color: s.tags.includes('hidden') ? 0xb08060 : 0xe8b830 });
        cellLabel(s.tags.join(','), c, r, '#ffe0a0');
      }
      for (const g of def.guardSpawns) {
        const [c, r] = g.cell;
        const p = at(c + 0.5, r + 0.5);
        overlay.circle(isoX(p.x, p.y), isoY(p.x, p.y), 7).fill(0xd04040);
        cellLabel(`guard ${g.facing}${g.patrol ? ` → ${g.patrol}` : ''}`, c, r, '#ffa0a0');
        const path = g.patrol ? def.patrols[g.patrol] : undefined;
        if (path?.length) {
          const pts = path.flatMap(([pc, pr]) => { const q = at(pc + 0.5, pr + 0.5); return [isoX(q.x, q.y), isoY(q.x, q.y)]; });
          overlay.poly(pts, false).stroke({ width: 2, color: 0xd04040, alpha: 0.8 });
        }
      }
    }
  }
  drawOverlay();

  // The walker, starting on the first entry point (or the middle of the car).
  const start = t.entryPoints[0]?.cell ?? [Math.floor(cols / 2), Math.floor(rows / 2)];
  const walker = { x: start[0] + 0.5, y: start[1] + 0.5 };
  const body = objects.addChild(new Graphics());
  const clear = (x: number, y: number) => {
    const open = (px: number, py: number) => trainCellWalkable(catalog, [carId], 0, px, py);
    return open(x - WALKER_RADIUS, y - WALKER_RADIUS) && open(x + WALKER_RADIUS, y - WALKER_RADIUS)
      && open(x - WALKER_RADIUS, y + WALKER_RADIUS) && open(x + WALKER_RADIUS, y + WALKER_RADIUS);
  };

  const info = new Text({ text: '', style: { fill: '#e8e8e8', fontSize: 12, fontFamily: 'monospace', lineHeight: 16 } });
  info.position.set(8, 8);
  app.stage.addChild(info);
  const MODE_NAMES = ['off', 'cell types', 'cover', 'noise', 'reachable', 'slots and spawns'];
  const updateInfo = () => {
    const c = Math.floor(walker.x), r = Math.floor(walker.y);
    const here = cellTypes[t.cells[r * cols + c]!]!;
    const entry = mode === 4 ? (entryIndex < 0 ? ' (every entry)' : ` (from ${t.entryPoints[entryIndex]!.id})`) : '';
    info.text = [
      `car ${carId}  ·  type ${t.carType}  ·  ${cols}×${rows}  ·  from ${def.source.file}`,
      `entries: ${t.entryPoints.map((e) => `${e.id} ${e.side} [${e.cell}]`).join(', ') || 'none'}`,
      `loot slots ${def.lootSlots.length} (${def.lootSlots.filter((s) => s.tags.includes('hidden')).length} hidden)  ·  guard spawns ${def.guardSpawns.length}`,
      `walker [${c},${r}] on ${here.id}  cover ${here.cover}  noise ${here.noise ?? '-'}`,
      `overlay: ${MODE_NAMES[mode]}${entry}`,
      'WASD / arrows walk  ·  0-5 overlay (4 again: next entry)  ·  -/= zoom',
    ].join('\n');
  };

  const held = new Set<string>();
  let zoom = clampZoom(Math.min(app.screen.width / ((cols + rows) * 40), 2));
  addEventListener('keydown', (e) => {
    held.add(e.code);
    const digit = /^Digit([0-5])$/.exec(e.code);
    if (digit) {
      const m = Number(digit[1]);
      if (m === 4 && mode === 4) entryIndex = entryIndex + 1 >= t.entryPoints.length ? -1 : entryIndex + 1;
      else entryIndex = -1;
      mode = m;
      drawOverlay();
    }
    if (e.code === 'Equal') zoom = stepZoom(zoom, 1);
    if (e.code === 'Minus') zoom = stepZoom(zoom, -1);
  });
  addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => held.clear());

  app.ticker.add(() => {
    const dt = Math.min(0.1, app.ticker.deltaMS / 1000);
    const k = (a: string, b: string) => (held.has(a) || held.has(b) ? 1 : 0);
    const [wx, wy] = keyDirToWorld(k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), k('KeyS', 'ArrowDown') - k('KeyW', 'ArrowUp'));
    // World +x is toward the front (car x falls) and world +y toward the right (car y grows).
    const step = WALK_TILES_PER_SEC * dt;
    if (clear(walker.x - wx * step, walker.y)) walker.x -= wx * step;
    if (clear(walker.x, walker.y + wy * step)) walker.y += wy * step;
    const p = at(walker.x, walker.y);
    body.clear();
    drawBox(body, { x: p.x, y: p.y, ux: 1, uy: 0, halfLength: WALKER_RADIUS, halfWidth: WALKER_RADIUS, z0: 0, z1: 1.1 }, 0x3060d0);
    body.zIndex = depthOf(p.x, p.y) + 0.02;
    root.scale.set(zoom);
    root.pivot.set(0, 0);
    root.position.set(app.screen.width / 2, app.screen.height / 2);
    updateInfo();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
