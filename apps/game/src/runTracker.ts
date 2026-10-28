// Turns the sim's event stream into one summary record per run, for the Playtests page.
// Pure: the host supplies wall-clock times and decides where records are stored.
import type { BoardingResult, RunPhase, SimEvent } from '@train-robber/sim';

/** How a run ended. `retry` is a quick retry; `abandoned` means the page closed mid-run. */
export type TrackedOutcome = 'extracted' | 'died' | 'cancelled' | 'expired' | 'cashedOut' | 'retry' | 'abandoned';

/** What the session knows about itself, copied into every run it plays. */
export interface SessionMeta {
  session: string;
  tester: string;
  gameVersion: string;
  configHash: string;
  preset: string;
  variants: Record<string, string>;
  /** `?set=` values, as a partial config tree; missing on records from before them. */
  overrides?: Record<string, unknown>;
  seed: string;
  mapId: string;
  url: string;
  tickRateHz: number;
  /** The save the session played on (phase 2 M5): runs with the same id carry wanted level and bank from one to the next. Missing on older records. */
  saveId?: string;
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
  /** Countdown seconds left when the run ended (kept on cancels, U6); null with the countdown off, missing on older records. */
  countdownLeftSec?: number | null;
  /** Heat when the run ended; missing on older records. */
  heatAtEnd?: number;
  /** Dollar value and count of the loot carried when the run ended (picked up minus dropped); missing on records from before loot. */
  lootValue?: number;
  lootItems?: number;
  /** Loot value banked by an extraction (after any spill); 0 for other outcomes, missing on records from before extraction. */
  cashOut?: number;
  /** Whistles and mount jumps made; missing on records from before extraction. */
  whistles?: number;
  mountAttempts?: number;
  /** Loot value lost on the way (thrown off, falls, mount spills); missing on records from before M5. */
  lootLost?: number;
  /** The wanted level the run was played at; missing on records from before M5. */
  wantedLevel?: number;
  /** The saved wanted level, bank and lifetime earned after the outcome (PersistentChanged). */
  wantedAfter?: number;
  bankAfter?: number;
  lifetimeAfter?: number;
  /** A `wanted.forceLevel` run (practice): nothing was saved. */
  practice?: boolean;
  /** The run this one picked up after an in-place cancel (Esc on the horse, then recommitting to the same train): its record id. */
  resumedFrom?: string;
}

const PHASE_ORDER: readonly RunPhase[] = ['idle', 'approach', 'boarding', 'aboard', 'extracting', 'ended'];

interface Open { runNumber: number; trainId: string; startTick: number; startedAt: string; boarding: Record<BoardingResult, number>; furthest: RunPhase; damage: number; aboardTick: number | null; rejections: Record<string, number>; notes: RunNote[]; countdownLeftSec: number | null; heat: number; lootValue: number; lootItems: number; cashOut: number; whistles: number; mounts: number; lootLost: number; wantedLevel: number; practice: boolean; resumedFrom?: string }

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
  // The last run cancelled on each train, which a resumed commit to that train picks up.
  const cancelledOn = new Map<string, string>();

  const build = (o: Open, outcome: TrackedOutcome, durationTicks: number, now: string): RunRecord => ({
    ...meta, id: `${meta.session}#${o.runNumber}`, runNumber: o.runNumber, trainId: o.trainId, startTick: o.startTick, startedAt: o.startedAt, endedAt: now,
    outcome, durationTicks, durationSec: Math.round((durationTicks / meta.tickRateHz) * 10) / 10,
    boardingAttempts: o.boarding.perfect + o.boarding.good + o.boarding.fail, boarding: { ...o.boarding },
    furthestPhase: o.furthest, damageTaken: o.damage,
    commitToAboardSec: o.aboardTick === null ? null : Math.round(((o.aboardTick - o.startTick) / meta.tickRateHz) * 10) / 10,
    rejections: { ...o.rejections }, notes: [...o.notes], countdownLeftSec: o.countdownLeftSec, heatAtEnd: o.heat,
    lootValue: o.lootValue, lootItems: o.lootItems, cashOut: o.cashOut, whistles: o.whistles, mountAttempts: o.mounts,
    lootLost: o.lootLost, wantedLevel: o.wantedLevel, practice: o.practice, ...(o.resumedFrom ? { resumedFrom: o.resumedFrom } : {}),
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
        // PersistentChanged follows its RunEnded: add the saved state to the run just closed and store it again.
        if (ev.type === 'PersistentChanged') {
          if (last && !open && last.wantedAfter === undefined) {
            last = { ...last, wantedAfter: ev.after.wantedLevel, bankAfter: ev.after.bank, lifetimeAfter: ev.after.lifetimeEarned, practice: last.practice || !!ev.practice };
            ended.push(last);
          }
          continue;
        }
        if (ev.type === 'RunStarted') {
          open = { runNumber: ev.runNumber, trainId: ev.trainId, startTick: ev.tick, startedAt: now, boarding: { perfect: 0, good: 0, fail: 0 }, furthest: 'approach', damage: 0, aboardTick: null, rejections: {}, notes: [], countdownLeftSec: ev.countdownSec, heat: 0, lootValue: 0, lootItems: 0, cashOut: 0, whistles: 0, mounts: 0, lootLost: 0, wantedLevel: ev.wantedLevel ?? 0, practice: !!ev.practice,
            ...(ev.resumed && cancelledOn.has(ev.trainId) ? { resumedFrom: cancelledOn.get(ev.trainId)! } : {}) };
          ended.push(build(open, 'abandoned', 0, now));
        } else if (!open) continue;
        else if (ev.type === 'RunPhaseChanged') {
          if (ev.to !== 'ended' && PHASE_ORDER.indexOf(ev.to) > PHASE_ORDER.indexOf(open.furthest)) open.furthest = ev.to;
          if (ev.to === 'aboard') open.aboardTick ??= ev.tick;
        } else if (ev.type === 'BoardingAttempt') open.boarding[ev.result]++;
        else if (ev.type === 'DamageDealt') open.damage += ev.amount;
        else if (ev.type === 'CommandRejected') { const k = `${ev.command}: ${ev.reason}`; open.rejections[k] = (open.rejections[k] ?? 0) + 1; }
        else if (ev.type === 'HeatChanged') open.heat = ev.heat;
        else if (ev.type === 'LootPickedUp') { open.lootValue += ev.value; open.lootItems++; }
        else if (ev.type === 'LootDropped') { open.lootValue -= ev.value; open.lootItems--; }
        else if (ev.type === 'LootSpilled') { open.lootValue -= ev.value; open.lootItems -= ev.items.length; open.lootLost += ev.value; }
        // Thrown off or a fall: the items are gone (M5 wires these into the run's loot).
        else if (ev.type === 'LootLost') { open.lootValue -= ev.value; open.lootItems--; open.lootLost += ev.value; }
        else if (ev.type === 'HorseWhistled' || ev.type === 'HorseSideChanged') open.whistles++;
        else if (ev.type === 'MountAttempt') open.mounts++;
        else if (ev.type === 'RunEnded') {
          open.countdownLeftSec = ev.countdownLeftSec; open.heat = ev.heat; open.cashOut = ev.cashOut;
          const rec = close(open, ev.retry ? 'retry' : ev.outcome, ev.durationTicks, now);
          if (ev.outcome === 'cancelled' && !ev.retry) cancelledOn.set(rec.trainId, rec.id); else cancelledOn.delete(rec.trainId);
          ended.push(rec);
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
