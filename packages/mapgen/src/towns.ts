// Towns along an open line (G6): each town spot planWorld laid out (a flat clearing beside the
// track) becomes a town with a name, a size and a layout of buildings, and an open line gets a
// town off each end where trains set out from and arrive. Everything here comes from the seed and
// where the town sits along the line, from its own hashed streams, so it never moves the terrain:
// a line's tiles are the same as before towns had names. The buildings are for the view only.
// Deterministic maths only (see dmath.ts).
import { TOWN_SIZES, type MapDef, type MapGenSettings, type TownBuilding, type TownBuildingKind, type TownSize } from '@train-robber/config';
import { rng, type Rng } from './dmath';
import type { Track } from './track';
import type { TownSpot } from './world';

export type Town = NonNullable<MapDef['towns']>[number];

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

const FIRST = [
  'Dusty', 'Red', 'Copper', 'Dry', 'Silver', 'Coyote', 'Eagle', 'Buzzard', 'Lone', 'Sweetwater', 'Cactus', 'Rattlesnake',
  'Bitter', 'Gold', 'Iron', 'Broken', 'Stony', 'Hollow', 'Mule', 'Painted', 'Sundown', 'Whiskey', 'Juniper', 'Cotton',
  'Bluff', 'Horseshoe', 'Antelope', 'Sagebrush', 'Paradise', 'Tombstone',
] as const;
const LAST = [
  'Gulch', 'Springs', 'Flats', 'Bend', 'Junction', 'Creek', 'Wells', 'Rock', 'Mesa', 'Crossing', 'Ridge', 'Fork',
  'Butte', 'Canyon', 'Hollow', 'Station', 'Point', 'Draw', 'Pass', 'City',
] as const;

/** A town's name from the seed and its place along the line, never one already `taken` on the line. */
export function townName(seed: string, d: number, taken: ReadonlySet<string>): string {
  for (let i = 0; ; i++) {
    const r = rng(`${seed}/town-name/${d}/${i}`);
    const first = FIRST[r.int(0, FIRST.length - 1)]!, last = LAST[r.int(0, LAST.length - 1)]!;
    const name = first === last ? first : `${first} ${last}`;
    if (!taken.has(name)) return name;
  }
}

/** A town's size, weighted by `towns.sizeWeights`. */
export function townSize(r: Rng, weights: MapGenSettings['line']['towns']['sizeWeights']): TownSize {
  const total = TOWN_SIZES.reduce((n, s) => n + weights[s], 0);
  let u = r.next() * total;
  for (const s of TOWN_SIZES) { u -= weights[s]; if (u < 0 && weights[s] > 0) return s; }
  return TOWN_SIZES.filter((s) => weights[s] > 0).at(-1)!;
}

/** Buildings beside the street, picked in turn for each lot, by size. */
const STREET: Record<TownSize, { lots: [number, number]; kinds: readonly TownBuildingKind[] }> = {
  halt: { lots: [0, 1], kinds: ['house'] },
  village: { lots: [3, 5], kinds: ['store', 'house', 'stable', 'house', 'house'] },
  town: { lots: [7, 11], kinds: ['saloon', 'store', 'church', 'house', 'stable', 'house', 'store', 'house', 'house', 'house', 'house'] },
};

/** Size of each kind: [length along the street, depth, height] in tiles. */
const BUILDING_SIZE: Record<TownBuildingKind, [number, number, number]> = {
  station: [8, 4.5, 3], platform: [0, 2, 0.35], 'water-tower': [2.2, 2.2, 5.5],
  house: [4, 4, 2.4], store: [6, 5, 3], saloon: [7, 6, 3.6], church: [5, 8, 4.2], stable: [6, 5, 2.6],
};

/**
 * A town's buildings, laid out in its clearing from its own stream: a platform beside the track, the
 * station behind it at the clearing's edge, a water tower beside a station that has none, and a street
 * through the middle of the clearing, parallel to the track, with lots on both sides. Every building
 * stays inside the clearing (the platform stands on the open lane between the track and the clearing).
 */
