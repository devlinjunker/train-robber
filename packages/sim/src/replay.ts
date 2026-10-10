// Watching a commands log: a sim fed the logged commands instead of input, with seeking and a
// background hash check. Seeking back restores the nearest snapshot and re-simulates forward.
// Pure: the host decides how many ticks to run per frame.
import type { CommandLogIndex } from './log';
import { createSim, restoreSim, type Sim, type SimOptions } from './sim';
import type { GameState, TickResult } from './types';

/** Default snapshot spacing for seeking: 5 s at 60 Hz. */
export const REPLAY_SNAPSHOT_TICKS = 300;

export interface ReplayCheck {
  /** Ticks the background check has simulated so far, out of `finalTick`. */
  checkedTo: number;
  /** Logged hashes compared so far. */
  compared: number;
  /** First tick whose state hash differs from the log's, or null. */
  firstDesync: number | null;
  done: boolean;
}

export interface Replay {
  /** A stable view of the sim being watched; seeking swaps the sim behind it, not this object. */
  readonly sim: Sim;
  readonly index: CommandLogIndex;
  /** The watched sim's tick. */
  readonly tick: number;
  /** Advance one tick with the logged commands. Returns null at the end of the log. */
  step(): TickResult | null;
  /** Jump to `tick` (clamped to the log), restoring a snapshot when going back. */
  seek(tick: number): void;
  /** Run up to `maxTicks` of the background hash check; it also records the seek snapshots. */
  verify(maxTicks: number): ReplayCheck;
  readonly check: ReplayCheck;
}

export function createReplay(index: CommandLogIndex, opts: SimOptions, snapshotEvery = REPLAY_SNAPSHOT_TICKS): Replay {
  const snapshots = new Map<number, GameState>();
  const checker = createSim(opts);
  snapshots.set(0, checker.snapshot());
  const check: ReplayCheck = { checkedTo: 0, compared: 0, firstDesync: null, done: false };
  const compare = (s: Sim) => {
    const expected = index.hashes.get(s.state.tick);
    if (expected === undefined) return;
    check.compared++;
    if (check.firstDesync === null && s.hash() !== expected) check.firstDesync = s.state.tick;
  };
  compare(checker);
  check.done = index.finalTick === 0;

  let cur = createSim(opts);
  const advance = (s: Sim) => s.step(index.cmds.get(s.state.tick) ?? []);

  const view: Sim = {
    step: (inputs) => cur.step(inputs),
    get state() { return cur.state; },
    cars: () => cur.cars(),
    get map() { return cur.map; },
    get world() { return cur.world; },
    snapshot: () => cur.snapshot(),
    hash: () => cur.hash(),
  };

  return {
    sim: view,
    index,
    get tick() { return cur.state.tick; },
    check,
    step() {
      if (cur.state.tick >= index.finalTick) return null;
      return advance(cur);
    },
    seek(target) {
      const t = Math.max(0, Math.min(index.finalTick, Math.round(target)));
      const now = cur.state.tick;
      let from = 0;
      for (const k of snapshots.keys()) if (k <= t && k > from) from = k;
      // Going forward from where we are beats restoring an older snapshot.
      if (t < now || from > now) cur = restoreSim(snapshots.get(from)!, opts.config, opts.map);
      while (cur.state.tick < t) {
        advance(cur);
        if (cur.state.tick % snapshotEvery === 0 && !snapshots.has(cur.state.tick)) snapshots.set(cur.state.tick, cur.snapshot());
      }
    },
    verify(maxTicks) {
      for (let n = 0; n < maxTicks && checker.state.tick < index.finalTick; n++) {
        advance(checker);
        const t = checker.state.tick;
        if (t % snapshotEvery === 0 && !snapshots.has(t)) snapshots.set(t, checker.snapshot());
        compare(checker);
      }
      check.checkedTo = checker.state.tick;
      check.done = checker.state.tick >= index.finalTick;
      return check;
    },
  };
}
