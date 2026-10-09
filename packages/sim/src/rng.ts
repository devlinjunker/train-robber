// sfc32 with named streams. State is plain data so it serializes into GameState.
export type StreamName = 'gen' | 'schedule' | 'ai' | 'combat' | 'horse' | 'misc';
export type Sfc32State = [number, number, number, number];
export type RngState = Record<StreamName, Sfc32State>;
export const STREAM_NAMES: readonly StreamName[] = ['gen', 'schedule', 'ai', 'combat', 'horse', 'misc'];

function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function next(s: Sfc32State): number {
  let [a, b, c, d] = s;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  s[0] = a; s[1] = b; s[2] = c; s[3] = d;
  return t >>> 0;
}

/** Derive independent stream states from one seed. */
export function seedRng(seed: number): RngState {
  const out = {} as RngState;
  STREAM_NAMES.forEach((name, i) => {
    const base = mix((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
    const s: Sfc32State = [mix(base + 1), mix(base + 2), mix(base + 3), mix(base + 4)];
    for (let k = 0; k < 12; k++) next(s);
    out[name] = s;
  });
  return out;
}

export function nextU32(rng: RngState, stream: StreamName): number {
  return next(rng[stream]);
}
/** Integer in [0, n). */
export function nextInt(rng: RngState, stream: StreamName, n: number): number {
  return Math.floor((nextU32(rng, stream) / 4294967296) * n);
}
/** Run seed derived from the base seed and run number. */
export function runSeed(seed: number, runNumber: number): number {
  return mix((seed + Math.imul(runNumber + 1, 0x27d4eb2f)) >>> 0);
}
