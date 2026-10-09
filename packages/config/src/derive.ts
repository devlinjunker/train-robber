// Resolve step 4: turn authored units into what the sim uses per tick, so the sim
// never converts units or calls trig. The rule is chosen by key suffix:
//
//   xDegPerSec    -> xCosPerTick, xSinPerTick   rotation per tick as a cos/sin pair
//   xHalfAngleDeg -> xCos                        cone test threshold for dot products
//   xPerSec       -> xPerTick                    rate per tick
//   xSec          -> xTicks                      whole ticks (number or array of numbers)
//
// The source key is kept next to the derived one. Trig results are rounded so
// engines that differ in the last bits still produce the same config hash.

type Num = number | readonly number[];

type DerivedKeys<T> = {
  readonly [K in keyof T & string as T[K] extends Num
    ? K extends `${infer B}DegPerSec` ? `${B}CosPerTick` | `${B}SinPerTick`
    : K extends `${infer B}HalfAngleDeg` ? `${B}Cos`
    : K extends `${infer B}PerSec` ? `${B}PerTick`
    : K extends `${infer B}Sec` ? `${B}Ticks`
    : never
    : never]: T[K] extends readonly number[] ? readonly number[] : number;
};

export type Derived<T> =
  T extends readonly unknown[] ? Readonly<T>
  : T extends object ? { readonly [K in keyof T]: Derived<T[K]> } & DerivedKeys<T>
  : T;

const TRIG_DIGITS = 1e12;
const round = (x: number) => Math.round(x * TRIG_DIGITS) / TRIG_DIGITS;
const DEG = Math.PI / 180;

function mapNum(v: unknown, f: (n: number) => number): number | number[] | undefined {
  if (typeof v === 'number') return f(v);
  if (Array.isArray(v) && v.every((n) => typeof n === 'number')) return v.map(f);
  return undefined;
}

export function derive<T>(values: T, tickRateHz: number): Derived<T> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    const src = v as Record<string, unknown>;
    const set = (key: string, val: unknown) => {
      if (Object.hasOwn(src, key)) throw new Error(`derived key ${key} is also set in config`);
      out[key] = val;
    };
    for (const [k, child] of Object.entries(src)) {
      out[k] = walk(child);
      let m: RegExpMatchArray | null;
      if ((m = k.match(/^(.*)DegPerSec$/))) {
        const perTick = mapNum(child, (d) => (d * DEG) / tickRateHz);
        if (typeof perTick === 'number') {
          set(`${m[1]}CosPerTick`, round(Math.cos(perTick)));
          set(`${m[1]}SinPerTick`, round(Math.sin(perTick)));
        }
      } else if ((m = k.match(/^(.*)HalfAngleDeg$/))) {
        const c = mapNum(child, (d) => round(Math.cos(d * DEG)));
        if (c !== undefined) set(`${m[1]}Cos`, c);
      } else if ((m = k.match(/^(.*)PerSec$/))) {
        const r = mapNum(child, (n) => n / tickRateHz);
        if (r !== undefined) set(`${m[1]}PerTick`, r);
      } else if ((m = k.match(/^(.*)Sec$/))) {
        const t = mapNum(child, (s) => Math.round(s * tickRateHz));
        if (t !== undefined) set(`${m[1]}Ticks`, t);
      }
    }
    return out;
  };
  return walk(values) as Derived<T>;
}

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}
