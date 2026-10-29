// Asks for playtest notes when the tab closes. Browsers only allow their own "Leave site?"
// dialog on close, so the page asks for that, and if the tester stays, opens a notes box.
// Leaving anyway closes the tab without notes, as before.

/** When to ask: only after a run was played since the last note, and not again once skipped. */
export interface LeaveNotesState {
  /** Runs started since the last note (or since the page opened). */
  runsSinceNote: number;
  /** Skip pressed in the notes box: don't ask again until another run starts. */
  skipped: boolean;
}

export const leaveNotesState = (): LeaveNotesState => ({ runsSinceNote: 0, skipped: false });

export function shouldAskOnLeave(s: LeaveNotesState): boolean {
  return s.runsSinceNote > 0 && !s.skipped;
}

/** `?leaveNotes=off` turns the close prompt off. */
export function leaveNotesEnabled(search: string): boolean {
  return new URLSearchParams(search).get('leaveNotes') !== 'off';
}

export interface LeaveNotes {
  /** A run started: there is something new to write about. */
  runStarted(): void;
  /** A note was written, by N, L or the notes box. */
  noted(): void;
}

/**
 * Hooks `beforeunload`. `save` stores the note text the same way N does; `releaseKeys` forgets
 * keys the box swallowed.
 */
export function installLeaveNotes(save: (text: string) => void, releaseKeys: () => void): LeaveNotes {
  const state = leaveNotesState();
  let box: HTMLElement | null = null;

  const openBox = () => {
    if (box) return;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);z-index:10;font:13px monospace';
    box.innerHTML = `<form style="background:#eee;color:#111;padding:12px;border:1px solid #888;width:min(420px,90vw)">
      <div style="margin-bottom:6px">Notes on this playtest before you go (saved with the last run and its logs):</div>
      <textarea rows="6" style="width:100%;box-sizing:border-box;font:13px monospace"></textarea>
      <div style="margin-top:8px;text-align:right">
        <button type="button" data-skip>Skip</button> <button type="submit">Save notes</button>
      </div>
      <div style="margin-top:6px;color:#555">Close the tab again after saving.</div></form>`;
    // Keys typed here must not reach the game's keyboard handler on window.
    for (const k of ['keydown', 'keyup'] as const) box.addEventListener(k, (e) => e.stopPropagation());
    const text = box.querySelector('textarea')!;
    const close = () => { box?.remove(); box = null; releaseKeys(); };
    box.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = text.value.trim();
      if (t) { save(t); state.runsSinceNote = 0; } else state.skipped = true;
      close();
    });
    box.querySelector('[data-skip]')!.addEventListener('click', () => { state.skipped = true; close(); });
    document.body.appendChild(box);
    text.focus();
  };

  addEventListener('beforeunload', (e) => {
    if (!shouldAskOnLeave(state)) return;
    e.preventDefault();
    e.returnValue = '';
    // A timer only runs if the tester chose to stay on the page.
    setTimeout(openBox, 0);
  });

  return {
    runStarted() { state.runsSinceNote++; state.skipped = false; },
    noted() { state.runsSinceNote = 0; },
  };
}
