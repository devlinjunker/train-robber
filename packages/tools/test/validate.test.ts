import { describe, it, expect } from 'vitest';
import { validateContent } from '../src/validate';

describe('tools validate', () => {
  it('every preset and variant in packages/content resolves', () => {
    const r = validateContent();
    expect(r.errors).toEqual([]);
    expect(r.resolved.length).toBeGreaterThan(1);
  });
});
