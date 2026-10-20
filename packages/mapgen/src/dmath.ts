// Deterministic maths for the generator. Everything the sim reads (route samples, zones) is built
// from these, so a seed gives the same map on every machine: only + - * /, Math.sqrt, Math.floor,
// Math.round, Math.abs, Math.min, Math.max and Math.imul, which JavaScript defines exactly.
// Math.sin, Math.cos, Math.pow, Math.hypot and Math.random are not, so they are not used here
// (test/determinism.test.ts scans this package for them).

export const PI = 3.141592653589793;
export const TAU = 2 * PI;

/** sin by range reduction to [-pi/2, pi/2] and a Taylor series to x^15; good to about 1e-12. */
export function dsin(x: number): number {
  let r = x - TAU * Math.round(x / TAU);
  if (r > PI / 2) r = PI - r;
  else if (r < -PI / 2) r = -PI - r;
  const r2 = r * r;
  let term = r, sum = r;
  for (let k = 1; k <= 7; k++) {
    term = (-term * r2) / ((2 * k) * (2 * k + 1));
    sum += term;
  }
  return sum;
}

export const dcos = (x: number): number => dsin(x + PI / 2);

export const dlen = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** 32-bit string hash (FNV-1a with a final mix). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Small seeded generator (mulberry32). */
export interface Rng { next(): number; range(min: number, max: number): number; int(min: number, max: number): number }
export function rng(seed: string): Rng {
  let a = hashString(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
  };
}

/** Hash of three integers to [0, 1). */
export function hash3(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Value noise in [0, 1) on a unit lattice, smoothly interpolated. */
function valueNoise(x: number, y: number, salt: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const a = hash3(x0, y0, salt), b = hash3(x0 + 1, y0, salt);
  const c = hash3(x0, y0 + 1, salt), d = hash3(x0 + 1, y0 + 1, salt);
  const top = a + (b - a) * fx, bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Three octaves of value noise at a feature size of `scale` tiles, stretched so most of [0, 1] is
 * used (plain value noise bunches round 0.5). `salt` keeps layers independent.
 */
export function fbm(x: number, y: number, scale: number, salt: number): number {
  let sum = 0, amp = 1, norm = 0, f = 1 / scale;
  for (let o = 0; o < 3; o++) {
    sum += amp * valueNoise(x * f, y * f, salt + o * 7919);
    norm += amp; amp *= 0.5; f *= 2;
  }
  const v = (sum / norm - 0.5) * 1.9 + 0.5;
  return v < 0 ? 0 : v > 0.9999 ? 0.9999 : v;
}