export function townLayout(r: Rng, size: TownSize, spot: TownSpot, ux: number, uy: number, gapTiles: number): TownBuilding[] {
  const R = spot.radiusTiles;
  // Unit vectors: `u` along the line, `o` out from the track towards the clearing.
  const ox = -uy * spot.side, oy = ux * spot.side;
  // The track's centre line beside the town, from the clearing's middle back in.
  const reach = gapTiles + R;
  const tx = spot.x - ox * reach, ty = spot.y - oy * reach;
  const out: TownBuilding[] = [];
  const at = (kind: TownBuildingKind, along: number, outward: number, length?: number) => {
    const [l, w, h] = BUILDING_SIZE[kind];
    out.push({
      kind, x: r4(tx + ux * along + ox * outward), y: r4(ty + uy * along + oy * outward), ux: r4(ux), uy: r4(uy),
      halfLength: r4((length ?? l) / 2), halfWidth: r4(w / 2), heightTiles: h,
    });
  };
  /** True when a building centred `along`, `outward` with these half sizes sits inside the clearing with a tile to spare. */
  const fits = (along: number, outward: number, hl: number, hw: number) => {
    const dv = outward - reach;
    for (const [a, b] of [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]] as const) {
      const du = along + a, dw = dv + b;
      if (du * du + dw * dw > (R - 1) * (R - 1)) return false;
    }
    return true;
  };
  const platformHalf = size === 'town' ? 14 : size === 'village' ? 10 : 7;
  // Cars are about 7 tiles wide: the platform starts just past their side.
  at('platform', 0, 5.5, platformHalf * 2);
  // The station stands back from the clearing's edge, off centre when it fits.
  const [sl, sw] = BUILDING_SIZE.station, stationOut = gapTiles + 4.5;
  const shift = r4(r.range(-3, 3));
  const stationAlong = fits(shift, stationOut, sl / 2, sw / 2) ? shift : 0;
  at('station', stationAlong, stationOut);
  const towerSide = r.next() < 0.5 ? -1 : 1;
  const towerAlong = stationAlong + towerSide * 8;
  if (fits(towerAlong, gapTiles + 2, 1.1, 1.1)) at('water-tower', towerAlong, gapTiles + 2);
  // The street: lots of one kind after another along each side, nearer side first.
  const street = STREET[size];
  const lots = r.int(street.lots[0], street.lots[1]);
  let placed = 0;
  for (const offset of [-5.5, 5.5]) {
    const outward = reach + offset + (offset > 0 ? 1 : 0);
    let along = -R + 2;
    while (placed < lots && along < R - 2) {
      const kind = street.kinds[placed % street.kinds.length]!;
      const [l, w] = BUILDING_SIZE[kind];
      const centre = along + l / 2;
      // Keep the station and the water tower clear on the near side.
      const nearStation = offset < 0 && Math.abs(centre - stationAlong) < l / 2 + 5;
      if (!nearStation && fits(centre, outward, l / 2, w / 2)) {
        at(kind, r4(centre), outward);
        placed++;
        along += l + r.range(1, 2.5);
      } else {
        along += 1;
      }
    }
  }
  return out;
}

/**
 * The towns of an open line, east-facing (generate.ts mirrors them for `direction: west`): each spot
 * becomes a town in place, and with `endTowns` a town is added off each end of the line, at its
 * first and last sample, with no clearing. Sorted by distance along the line; spot ids stay.
 */
export function lineTowns(seed: string, spots: readonly TownSpot[], track: Track, s: MapGenSettings['line']['towns']): Town[] {
  const { route, tangents } = track;
  const taken = new Set<string>();
  const named = (d: number) => { const n = townName(seed, d, taken); taken.add(n); return n; };
  const towns: Town[] = [];
  const last = route.samples.x.length - 1;
  if (s.endTowns) {
    towns.push({ id: 'line-start', name: named(0), size: 'town', route: route.id, d: 0, x: route.samples.x[0]!, y: route.samples.y[0]!, side: 1, radiusTiles: 0, end: 'start', layout: [] });
  }
  for (const spot of spots) {
    const r = rng(`${seed}/town/${spot.d}`);
    const size = townSize(r, s.sizeWeights);
    const i = Math.round(spot.d / route.spacing);
    const tg = tangents[i]!;
    towns.push({ ...spot, name: named(spot.d), size, layout: townLayout(r, size, spot, tg.x, tg.y, s.gapTiles) });
  }
  if (s.endTowns) {
    towns.push({ id: 'line-end', name: named(route.length), size: 'town', route: route.id, d: route.length, x: route.samples.x[last]!, y: route.samples.y[last]!, side: 1, radiusTiles: 0, end: 'end', layout: [] });
  }
  return towns.sort((a, b) => a.d - b.d);
}
