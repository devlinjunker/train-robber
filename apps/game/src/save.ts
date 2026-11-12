// The host's save (phase 2 M5): wanted level, bank and lifetime earned, plus a local leaderboard.
// Version 2 (roguelite life) adds the outlaw riding now (`life`) and the poster wall of past lives.
// The sim never does I/O: it gets PersistentState at creation and reports PersistentChanged at each
// run end; the host saves on that event. LocalStorageStore is the alpha store; an account-backed
// store can replace it later behind the same PersistentStore interface.
import type { PersistentState } from '@train-robber/sim';
import { newLife, POSTER_WALL_SIZE, type LifeRecord, type Poster } from './life';

/** The save format's version. Bump it and add a migration when the stored shape changes. */
export const SAVE_VERSION = 2;
/** Where the save lives in localStorage. */
export const SAVE_KEY = 'train-robber.save';
/** A save that could not be read is copied here (with the time) before the store starts fresh. */
export const BACKUP_KEY_PREFIX = 'train-robber.save.backup.';
/** The leaderboard keeps this many best runs. */
export const LEADERBOARD_SIZE = 20;

/** One banked run on the local leaderboard. */
export interface LeaderboardEntry {
  /** The loot value the run banked. */
  score: number;
  seed: string;
  configHash: string;
  preset: string;
  variants: Record<string, string>;
  /** ISO time the run ended. */
  date: string;
  gameVersion: string;
  outcome: string;
  trainId: string;
  mapId: string;
  /** The wanted level the run was played at. */
  wantedLevel: number;
}

export interface SaveData {
  version: number;
  /**
   * Names this save so the Playtests page can link the runs played on it. A new save (first play,
   * Reset save, or a broken save replaced) gets a new id; a save from before ids gets one on load.
   */
  saveId: string;
  persistent: PersistentState;
  leaderboard: LeaderboardEntry[];
  /** The outlaw riding now. */
  life: LifeRecord;
  /** Every finished life, newest first (at most POSTER_WALL_SIZE). */
  posters: Poster[];
}

/** Why a load started fresh, for the notice the player sees. */
export type LoadProblem = 'corrupt' | 'newer';

export interface LoadResult {
  data: SaveData;
  /** Set when the stored save could not be used: it was backed up under `backupKey` and the save reset. */
  problem?: LoadProblem;
  backupKey?: string;
}

export interface PersistentStore {
  load(): Promise<LoadResult>;
  save(data: SaveData): Promise<void>;
  /** Wipe the save (Reset save). The old one is backed up first; returns its backup key, if there was one. */
  reset(): Promise<string | null>;
}

/** The parts of the Web Storage API the store uses, so tests can pass a plain map. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A random save id, short enough to show on the Playtests page. */
export const newSaveId = (): string => Math.random().toString(36).slice(2, 10);

export const emptySave = (saveId: string, life: LifeRecord): SaveData => ({ version: SAVE_VERSION, saveId, persistent: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, leaderboard: [], life, posters: [] });

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Migrations from each older version to the next. Version 0 is the shape before the save had a
 * version: the three persistent fields at the top level and no leaderboard.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  0: (raw) => ({ version: 1, persistent: { wantedLevel: raw.wantedLevel, bank: raw.bank, lifetimeEarned: raw.lifetimeEarned }, leaderboard: [] }),
  // Version 2 (roguelite life): the save so far becomes the first outlaw's life, made on load.
  1: (raw) => ({ ...raw, version: 2, life: null, posters: [] }),
};

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFace = (v: unknown): boolean => isObj(v) && ['hat', 'beard', 'scar', 'bandana', 'brow'].every((k) => isCount(v[k]));
/** A stored life, or null when it is missing or broken (the load then starts a new outlaw rather than losing the save). */
function parseLife(v: unknown): LifeRecord | null {
  if (!isObj(v) || !isStr(v.id) || !v.id || !isStr(v.seed) || !isStr(v.name) || !isStr(v.nickname) || !isFace(v.face) || !isStr(v.startedAt)) return null;
  if (![v.earnedAtStart, v.robberies, v.bestHaul, v.maxWanted].every(isCount)) return null;
  const d = v.day;
  const day = isObj(d) && isCount(d.day) && isCount(d.health) && isCount(d.trainsToday) ? { day: d.day, health: d.health, trainsToday: d.trainsToday } : null;
  return { ...(v as unknown as LifeRecord), day };
}
const isPoster = (v: unknown): v is Poster => isObj(v) && isStr(v.lifeId) && isStr(v.name) && isFace(v.face) && (v.ending === 'died' || v.ending === 'rodeOff') && isCount(v.reward) && isCount(v.days) && isStr(v.endedAt);

