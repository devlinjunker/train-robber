import { describe, expect, it } from 'vitest';
import { InputMapper, WALK_AXIS, worldDirToCar, type GameAction, type MapContext } from '../src/input';
import { keyDirToWorld } from '../src/projection';

const snap = (held: string[], actions: GameAction[] = []) => ({ held: new Set(held), actions });
const iso = (over: Partial<MapContext> = {}): MapContext => ({
  steering: 'heading', aboard: false,
  // Aboard a car whose front points up-right on screen (world -y).
  keyDirToWorld, keyDirToCar: (dx, dy) => worldDirToCar(...keyDirToWorld(dx, dy), { ux: 0, uy: -1 }),
  commitTarget: () => null, ...over,
});

describe('input mapper', () => {
  it('heading steering: A/D steer and W/S throttle on move', () => {
    const m = new InputMapper();
    expect(m.commands(snap(['KeyW', 'KeyD']), iso())).toEqual([{ type: 'move', x: 127, y: -127 }]);
    // Unchanged intents send nothing.
    expect(m.commands(snap(['KeyW', 'KeyD']), iso())).toEqual([]);
    expect(m.commands(snap([]), iso())).toEqual([{ type: 'move', x: 0, y: 0 }]);
  });

  it('screen steering: arrows go through the iso view as a world direction', () => {
    const m = new InputMapper();
    const ctx = iso({ steering: 'screen' });
    // Right on screen is world (1, -1) / sqrt 2.
    expect(m.commands(snap(['ArrowRight']), ctx)).toEqual([{ type: 'steer', x: 90, y: -90 }]);
    // Up+right follows the tile axis that runs up-right on screen: world -y.
    expect(m.commands(snap(['ArrowRight', 'ArrowUp']), ctx)).toEqual([{ type: 'steer', x: 0, y: -127 }]);
    // A/D do nothing under screen steering; W still throttles.
    expect(m.commands(snap(['ArrowRight', 'ArrowUp', 'KeyA', 'KeyW']), ctx)).toEqual([{ type: 'move', x: 0, y: -127 }]);
  });

  it('aboard: WASD walk in the car frame at half axis, Shift runs', () => {
    const m = new InputMapper();
    const ctx = iso({ aboard: true });
    // Up-right on screen is this car's front, so W+D walks straight toward the front.
    expect(m.commands(snap(['KeyW', 'KeyD']), ctx)).toEqual([{ type: 'move', x: WALK_AXIS, y: 0 }]);
    // Down-right on screen is the car's right side.
    expect(m.commands(snap(['KeyS', 'KeyD', 'ShiftLeft']), ctx)).toEqual([{ type: 'move', x: 0, y: 127 }]);
  });

  it('commit asks the commit query: a target gets startRun, none gets interact for the reason', () => {
    const m = new InputMapper();
    expect(m.commands(snap([], ['commit']), iso({ commitTarget: () => 'blank-1' }))).toEqual([{ type: 'startRun', trainId: 'blank-1' }]);
    expect(m.commands(snap([], ['commit', 'jump', 'cancel', 'retry']), iso())).toEqual([
      { type: 'interact', held: false }, { type: 'jump' }, { type: 'cancelRun' }, { type: 'quickRetry' },
    ]);
  });
});
