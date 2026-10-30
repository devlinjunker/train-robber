import { describe, it, expect } from 'vitest';
import { describeSetting, settingWords } from '../src/playtest';

describe('describeSetting', () => {
  it('reads what a ?set= path takes from the game.json schema', () => {
    const words = (p: string) => settingWords(describeSetting(p));
    for (const p of ['countdown.scale', 'countdown.enabled', 'wanted.forceLevel', 'outcomePolicy.cancelled.wantedDelta', 'ai.fellLootShare', 'cashOut.shutDoorsEndRun']) {
      expect(words(p)).not.toBe('not a setting');
    }
    expect(words('countdown.enabled')).toMatch(/true or false/);
    expect(words('countdown.nope')).toBe('not a setting');
    expect(describeSetting('ai.fellLootShare')?.kind).toMatch(/number/);
  });
});

import { readFileSync } from 'node:fs';
import { settingDocs } from '../src/playtest';

describe('settingDocs', () => {
  it('reads each setting\'s doc comment from schema.ts by path', () => {
    const docs = settingDocs(readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8'));
    expect(docs.get('commit.rangeTiles')).toMatch(/free train this close/);
    expect(docs.get('commit.timerSec')).toMatch(/Staying in range/);
    expect(docs.get('boarding.meter.sweepPeriodSec')).toMatch(/back and forth/);
    expect(docs.get('logging.events')).toBe('Event allowlist for the events log.');
    expect(docs.size).toBeGreaterThan(60);
  });

  it('has a doc comment for every setting in base/game.json, so the experiment editor can explain it', () => {
    const docs = settingDocs(readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8'));
    const base = JSON.parse(readFileSync(new URL('../../content/base/game.json', import.meta.url), 'utf8')) as unknown;
    const paths: string[] = [];
    const walk = (v: unknown, p: string): void => {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, c] of Object.entries(v)) walk(c, p ? `${p}.${k}` : k);
      else if (p && p !== 'schemaVersion') paths.push(p);
    };
    walk(base, '');
    // Record entries (trains.<id>.x) are documented once as trains.*.x.
    const has = (path: string): boolean => {
      const parts = path.split('.');
      return docs.has(path) || parts.some((_, i) => docs.has([...parts.slice(0, i), '*', ...parts.slice(i + 1)].join('.')));
    };
    expect(paths.length).toBeGreaterThan(200);
    expect(paths.filter((path) => !has(path))).toEqual([]);
  });
});