/**
 * Turn stored text into a save: migrate an older version forward, refuse a newer one, and check
 * every field. Returns the problem instead of throwing, so the caller can back up and reset.
 */
export function parseSave(text: string): { data: Omit<SaveData, 'life'> & { life: LifeRecord | null } } | { problem: LoadProblem } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { problem: 'corrupt' }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { problem: 'corrupt' };
  let obj = raw as Record<string, unknown>;
  const v = obj.version === undefined ? 0 : obj.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { problem: 'corrupt' };
  let version: number = v;
  if (version > SAVE_VERSION) return { problem: 'newer' };
  while (version < SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return { problem: 'corrupt' };
    obj = step(obj);
    version = obj.version as number;
  }
  const p = obj.persistent as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return { problem: 'corrupt' };
  if (!isCount(p.wantedLevel) || !Number.isInteger(p.wantedLevel) || !isCount(p.bank) || !isCount(p.lifetimeEarned)) return { problem: 'corrupt' };
  const board = obj.leaderboard === undefined ? [] : obj.leaderboard;
  if (!Array.isArray(board)) return { problem: 'corrupt' };
  // A bad leaderboard row is dropped rather than losing the whole save.
  const leaderboard = board.filter((e): e is LeaderboardEntry => typeof e === 'object' && e !== null && isCount((e as LeaderboardEntry).score) && typeof (e as LeaderboardEntry).seed === 'string');
  const posters = Array.isArray(obj.posters) ? obj.posters.filter(isPoster).slice(0, POSTER_WALL_SIZE) : [];
  return { data: { version: SAVE_VERSION, saveId: typeof obj.saveId === 'string' ? obj.saveId : '', persistent: { wantedLevel: p.wantedLevel, bank: p.bank, lifetimeEarned: p.lifetimeEarned }, leaderboard, life: parseLife(obj.life), posters } };
}

/** The best runs first, at most LEADERBOARD_SIZE; a run that banked nothing is not a score. */
export function addToLeaderboard(board: readonly LeaderboardEntry[], entry: LeaderboardEntry): LeaderboardEntry[] {
  if (!(entry.score > 0)) return [...board];
  return [...board, entry].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)).slice(0, LEADERBOARD_SIZE);
}

/** The save in localStorage under a versioned format. Storage that throws (blocked site data) acts as empty. */
export class LocalStorageStore implements PersistentStore {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = newSaveId,
  ) {}

  private backup(text: string): string {
    const key = `${BACKUP_KEY_PREFIX}${this.now()}`;
    try { this.storage.setItem(key, text); } catch { /* storage full or blocked: the reset still goes ahead */ }
    return key;
  }

  /** A new outlaw: the save's first life, or one started when a stored life could not be read. Its cash counts from 0. */
  private freshLife(): LifeRecord { return newLife(this.newId(), this.newId(), 0, this.now()); }
  private freshSave(): SaveData { return emptySave(this.newId(), this.freshLife()); }

  async load(): Promise<LoadResult> {
    let text: string | null = null;
    try { text = this.storage.getItem(SAVE_KEY); } catch { return { data: this.freshSave() }; }
    if (text === null) {
      const data = this.freshSave();
      await this.save(data);
      return { data };
    }
    const parsed = parseSave(text);
    if ('data' in parsed) {
      const { life, ...rest } = parsed.data;
      if (rest.saveId && life) return { data: { ...rest, life } };
      // A save from before save ids gets one now; one from before lives (or with a broken life) gets an outlaw.
      const data: SaveData = { ...rest, saveId: rest.saveId || this.newId(), life: life ?? this.freshLife() };
      await this.save(data);
      return { data };
    }
    const backupKey = this.backup(text);
    const data = this.freshSave();
    await this.save(data);
    return { data, problem: parsed.problem, backupKey };
  }

  async save(data: SaveData): Promise<void> {
    try { this.storage.setItem(SAVE_KEY, JSON.stringify({ ...data, version: SAVE_VERSION })); } catch (e) { console.warn('Could not save', e); }
  }

  async reset(): Promise<string | null> {
    let text: string | null = null;
    try { text = this.storage.getItem(SAVE_KEY); } catch { /* nothing to back up */ }
    const key = text === null ? null : this.backup(text);
    await this.save(this.freshSave());
    return key;
  }
}
