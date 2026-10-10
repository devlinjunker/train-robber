// Test config and maps built in code, so sim tests do not depend on the config package.
// Tests may use trig; only sim source may not.
import type { SimConfig, SimMap, SimRoute } from '../src';

type Horse = SimConfig['values']['horse'];
type Values = SimConfig['values'];

/** Like the real base config at 60 Hz; `more` replaces whole sections. */
export function testConfig(horse: Partial<Horse> = {}, hash = 'test0001', more: Partial<Omit<Values, 'horse'>> = {}): SimConfig {
  const rad = (120 * Math.PI) / 180 / 60;
  return {
    hash,
    values: {
      sim: { tickRateHz: 60 },
      player: { speedTilesPerTick: 8 / 60 },
      world: { mode: 'separate' },
      commit: { rangeTiles: 12 },
      boarding: {
        rangeTiles: 2, speedToleranceTilesPerSec: 2,
        meter: { sweepPeriodTicks: 72, matchedSweepPeriodTicks: 108, zoneWidths: [0.1, 0.25] },
        failure: { stunTicks: 90, damageFraction: 0.25, horseSpeedScale: 0.5 },
        landing: { stumbleTicks: 30, stumbleSpeedScale: 0.5 },
      },
      health: { max: 100 },
      collision: { damageFraction: 0.1, minImpactTilesPerSec: 4, cooldownTicks: 60 },
      playtest: { quickRetry: true, quickRetryGapTiles: 60 },
      outcomePolicy: {
        died: { bankRunLoot: false, wantedDelta: 0, bankLossFraction: 0, reset: [] },
        cancelled: { bankRunLoot: false, wantedDelta: 0 },
      },
      horse: {
        maxSpeed: 14, accel: 8, brake: 12, dragTilesPerSec2: 4, cruiseTargetRateTilesPerSec2: 10, slowZoneSpeedScale: 0.5,
        turnRateCosPerTick: Math.cos(rad), turnRateSinPerTick: Math.sin(rad), steering: 'heading', throttleModel: 'hold',
        ...horse,
      },
      trains: { blank: { route: 'main', speedTilesPerTick: 9 / 60, cars: [{ template: 'engine' }, { template: 'blank-car', count: 3 }] } },
      ...more,
    },
  };
}

/**
 * Clockwise stadium (y grows down): the top straight runs right along y = cy - r from
 * x0 to x1, a U-turn of radius r, then the bottom straight runs left along y = cy + r.
 */
export function stadium(x0 = 40, x1 = 160, cy = 50, r = 20, spacing = 0.5): SimRoute {
  const straight = x1 - x0, arc = Math.PI * r;
  const length = 2 * straight + 2 * arc;
  const n = Math.round(length / spacing);
  const step = length / n;
  const at = (d: number): [number, number] => {
    if (d < straight) return [x0 + d, cy - r];
    d -= straight;
    if (d < arc) { const a = -Math.PI / 2 + d / r; return [x1 + r * Math.cos(a), cy + r * Math.sin(a)]; }
    d -= arc;
    if (d < straight) return [x1 - d, cy + r];
    d -= straight;
    const a = Math.PI / 2 + d / r;
    return [x0 + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const x: number[] = [], y: number[] = [], s: number[] = [], tx: number[] = [], ty: number[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = at(i * step), [bx, by] = at(((i + 1) % n) * step);
    const len = Math.hypot(bx - ax, by - ay);
    x.push(ax); y.push(ay); s.push(i * step); tx.push((bx - ax) / len); ty.push((by - ay) / len);
  }
  return { id: 'main', closed: true, length, spacing: step, samples: { x, y, s, tx, ty } };
}

export type Paint = (x: number, y: number) => 'open' | 'slow' | 'blocked' | 'water';

/** An open 200 x 100 map with the stadium route; `paint` sets other zones per tile. */
export function testMap(paint: Paint = () => 'open', spawn = { x: 100, y: 90 }): SimMap {
  const cols = 200, rows = 100;
  const legend = ['open', 'slow', 'blocked', 'water'] as const;
  const zones: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = legend.indexOf(paint(c, r));
      const last = zones[zones.length - 1];
      if (last && last[1] === z) last[0]++;
      else zones.push([1, z]);
    }
  }
  return { id: 'test', size: { cols, rows }, zoneLegend: [...legend], zones, routes: [stadium()], markers: { playerSpawn: spawn } };
}
