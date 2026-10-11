// Turns the sim's event stream into one summary record per run, for the Playtests page.
// Pure: the host supplies wall-clock times and decides where records are stored.
import type { BoardingResult, RunPhase, SimEvent } from '@train-robber/sim';

/** How a run ended. `retry` is a quick retry; `abandoned` means the page closed mid-run. */
export type TrackedOutcome = 'died' | 'cancelled' | 'retry' | 'abandoned';

/** What the session knows about itself, copied into every run it plays. */
export interface SessionMeta {
  session: string;
  tester: string;
  gameVersion: string;
  configHash: string;
  preset: string;
  variants: Record<string, string>;
  seed: string;
  mapId: string;
  url: string;
  tickRateHz: number;
}

export interface RunNote { t: number; text: string }

export interface RunRecord extends SessionMeta {
  /** `<session>#<runNumber>`. */
  id: string;
  runNumber: number;
  trainId: string;
  /** Sim tick of the commit, where the replay viewer opens the run. Missing on records from before it. */
  startTick?: number;
  startedAt: string;
  endedAt: string;
  outcome: TrackedOutcome;
  durationTicks: number;
  durationSec: number;
  boardingAttempts: number;
  boarding: Record<BoardingResult, number>;
  /** Furthest phase the run reached before it ended. */
  furthestPhase: RunPhase;
  damageTaken: number;
  /** Seconds from commit to landing aboard; null when the run never got aboard. Same measure as `tools report`. */
  commitToAboardSec: number | null;
  /** Refused commands by `command: reason`, e.g. `jump: too far`. */
  rejections: Record<string, number>;
  notes: RunNote[];
}

const PHASE_ORDER: readonly RunPhase[] = ['idle', 'approach', 'boarding', 'aboard', 'ended'];

interface Open { runNumber: number; trainId: string; startTick: number; startedAt: string; boarding: Record<BoardingResult, number>; furthest: RunPhase; damage: number; aboardTick: number | null; rejections: Record<string, number>; notes: RunNote[] }

export interface RunTracker {
  /**
   * Feed every step's events; `now` is the host's wall clock as ISO. Returns records to store:
   * each run that ended, and a provisional `abandoned` record for each run that started, so a
   * run cut short by a closed tab still shows up even if the page had no time to save it.
   */
  events(events: readonly SimEvent[], now: string): RunRecord[];
  /**
   * Attach a note to the run in progress. Returns null when it was attached there, or else the
   * last finished run with the note added, for the host to store again (null if none yet).
   */
  note(tick: number, text: string): RunRecord | null;
  /** The page is closing: the run in progress, if any, ends as abandoned. */
  abandon(tick: number, now: string): RunRecord | null;
}

export function createRunTracker(meta: SessionMeta): RunTracker {
  let open: Open | null = null;
  let last: RunRecord | null = null;

  const build = (o: Open, outcome: TrackedOutcome, durationTicks: number, now: string): RunRecord => ({
    ...meta, id: `${meta.session}#${o.runNumber}`, runNumber: o.runNumber, trainId: o.trainId, startTick: o.startTick, startedAt: o.startedAt, endedAt: now,
    outcome, durationTicks, durationSec: Math.round((durationTicks / meta.tickRateHz) * 10) / 10,
    boardingAttempts: o.boarding.perfect + o.boarding.good + o.boarding.fail, boarding: { ...o.boarding },
    furthestPhase: o.furthest, damageTaken: o.damage,
    commitToAboardSec: o.aboardTick === null ? null : Math.round(((o.aboardTick - o.startTick) / meta.tickRateHz) * 10) / 10,
    rejections: { ...o.rejections }, notes: [...o.notes],
  });
  const close = (o: Open, outcome: TrackedOutcome, durationTicks: number, now: string): RunRecord => {
    const rec = build(o, outcome, durationTicks, now);
    open = null;
    last = rec;
    return rec;
  };

  return {
    events(events, now) {
      const ended: RunRecord[] = [];
      for (const ev of events) {
        if (ev.type === 'RunStarted') {
          open = { runNumber: ev.runNumber, trainId: ev.trainId, startTick: ev.tick, startedAt: now, boarding: { perfect: 0, good: 0, fail: 0 }, furthest: 'approach', damage: 0, aboardTick: null, rejections: {}, notes: [] };
          ended.push(build(open, 'abandoned', 0, now));
        } else if (!open) continue;
        else if (ev.type === 'RunPhaseChanged') {
          if (ev.to !== 'ended' && PHASE_ORDER.indexOf(ev.to) > PHASE_ORDER.indexOf(open.furthest)) open.furthest = ev.to;
          if (ev.to === 'aboard') open.aboardTick ??= ev.tick;
        } else if (ev.type === 'BoardingAttempt') open.boarding[ev.result]++;
        else if (ev.type === 'DamageDealt') open.damage += ev.amount;
        else if (ev.type === 'CommandRejected') { const k = `${ev.command}: ${ev.reason}`; open.rejections[k] = (open.rejections[k] ?? 0) + 1; }
        else if (ev.type === 'RunEnded') {
          ended.push(close(open, ev.retry ? 'retry' : ev.outcome, ev.durationTicks, now));
        }
      }
      return ended;
    },
    note(tick, text) {
      if (open) { open.notes.push({ t: tick, text }); return null; }
      if (!last) return null;
      last = { ...last, notes: [...last.notes, { t: tick, text }] };
      return last;
    },
    abandon(tick, now) {
      return open ? close(open, 'abandoned', tick - open.startTick, now) : null;
    },
  };
}
