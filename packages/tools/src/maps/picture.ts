// A top-down PNG of a map's zones, track, bridges, trees and spawn, for reviewing layouts
// (`npm run tools -- map-picture`). Tools only; the game never reads it.
import { deflateSync } from 'node:zlib';
import { decodeElevation, decodeZones, SCENERY_KINDS, ZONES, type MapDef, type SceneryDef } from '@train-robber/config';

const COLOURS: Record<string, [number, number, number]> = {
  open: [198, 186, 140], slow: [138, 104, 70], blocked: [100, 100, 100], water: [110, 160, 220], deep: [40, 90, 170],
};

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** `scale` pixels per tile. */
export function mapPicture(map: MapDef, scenery: SceneryDef | null, scale = 3): Buffer {
  const { cols, rows } = map.size;
  const W = cols * scale, H = rows * scale;
  const px = new Uint8Array(W * H * 3);
  const set = (x: number, y: number, c: readonly number[]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3; px[i] = c[0]!; px[i + 1] = c[1]!; px[i + 2] = c[2]!;
  };
  const grid = decodeZones(map), heights = decodeElevation(map);
  for (let t = 0; t < cols * rows; t++) {
    const x = t % cols, y = (t - x) / cols;
    const base = COLOURS[ZONES[grid[t]!]!]!;
    const lift = 1 + heights[t]! * 0.07;
    const c = base.map((v) => Math.min(255, Math.round(v * lift)));
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(x * scale + dx, y * scale + dy, c);
  }
  const dot = (x: number, y: number, r: number, c: readonly number[]) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) set(Math.round(x * scale) + dx, Math.round(y * scale) + dy, c);
  };
  for (let i = 0; i < (scenery?.items.kind.length ?? 0); i++) {
    const k = SCENERY_KINDS[scenery!.items.kind[i]!];
    const c = k === 'tree' ? [40, 110, 40] : k === 'pine' ? [20, 70, 50] : k === 'bush' ? [90, 130, 60] : [210, 120, 190];
    dot(scenery!.items.x[i]!, scenery!.items.y[i]!, k === 'tree' || k === 'pine' ? 1 : 0, c);
  }
  for (const b of scenery?.bridges ?? []) {
    for (let y = Math.round(b.y * scale); y < Math.round((b.y + b.h) * scale); y++) for (let x = Math.round(b.x * scale); x < Math.round((b.x + b.w) * scale); x++) set(x, y, [130, 90, 50]);
  }
  for (const r of map.routes) for (let i = 0; i < r.samples.x.length; i++) dot(r.samples.x[i]!, r.samples.y[i]!, 0, [110, 20, 10]);
  dot(map.markers.playerSpawn.x, map.markers.playerSpawn.y, 3, [230, 30, 30]);
  // Town spots: a ring round the clearing and a dot at the sign.
  for (const t of map.towns ?? []) {
    for (let a = 0; a < 360; a += 2) dot(t.x + t.radiusTiles * Math.cos((a * Math.PI) / 180), t.y + t.radiusTiles * Math.sin((a * Math.PI) / 180), 0, [240, 220, 160]);
    dot(t.x, t.y, Math.max(2, scale), [240, 220, 160]);
  }
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(px.subarray(y * W * 3, (y + 1) * W * 3)).copy(raw, y * (W * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}
