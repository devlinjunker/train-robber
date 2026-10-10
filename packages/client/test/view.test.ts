import { describe, expect, it } from 'vitest';
import { createSim, type BoardingCheck } from '@train-robber/sim';
import { Interpolator } from '../src/interp';
import { follow, LEAD_MAX_TILES, lookAheadTarget } from '../src/camera';
import { worldDirToCar } from '../src/input';
import { speedLabel } from '../src/cues';
import { testConfig, testMap } from './fixtures';

describe('interpolation', () => {
  it('lerps the horse and cars between the last two ticks', () => {
    const sim = createSim({ config: testConfig(), map: testMap(), seed: 'interp', playerIds: [1] });
    const ip = new Interpolator();
    sim.step([{ player: 1, commands: [{ type: 'move', x: 0, y: -127 }] }]);
    for (let i = 0; i < 30; i++) sim.step([{ player: 1, commands: [] }]);
    ip.push(sim.state, sim.cars());
    const prevY = sim.state.world.horses[0]!.y, prevCarX = sim.cars()[0]!.x;
    sim.step([{ player: 1, commands: [] }]);
    ip.push(sim.state, sim.cars());
    const currY = sim.state.world.horses[0]!.y, currCarX = sim.cars()[0]!.x;
    expect(currY).not.toBe(prevY);
    expect(ip.horse(0).y).toBeCloseTo(prevY, 9);
    expect(ip.horse(0.5).y).toBeCloseTo((prevY + currY) / 2, 9);
    expect(ip.horse(1).y).toBeCloseTo(currY, 9);
    expect(ip.cars(0.5)[0]!.x).toBeCloseTo((prevCarX + currCarX) / 2, 9);
  });

  it('snaps a teleport instead of sliding', () => {
    const sim = createSim({ config: testConfig(), map: testMap(), seed: 'snap', playerIds: [1] });
    const ip = new Interpolator();
    ip.push(sim.state, sim.cars());
    sim.step([{ player: 1, commands: [] }]);
    ip.push(sim.state, sim.cars());
    // A cancel or quick retry moves the horse far in one tick.
    const h = sim.state.world.horses[0]! as { x: number };
    h.x += 50;
    ip.push(sim.state, sim.cars());
    expect(ip.horse(0.1).x).toBe(h.x);
  });
});

describe('camera', () => {
  it('leads along the heading by speed, clamped', () => {
    expect(lookAheadTarget(10, 10, 1, 0, 0)).toEqual({ x: 10, y: 10 });
    expect(lookAheadTarget(10, 10, 0, -1, 5).y).toBeLessThan(10);
    expect(lookAheadTarget(10, 10, 1, 0, 1000).x).toBe(10 + LEAD_MAX_TILES);
  });

  it('eases toward the target and snaps when asked', () => {
    const cam = { x: 0, y: 0 };
    follow(cam, { x: 10, y: 0 }, 1 / 60);
    expect(cam.x).toBeGreaterThan(0);
    expect(cam.x).toBeLessThan(10);
    follow(cam, { x: 10, y: 0 }, 1 / 60, true);
    expect(cam.x).toBe(10);
  });
});

describe('walking aboard', () => {
  it('turns a world direction into the car frame, front and right side', () => {
    const car = { ux: 1, uy: 0 }; // front toward +x, so the right side is +y
    expect(worldDirToCar(1, 0, car)).toEqual([1, 0]);
    const [f, r] = worldDirToCar(0, 1, car);
    expect([f + 0, r]).toEqual([0, 1]);
    const [f2, r2] = worldDirToCar(0, -1, { ux: 0, uy: -1 });
    expect([f2, r2 + 0]).toEqual([1, 0]);
  });
});

describe('speed readout', () => {
  const check = (state: BoardingCheck['state'], speedDelta: number): BoardingCheck =>
    ({ state, side: 'right', car: 1, entry: 'side-right', at: null, distance: 1, speedDelta });
  it('uses the sim verdict in range and the same reading by speed out of range', () => {
    expect(speedLabel(check('eligible', 0.5), 2).text).toBe('MATCHED +0.5');
    expect(speedLabel(check('too slow', -3), 2).text).toBe('TOO SLOW -3.0');
    expect(speedLabel(check('too far', 4), 2).text).toBe('TOO FAST +4.0');
    expect(speedLabel(check('too far', -1), 2).text).toBe('MATCHED -1.0');
  });
});
