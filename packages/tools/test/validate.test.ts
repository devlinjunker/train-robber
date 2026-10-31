import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadContentDir } from '../src/content';
import { experimentErrors, validateContent } from '../src/validate';

describe('tools validate', () => {
  it('every preset and variant in packages/content resolves', () => {
    const r = validateContent();
    expect(r.errors).toEqual([]);
    expect(r.resolved.length).toBeGreaterThan(1);
  });

  it('names what is wrong in a playtest experiment file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-exp-'));
    mkdirSync(join(dir, 'playtests'));
    const exp = (id: string, setups: unknown[], extra: object = {}) =>
      writeFileSync(join(dir, 'playtests', `${id}.json`), JSON.stringify({ schemaVersion: 1, id, title: 't', question: 'q', setups, numbers: ['outcomes'], ...extra }));
    exp('good', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', preset: 'medium-run', set: { 'countdown.scale': 2 } }]);
    exp('bad-preset', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', preset: 'nope' }]);
    exp('bad-set', [{ id: 'a', name: 'A', set: { 'countdown.nope': 1 } }, { id: 'b', name: 'B' }]);
    exp('bad-variant', [{ id: 'a', name: 'A', variants: { steering: 'nope' } }, { id: 'b', name: 'B' }]);
    exp('bad-map', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { base: { map: 'atlantis' } });
    exp('one-setup', [{ id: 'a', name: 'A' }]);
    exp('dupe', [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]);
    writeFileSync(join(dir, 'playtests', 'renamed.json'), JSON.stringify({ schemaVersion: 1, id: 'other', title: 't', question: 'q', setups: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], numbers: ['heat'] }));
    const errors = experimentErrors(loadContentDir(), dir).join('\n');
    expect(errors).not.toContain('good.json');
    expect(errors).toMatch(/bad-preset\.json setup b: .*nope/);
    expect(errors).toMatch(/bad-set\.json setup a: /);
    expect(errors).toMatch(/bad-variant\.json setup a: .*steering:nope/);
    expect(errors).toMatch(/bad-map\.json setup a: unknown map atlantis/);
    expect(errors).toMatch(/one-setup\.json at setups/);
    expect(errors).toMatch(/dupe\.json at setups\.1\.id: duplicate setup id a/);
    expect(errors).toMatch(/renamed\.json: id other does not match the file name/);
  });
});
