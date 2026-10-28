import { describe, expect, it } from 'vitest';
import { addToLeaderboard, BACKUP_KEY_PREFIX, LEADERBOARD_SIZE, LocalStorageStore, SAVE_KEY, SAVE_VERSION, emptySave, parseSave, type KeyValueStorage, type LeaderboardEntry } from '../src/save';

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(k: string) { return this.items.get(k) ?? null; }
  setItem(k: string, v: string) { this.items.set(k, v); }
  removeItem(k: string) { this.items.delete(k); }
}

const NOW = '2026-10-28T09:00:00.000Z';
const store = (m = new MemoryStorage()) => ({ m, s: new LocalStorageStore(m, () => NOW) });
const entry = (score: number, date = NOW): LeaderboardEntry => ({ score, seed: 's', configHash: 'h', preset: 'alpha-default', variants: {}, date, gameVersion: '0.2.5', outcome: 'extracted', trainId: 'mail-1', mapId: 'alpha-flats', wantedLevel: 0 });

describe('LocalStorageStore', () => {
  it('starts empty, saves and loads back under the versioned key', async () => {
    const { m, s } = store();
    expect(await s.load()).toEqual({ data: emptySave() });
    const data = { version: SAVE_VERSION, persistent: { wantedLevel: 2, bank: 340, lifetimeEarned: 900 }, leaderboard: [entry(340)] };
    await s.save(data);
    expect(JSON.parse(m.getItem(SAVE_KEY)!).version).toBe(SAVE_VERSION);
    expect(await s.load()).toEqual({ data });
  });

  it('migrates an unversioned (version 0) save forward', async () => {
    const { m, s } = store();
    m.setItem(SAVE_KEY, JSON.stringify({ wantedLevel: 1, bank: 50, lifetimeEarned: 75 }));
    const r = await s.load();
    expect(r.problem).toBeUndefined();
    expect(r.data).toEqual({ version: 1, persistent: { wantedLevel: 1, bank: 50, lifetimeEarned: 75 }, leaderboard: [] });
  });

  it.each([
    ['not JSON', '{oops'],
    ['not an object', '[1,2]'],
    ['a bad version', JSON.stringify({ version: 'one' })],
    ['a missing field', JSON.stringify({ version: 1, persistent: { wantedLevel: 1, bank: 2 }, leaderboard: [] })],
    ['a negative bank', JSON.stringify({ version: 1, persistent: { wantedLevel: 1, bank: -2, lifetimeEarned: 0 }, leaderboard: [] })],
    ['a fractional wanted level', JSON.stringify({ version: 1, persistent: { wantedLevel: 1.5, bank: 0, lifetimeEarned: 0 }, leaderboard: [] })],
    ['a leaderboard that is not a list', JSON.stringify({ version: 1, persistent: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, leaderboard: {} })],
  ])('backs up and resets a corrupt save (%s)', async (_, text) => {
    const { m, s } = store();
    m.setItem(SAVE_KEY, text);
    const r = await s.load();
    expect(r.problem).toBe('corrupt');
    expect(r.data).toEqual(emptySave());
    expect(r.backupKey).toBe(`${BACKUP_KEY_PREFIX}${NOW}`);
    expect(m.getItem(r.backupKey!)).toBe(text);
    // The reset save is written, so the next load is clean.
    expect(await s.load()).toEqual({ data: emptySave() });
  });

  it('backs up and resets a save from a newer version', async () => {
    const { m, s } = store();
    const text = JSON.stringify({ version: SAVE_VERSION + 1, persistent: { wantedLevel: 3, bank: 1, lifetimeEarned: 1 }, leaderboard: [] });
    m.setItem(SAVE_KEY, text);
    const r = await s.load();
    expect(r.problem).toBe('newer');
    expect(m.getItem(r.backupKey!)).toBe(text);
    expect(r.data.persistent).toEqual({ wantedLevel: 0, bank: 0, lifetimeEarned: 0 });
  });

  it('drops bad leaderboard rows but keeps the rest of the save', () => {
    const r = parseSave(JSON.stringify({ version: 1, persistent: { wantedLevel: 0, bank: 5, lifetimeEarned: 5 }, leaderboard: [entry(5), { score: 'x' }, null] }));
    expect('data' in r && r.data.leaderboard).toEqual([entry(5)]);
  });

  it('reset backs up the old save and starts fresh', async () => {
    const { m, s } = store();
    await s.save({ version: 1, persistent: { wantedLevel: 4, bank: 10, lifetimeEarned: 10 }, leaderboard: [] });
    const key = await s.reset();
    expect(key).toBe(`${BACKUP_KEY_PREFIX}${NOW}`);
    expect(JSON.parse(m.getItem(key!)!).persistent.wantedLevel).toBe(4);
    expect((await s.load()).data).toEqual(emptySave());
    // Nothing saved yet: nothing to back up.
    expect(await store().s.reset()).toBeNull();
  });

  it('acts as empty when storage throws (blocked site data)', async () => {
    const broken: KeyValueStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    const s = new LocalStorageStore(broken);
    expect(await s.load()).toEqual({ data: emptySave() });
    await expect(s.save(emptySave())).resolves.toBeUndefined();
  });
});

describe('leaderboard', () => {
  it('keeps the best runs first, at most LEADERBOARD_SIZE, and skips runs that banked nothing', () => {
    let board: LeaderboardEntry[] = [];
    for (let i = 1; i <= LEADERBOARD_SIZE + 5; i++) board = addToLeaderboard(board, entry(i * 10));
    expect(board).toHaveLength(LEADERBOARD_SIZE);
    expect(board[0]!.score).toBe((LEADERBOARD_SIZE + 5) * 10);
    expect(board.at(-1)!.score).toBe(60);
    expect(addToLeaderboard(board, entry(0))).toEqual(board);
    // Ties: the earlier run ranks first.
    const tie = addToLeaderboard([entry(50, '2026-10-28T10:00:00Z')], entry(50, '2026-10-28T08:00:00Z'));
    expect(tie.map((e) => e.date)).toEqual(['2026-10-28T08:00:00Z', '2026-10-28T10:00:00Z']);
  });
});
