import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/ringBuffer';

describe('RingBuffer', () => {
  it('keeps the newest items, oldest first', () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
  });
});
