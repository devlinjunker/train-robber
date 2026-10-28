import { describe, expect, it } from 'vitest';
import { actionFor, InputMapper, WALK_AXIS, worldDirToCar, type GameAction, type MapContext } from '../src/input';
import { keyDirToWorld } from '../src/projection';

const snap = (held: string[], actions: GameAction[] = []) => ({ held: new Set(held), actions });
const iso = (over: Partial<MapContext> = {}): MapContext => ({
  steering: 'heading', aboard: false,
  // Aboard a car whose front points up-right on screen (world -y).
  keyDirToWorld, keyDirToCar: (dx, dy) => worldDirToCar(...keyDirToWorld(dx, dy), { ux: 0, uy: -1 }),
  commitTarget: () => null, switchTarget: () => null, carriedCount: () => 0, inventoryOpen: () => false, crouchMode: 'toggle', crouched: () => false, ...over,
});

describe('Shift: boost riding; C: crouch aboard', () => {
  it('both Shift keys are the boost and C is crouch', () => {
    expect(actionFor('ShiftLeft', true)).toBe('boost');
    expect(actionFor('ShiftRight', true)).toBe('boost');
    expect(actionFor('KeyC', false)).toBe('crouch');
    // Shift+H stays the alarm debug key.
    expect(actionFor('KeyH', true)).toBe('alarm');
  });

  it('riding, Shift boosts and C does nothing; aboard, Shift only runs and C toggles crouch from what the sim says', () => {
    const m = new InputMapper();
    expect(m.commands(snap(['ShiftLeft'], ['boost']), iso())).toEqual([{ type: 'boost' }]);
    expect(m.commands(snap([], ['crouch']), iso())).toEqual([]);
    expect(m.commands(snap([], ['boost']), iso({ aboard: true }))).toEqual([]);
    expect(m.commands(snap([], ['crouch']), iso({ aboard: true }))).toEqual([{ type: 'crouch', on: true }]);
    expect(m.commands(snap([], ['crouch']), iso({ aboard: true, crouched: () => true }))).toEqual([{ type: 'crouch', on: false }]);
  });

  it('?crouch=hold crouches on the press and stands on the release', () => {
    const m = new InputMapper();
    const ctx = iso({ aboard: true, crouchMode: 'hold' });
    expect(m.commands(snap(['KeyC'], ['crouch']), ctx)).toEqual([{ type: 'crouch', on: true }]);
    expect(m.commands(snap(['KeyC']), ctx)).toEqual([]);
    expect(m.commands(snap([]), ctx)).toEqual([{ type: 'crouch', on: false }]);
  });
});

describe('E at a ladder', () => {
  it('aboard with a ladder in reach, E climbs instead of searching', () => {
    const m = new InputMapper();
    expect(m.commands(snap(['KeyE'], ['commit']), iso({ aboard: true, climbable: () => true }))).toEqual([{ type: 'climb' }]);
    expect(m.commands(snap([]), iso({ aboard: true, climbable: () => true }))).toEqual([{ type: 'interact', held: false }]);
    expect(m.commands(snap(['KeyE'], ['commit']), iso({ aboard: true, climbable: () => false }))).toEqual([{ type: 'interact', held: true }]);
  });
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
    // A tap (pressed and released between polls) is a press then a release.
    expect(m.commands(snap([], ['commit']), iso({ commitTarget: () => 'blank-1' }))).toEqual([{ type: 'startRun', trainId: 'blank-1' }, { type: 'interact', held: false }]);
    expect(m.commands(snap([], ['commit', 'jump', 'cancel', 'retry']), iso())).toEqual([
      { type: 'interact', held: true }, { type: 'interact', held: false }, { type: 'jump' }, { type: 'cancelRun' }, { type: 'quickRetry' },
    ]);
  });

  it('Tab asks the switch query: a target is named, none leaves the sim to say why', () => {
    const m = new InputMapper();
    expect(m.commands(snap([], ['switch']), iso({ switchTarget: () => 'blank-2' }))).toEqual([{ type: 'switchTrain', trainId: 'blank-2' }]);
    expect(m.commands(snap([], ['switch']), iso())).toEqual([{ type: 'switchTrain' }]);
  });

  it('aboard, holding E sends the hold and its release once each; X drops the last item', () => {
    const m = new InputMapper();
    const ctx = iso({ aboard: true, commitTarget: () => 'blank-1', carriedCount: () => 3 });
    expect(m.commands(snap(['KeyE'], ['commit']), ctx)).toEqual([{ type: 'interact', held: true }]);
    expect(m.commands(snap(['KeyE']), ctx)).toEqual([]);
    expect(m.commands(snap([]), ctx)).toEqual([{ type: 'interact', held: false }]);
    expect(m.commands(snap([], ['drop']), ctx)).toEqual([{ type: 'drop', slot: 2 }]);
  });

  it('number keys drop that item only while the inventory is open', () => {
    const m = new InputMapper();
    let open = false;
    const ctx = iso({ aboard: true, carriedCount: () => 3, inventoryOpen: () => open });
    expect(m.commands(snap([], ['slot1']), ctx)).toEqual([]);
    open = true;
    expect(m.commands(snap([], ['slot2', 'slot5']), ctx)).toEqual([{ type: 'drop', slot: 1 }]);
  });
});
