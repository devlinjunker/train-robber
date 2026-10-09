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

/** FNV-1a over the string's UTF-16 code units, then a final mix. */
function hashString(s: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return mix(h);
}

/** Four 32-bit words from a seed string, warmed up so similar seeds diverge. */
function streamState(seed: string): Sfc32State {
  const s: Sfc32State = [hashString(seed, 1), hashString(seed, 2), hashString(seed, 3), hashString(seed, 4)];
  for (let k = 0; k < 12; k++) next(s);
  return s;
}

/** Derive independent stream states from one seed string: each stream hashes seed + its name. */
export function seedRng(seed: string): RngState {
  const out = {} as RngState;
  for (const name of STREAM_NAMES) out[name] = streamState(`${seed}/${name}`);
  return out;
}

export function nextU32(rng: RngState, stream: StreamName): number {
  return next(rng[stream]);
}
/** Integer in [0, n). */
export function nextInt(rng: RngState, stream: StreamName, n: number): number {
  return Math.floor((nextU32(rng, stream) / 4294967296) * n);
}
/** Run seed derived from the base seed and run number only, not from earlier play. */
export function runSeed(seed: string, runNumber: number): string {
  return `${seed}#run${runNumber}`;
}
