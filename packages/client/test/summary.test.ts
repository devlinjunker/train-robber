import { describe, it, expect } from 'vitest';
import type { SimEvent } from '@train-robber/sim';
import { createSummaryTracker } from '../src';

const ev = (e: Record<string, unknown>) => e as unknown as SimEvent;
const state = { wantedLevel: 0, bank: 0, lifetimeEarned: 0 };

describe('end-of-run summary (issue #79)', () => {
  it('names what a good mount spilled, apart from other losses', () => {
    const t = createSummaryTracker((id) => (id === 'gold-watch' ? 'Gold watch' : id));
    t.event(ev({ type: 'RunStarted', tick: 0, player: 1, runNumber: 1, trainId: 'm', wantedLevel: 0 }));
    t.event(ev({ type: 'LootLost', tick: 5, player: 1, item: 'letters', value: 5, cause: 'fell' }));
    t.event(ev({ type: 'LootSpilled', tick: 10, player: 1, items: ['gold-watch'], value: 40, rule: 'random' }));
    t.event(ev({ type: 'RunEnded', tick: 10, player: 1, outcome: 'extracted', durationTicks: 10, retry: false, heat: 0, cashOut: 108 }));
    const v = t.event(ev({ type: 'PersistentChanged', tick: 10, outcome: 'extracted', before: state, after: { ...state, bank: 108 } }));
    expect(v).toMatchObject({ banked: 108, lost: 5, spill: { what: 'Gold watch', value: 40 } });
  });
  it('a clean mount has no spill, and the next run starts without the last one', () => {
    const t = createSummaryTracker();
    t.event(ev({ type: 'RunStarted', tick: 0, player: 1, runNumber: 1, trainId: 'm', wantedLevel: 0 }));
    t.event(ev({ type: 'LootSpilled', tick: 10, player: 1, items: [], value: 44, rule: 'share' }));
    t.event(ev({ type: 'RunStarted', tick: 20, player: 1, runNumber: 2, trainId: 'm', wantedLevel: 0 }));
    t.event(ev({ type: 'RunEnded', tick: 30, player: 1, outcome: 'extracted', durationTicks: 10, retry: false, heat: 0, cashOut: 50 }));
    expect(t.event(ev({ type: 'PersistentChanged', tick: 30, outcome: 'extracted', before: state, after: state }))).toMatchObject({ spill: null, lost: 0 });
  });
});
