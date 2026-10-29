import { describe, it, expect } from 'vitest';
import { leaveNotesEnabled, leaveNotesState, shouldAskOnLeave } from '../src/leaveNotes';

describe('leave notes', () => {
  it('asks only after a run since the last note, and not after a skip', () => {
    const s = leaveNotesState();
    expect(shouldAskOnLeave(s)).toBe(false);
    s.runsSinceNote = 1;
    expect(shouldAskOnLeave(s)).toBe(true);
    s.skipped = true;
    expect(shouldAskOnLeave(s)).toBe(false);
  });
  it('is on unless ?leaveNotes=off', () => {
    expect(leaveNotesEnabled('?seed=a')).toBe(true);
    expect(leaveNotesEnabled('?leaveNotes=off')).toBe(false);
  });
});
