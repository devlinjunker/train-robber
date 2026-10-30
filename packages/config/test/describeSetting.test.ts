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
});
