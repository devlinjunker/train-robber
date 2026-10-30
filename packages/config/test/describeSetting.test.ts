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
