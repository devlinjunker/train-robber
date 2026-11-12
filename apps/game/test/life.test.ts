import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@train-robber/sim';
import { addEnding, addPoster, lifeCash, lifeEvent, lifeScore, newLife, outlawFor, posterFor, POSTER_WALL_SIZE } from '../src/life';

const NOW = '2026-11-12T03:00:00.000Z';
const SCORE = { cashWeight: 1, perRobbery: 0, perDay: 0 };
const runEnded = (cashOut: number, more: Partial<Extract<SimEvent, { type: 'RunEnded' }>> = {}): SimEvent => ({
  type: 'RunEnded', tick: 1, player: 1, outcome: 'extracted', durationTicks: 60, boardingAttempts: 1, retry: false, countdownLeftSec: null, heat: 0, cashOut, stashed: 0, lootMultiplier: 1, lootLeftValue: 0, lootLeftItems: 0, ...more,
});
const changed = (wantedLevel: number, practice = false): SimEvent => ({
  type: 'PersistentChanged', tick: 1, outcome: 'extracted', before: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, after: { wantedLevel, bank: 0, lifetimeEarned: 0 }, ...(practice ? { practice: true as const } : {}),
});

describe('outlaw names', () => {
  it('follow from the life id, so a reload shows the same outlaw', () => {
    expect(outlawFor('abc')).toEqual(outlawFor('abc'));
    const names = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => outlawFor(id).name));
    expect(names.size).toBeGreaterThan(3);
    expect(outlawFor('abc').name).toMatch(/^[A-Z][a-z]+ [A-Z][A-Za-z]+$/);
  });
});

describe('life record', () => {
  it('counts robberies and the best haul from runs that got loot off the train, never practice or retries', () => {
    let life = newLife('l', 's', 100, NOW);
    for (const e of [runEnded(120), runEnded(0, { outcome: 'caught' }), runEnded(300), runEnded(500, { practice: true }), runEnded(50, { retry: true })]) life = lifeEvent(life, e);
    expect(life).toMatchObject({ robberies: 2, bestHaul: 300 });
    // Bank at a place: loot stashed in the saddlebag counts as the run's haul.
    life = lifeEvent(life, runEnded(0, { stashed: 400 }));
    expect(life).toMatchObject({ robberies: 3, bestHaul: 400 });
  });

  it('keeps the highest wanted level the save reached, not practice', () => {
    let life = newLife('l', 's', 0, NOW);
    for (const e of [changed(2), changed(1), changed(5, true)]) life = lifeEvent(life, e);
    expect(life.maxWanted).toBe(2);
  });

  it('scores cash banked in the life, plus the optional robbery and day bonuses', () => {
    const life = newLife('l', 's', 250, NOW);
    expect(lifeCash(life, 1000)).toBe(750);
    expect(lifeCash(life, 100)).toBe(0);
    expect(lifeScore(750, 3, 2, SCORE)).toBe(750);
    expect(lifeScore(750, 3, 2, { cashWeight: 0.5, perRobbery: 100, perDay: 10 })).toBe(375 + 300 + 20);
  });
});

describe('posters', () => {
  it('a death names the cause and place; riding off says so', () => {
    const life = { ...newLife('l', 's', 100, NOW), robberies: 4, bestHaul: 220, maxWanted: 2 };
    const meta = { endedAt: NOW, preset: 'roguelite', gameVersion: '0.2.5' };
    const died = posterFor(life, { type: 'LifeEnded', tick: 9, player: 1, cause: 'died', days: 3, persistent: { wantedLevel: 3, bank: 0, lifetimeEarned: 700 } }, { cause: 'crushed under a train', place: 'near Town 2' }, SCORE, meta);
    expect(died).toMatchObject({ ending: 'died', reward: 600, cash: 600, robberies: 4, bestHaul: 220, days: 3, maxWanted: 3, cause: 'crushed under a train', place: 'near Town 2', name: life.name, lifeId: 'l' });
    const rode = posterFor(life, { type: 'LifeEnded', tick: 9, player: 1, cause: 'rodeOff', days: 3, persistent: { wantedLevel: 1, bank: 0, lifetimeEarned: 100 } }, { cause: '', place: 'near Town 1' }, SCORE, meta);
    expect(rode).toMatchObject({ ending: 'rodeOff', reward: 0, cause: 'rode off alive', maxWanted: 2 });
  });

  it('a ticket out stamps its tier on the poster and is recorded as an ending reached', () => {
    const life = newLife('l', 's', 0, NOW);
    const tickets = [{ id: 'in-style', name: 'Leave in style', stamp: 'LEFT IN STYLE' }];
    const p = posterFor(life, { type: 'LifeEnded', tick: 9, player: 1, cause: 'rodeOff', days: 4, persistent: { wantedLevel: 2, bank: 100, lifetimeEarned: 4500 }, ticket: 'in-style' }, { cause: '', place: 'near Town 3' }, SCORE, { endedAt: NOW, preset: 'roguelite', gameVersion: 'v', tickets });
    expect(p).toMatchObject({ ending: 'rodeOff', reward: 4500, cause: 'bought a ticket out: Leave in style', ticket: { id: 'in-style', name: 'Leave in style', stamp: 'LEFT IN STYLE' } });
    expect(addEnding([], p)).toEqual(['in-style']);
    expect(addEnding(['in-style'], p)).toEqual(['in-style']);
  });

  it('the wall keeps the newest first, at most POSTER_WALL_SIZE', () => {
    const life = newLife('l', 's', 0, NOW);
    const p = (n: number) => posterFor(life, { type: 'LifeEnded', tick: n, player: 1, cause: 'died', days: 1, persistent: { wantedLevel: 0, bank: 0, lifetimeEarned: n } }, { cause: 'x', place: 'y' }, SCORE, { endedAt: NOW, preset: 'p', gameVersion: 'v' });
    let wall = addPoster([], p(1));
    wall = addPoster(wall, p(2));
    expect(wall.map((x) => x.reward)).toEqual([2, 1]);
    for (let i = 0; i < POSTER_WALL_SIZE + 3; i++) wall = addPoster(wall, p(3));
    expect(wall).toHaveLength(POSTER_WALL_SIZE);
  });
});
