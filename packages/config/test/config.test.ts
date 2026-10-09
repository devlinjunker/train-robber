import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src';

const base = { schemaVersion: 1, tickRate: 60, player: { speedTilesPerSec: 8 } };
describe('resolveConfig', () => {
  it('applies overlays and hashes deterministically', () => {
    const a = resolveConfig(base, [{ player: { speedTilesPerSec: 10 } }]);
    expect(a.tuning.player.speedTilesPerSec).toBe(10);
    expect(a.hash).toBe(resolveConfig(base, [{ player: { speedTilesPerSec: 10 } }]).hash);
  });
  it('rejects unknown keys', () => {
    expect(() => resolveConfig(base, [{ player: { speedTilesPerSecc: 1 } }])).toThrow();
  });
});
