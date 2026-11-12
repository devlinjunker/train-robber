// One outlaw's life (roguelite): the record the save keeps for the outlaw riding now, their seeded
// name and face, the life score, and the poster made when the life ends. Pure: the host feeds it
// the sim's events and decides when to save.
import type { PosterFace, PosterView } from '@train-robber/client';
import type { DayState, SimEvent } from '@train-robber/sim';

/** The outlaw riding now, as the save keeps it. */
export interface LifeRecord {
  id: string;
  /** The map seed this life is played on (`life.seedPerLife`); a `?seed=` in the URL still wins. */
  seed: string;
  name: string;
  nickname: string;
  face: PosterFace;
  startedAt: string;
  /** Lifetime earned when the life began: the life's cash is how far it has risen since. */
  earnedAtStart: number;
  /** Runs that got loot off the train. */
  robberies: number;
  /** The most one run got off the train. */
  bestHaul: number;
  maxWanted: number;
  /** Where the day stood at the last save, so a reload resumes it (`life.resumeOnReload`); null on a new life. */
  day: DayState | null;
}

/** A finished life on the poster wall. */
export interface Poster extends PosterView {
  seed: string;
  startedAt: string;
  preset: string;
  gameVersion: string;
}

export interface ScoreConfig { cashWeight: number; perRobbery: number; perDay: number }

// Western names (poster.nameSet `western`): first names, family names and nicknames.
const FIRST = ['Ada', 'Bill', 'Clem', 'Dolly', 'Eli', 'Etta', 'Frank', 'Grace', 'Hank', 'Ike', 'Jesse', 'Josie', 'Kit', 'Lottie', 'Mattie', 'Ned', 'Opal', 'Pearl', 'Quint', 'Ruby', 'Sam', 'Tom', 'Wade', 'Will', 'Zeke', 'Belle', 'Cole', 'Hattie', 'Jed', 'Nell'];
const LAST = ['Kincaid', 'Holloway', 'Calhoun', 'McCready', 'Barlow', 'Tate', 'Whitlock', 'Garrett', 'Dalton', 'Rourke', 'Pryor', 'Slade', 'Haskins', 'Brennan', 'Coffey', 'Lassiter', 'Monroe', 'Quill', 'Starr', 'Vance', 'Weller', 'Yates', 'Boone', 'Cassidy'];
const NICK = ['Dusty', 'Kid', 'Doc', 'Lucky', 'Red', 'Two-Bit', 'Slim', 'Sidewinder', 'Rattler', 'Mesa', 'Cinders', 'Shotgun', 'Whistle', 'Boxcar', 'Long Rifle', 'Tumbleweed', 'Coyote', 'Smoky', 'Ace', 'Six-Gun'];

/** A small seeded stream (FNV-1a into mulberry32), so a life's name and face follow from its id. */
function stream(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The outlaw's seeded name, nickname and face. */
export function outlawFor(lifeId: string): { name: string; nickname: string; face: PosterFace } {
  const r = stream(`outlaw:${lifeId}`);
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const nickname = pick(NICK);
  const n = (k: number) => Math.floor(r() * k);
  return { name, nickname, face: { hat: n(4), beard: n(4), scar: n(3), bandana: n(2), brow: n(2) } };
}

export function newLife(id: string, seed: string, earnedAtStart: number, startedAt: string): LifeRecord {
  return { id, seed, ...outlawFor(id), startedAt, earnedAtStart, robberies: 0, bestHaul: 0, maxWanted: 0, day: null };
}

/** The life score: cash banked in the life x cashWeight, plus perRobbery per robbery and perDay per day seen. */
export function lifeScore(cash: number, robberies: number, days: number, s: ScoreConfig): number {
  return Math.round(Math.max(0, cash) * s.cashWeight + robberies * s.perRobbery + days * s.perDay);
}

/** Cash the life has banked so far, from lifetime earned now. */
export const lifeCash = (life: LifeRecord, lifetimeEarned: number) => Math.max(0, lifetimeEarned - life.earnedAtStart);

/**
 * Fold one sim event into the life: robberies and the best haul from run ends, the highest wanted
 * level from the save's changes. Practice and quick retries never count. Returns the same record
 * when nothing changed.
 */
export function lifeEvent(life: LifeRecord, e: SimEvent): LifeRecord {
  if (e.type === 'RunEnded' && !e.practice && !e.retry) {
    // What the run got off the train: banked at once, or (bank at a place) stashed to bank later.
    const haul = e.cashOut + e.stashed;
    if (haul > 0) return { ...life, robberies: life.robberies + 1, bestHaul: Math.max(life.bestHaul, haul) };
  } else if (e.type === 'PersistentChanged' && !e.practice && e.after.wantedLevel > life.maxWanted) {
    return { ...life, maxWanted: e.after.wantedLevel };
  }
  return life;
}

/** The poster for a life that just ended (`LifeEnded`). */
export function posterFor(life: LifeRecord, e: Extract<SimEvent, { type: 'LifeEnded' }>, how: { cause: string; place: string }, score: ScoreConfig, meta: { endedAt: string; preset: string; gameVersion: string; tickets?: readonly { id: string; name: string; stamp: string }[] }): Poster {
  const cash = lifeCash(life, e.persistent.lifetimeEarned);
  const died = e.cause === 'died';
  const t = e.ticket ? meta.tickets?.find((x) => x.id === e.ticket) : undefined;
  const ticket = e.ticket ? { id: e.ticket, name: t?.name ?? e.ticket, stamp: t?.stamp ?? 'RODE OFF' } : undefined;
  return {
    lifeId: life.id, name: life.name, nickname: life.nickname, face: life.face, ending: e.cause,
    reward: lifeScore(cash, life.robberies, e.days, score), cash, robberies: life.robberies, bestHaul: life.bestHaul,
    days: e.days, maxWanted: Math.max(life.maxWanted, e.persistent.wantedLevel),
    cause: died ? how.cause : ticket ? `bought a ticket out: ${ticket.name}` : 'rode off alive', place: how.place, ...(ticket ? { ticket } : {}),
    endedAt: meta.endedAt, seed: life.seed, startedAt: life.startedAt, preset: meta.preset, gameVersion: meta.gameVersion,
  };
}

/** The wall keeps this many posters, newest first. */
export const POSTER_WALL_SIZE = 200;
/** The endings a save has reached (ticket ids, for unlocks later), with this poster's added. */
export const addEnding = (endings: readonly string[], p: Poster): string[] => p.ticket && !endings.includes(p.ticket.id) ? [...endings, p.ticket.id] : [...endings];
export const addPoster = (wall: readonly Poster[], p: Poster): Poster[] => [p, ...wall].slice(0, POSTER_WALL_SIZE);
