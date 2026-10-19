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
  it('ticks once per countdown second, then twice per second below 20%', () => {
    const ticks = (from: number, to: number, total: number, step = 0.01) => {
      let n = 0, last = tickBucket(from, total);
      for (let t = from; t > to; t -= step) { const b = tickBucket(t, total); if (b !== last) n++; last = b; }
      return n;
    };
    expect(ticks(100, 90, 150)).toBe(9);
    expect(ticks(20, 10, 150)).toBe(19);
  });
});

describe('debug heat keys', () => {
  const ctx: MapContext = { steering: 'heading', aboard: false, keyDirToWorld: () => [0, 0], keyDirToCar: () => null, commitTarget: () => null, switchTarget: () => null, carriedCount: () => 0, inventoryOpen: () => false, crouchMode: 'toggle', crouched: () => false };
  it('H raises heat and Shift+H raises an alarm', () => {
    expect(actionFor('KeyH', false)).toBe('heat');
    expect(actionFor('KeyH', true)).toBe('alarm');
    expect(actionFor('KeyU', false)).toBe('toggleMute');
    expect(actionFor('KeyM', false)).toBe('toggleMinimap');
    const cmds = new InputMapper().commands({ held: new Set(), actions: ['heat', 'alarm'] }, ctx);
    expect(cmds).toEqual([{ type: 'debugHeat' }, { type: 'debugHeat', source: 'alarmRaised' }]);
  });
});
