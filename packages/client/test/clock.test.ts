import { describe, it, expect } from 'vitest';
import { actionFor, clockStep, clockText, drainText, heatBand, heatNotice, InputMapper, tickBucket, type MapContext } from '../src';

describe('countdown and heat readouts', () => {
  it('colour steps at 50% and 20% of the countdown', () => {
    expect(clockStep(0.8)).toBe('calm');
    expect(clockStep(0.5)).toBe('calm');
    expect(clockStep(0.49)).toBe('low');
    expect(clockStep(0.19)).toBe('critical');
  });
  it('three heat bands by thirds', () => {
    expect(heatBand(0, 100)).toBe('cool');
    expect(heatBand(33, 100)).toBe('cool');
    expect(heatBand(34, 100)).toBe('warm');
    expect(heatBand(67, 100)).toBe('hot');
    expect(heatBand(100, 100)).toBe('hot');
  });
  it('clock text rounds up and the drain rate reads like ×1.6', () => {
    expect(clockText(150)).toBe('2:30');
    expect(clockText(59.01)).toBe('1:00');
    expect(clockText(0.2)).toBe('0:01');
    expect(clockText(0)).toBe('0:00');
    expect(drainText(1.6)).toBe('×1.6');
    expect(heatNotice(15, 'alarmRaised')).toBe('+15 heat: alarm raised');
    expect(heatNotice(1, 'timeAboard')).toBe('+1 heat: lingering aboard');
  });
  it('ticks every 30 s, then every second in the last 30 s', () => {
    const plan = { tickEverySec: 30, finalCountdownSec: 30, finalTickEverySec: 1 };
    const ticks = (from: number, to: number, p = plan, step = 0.01) => {
      let n = 0, last = tickBucket(from, p);
      for (let t = from; t > to; t -= step) { const b = tickBucket(t, p); if (b !== last) n++; last = b; }
      return n;
    };
    // 2:30 down to 0:31 passes 2:00, 1:30 and 1:00.
    expect(ticks(150, 31)).toBe(3);
    // Ticks at 0:30 and then every second: 0:30 to 0:21.
    expect(ticks(31, 20)).toBe(10);
    expect(tickBucket(25, plan)).toBeLessThan(0);
    expect(tickBucket(45, plan)).toBeGreaterThan(0);
    // 0 turns a part off.
    expect(ticks(150, 31, { ...plan, tickEverySec: 0 })).toBe(0);
    expect(ticks(31, 1, { ...plan, finalCountdownSec: 0 })).toBe(1);
  });
});

describe('debug heat keys', () => {
  const ctx: MapContext = { steering: 'heading', aboard: false, keyDirToWorld: () => [0, 0], keyDirToCar: () => null, commitTarget: () => null, switchTarget: () => null, carriedCount: () => 0, inventoryOpen: () => false };
  it('H raises heat and Shift+H raises an alarm', () => {
    expect(actionFor('KeyH', false)).toBe('heat');
    expect(actionFor('KeyH', true)).toBe('alarm');
    expect(actionFor('KeyU', false)).toBe('toggleMute');
    expect(actionFor('KeyM', false)).toBe('toggleMinimap');
    const cmds = new InputMapper().commands({ held: new Set(), actions: ['heat', 'alarm'] }, ctx);
    expect(cmds).toEqual([{ type: 'debugHeat' }, { type: 'debugHeat', source: 'alarmRaised' }]);
  });  it('F cashes out on the horse and sends nothing aboard', () => {
    expect(actionFor('KeyF', false)).toBe('cashOut');
    expect(new InputMapper().commands({ held: new Set(), actions: ['cashOut'] }, ctx)).toEqual([{ type: 'cashOut' }]);
    expect(new InputMapper().commands({ held: new Set(), actions: ['cashOut'] }, { ...ctx, aboard: true })).toEqual([]);
    expect(new InputMapper().commands({ held: new Set(), actions: ['retry'] }, ctx)).toEqual([{ type: 'quickRetry' }]);
  });
});
