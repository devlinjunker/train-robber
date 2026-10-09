// Command and event logs as NDJSON. Pure string building and parsing: the host
// owns the sinks (IndexedDB, files), and the sim never does I/O.
import type { InputFrame, PersistentState, PlayerId, SimEvent } from './types';

export const LOG_VERSION = 1;

export type LogKind = 'commands' | 'events';

/** Everything needed to rebuild the run: same config + seed + commands = same state. */
export interface RunHeader {
  gameVersion: string;
  configHash: string;
  preset: string;
  variants: Record<string, string>;
  overrides: Record<string, unknown>;
  seed: string;
  /** The map the run is played on, and the sim's hash of it. */
  mapId: string;
  mapHash: string;
  tickRateHz: number;
  playerIds: PlayerId[];
  persistentAtStart: PersistentState;
  /** Wall clock, written by the host. The sim never reads time. */
  startedAt: string;
}

export interface HeaderLine extends RunHeader { k: 'header'; log: LogKind; logVersion: number }
/** Commands applied by the step that advances the sim from tick `t` to `t + 1`. */
export interface CmdLine { k: 'cmd'; t: number; p: PlayerId; c: InputFrame['commands'] }
/** State hash when the sim's tick counter equals `t`. */
export interface HashLine { k: 'hash'; t: number; h: string }
/** Last tick and hash of the session; the replay target. */
export interface EndLine { k: 'end'; t: number; h: string }
export interface EventLine { k: 'ev'; t: number; e: SimEvent['type']; [field: string]: unknown }

export type CommandLogLine = HeaderLine | CmdLine | HashLine | EndLine;
export type EventLogLine = HeaderLine | EventLine | EndLine;

export type WriteLine = (line: string) => void;

function headerLine(log: LogKind, header: RunHeader): string {
  const line: HeaderLine = { k: 'header', log, logVersion: LOG_VERSION, ...header };
  return JSON.stringify(line);
}

export interface CommandLogWriter {
  /** Call before `sim.step(inputs)` with the sim's current tick. Only frames with commands are written. */
  step(tick: number, inputs: readonly InputFrame[]): void;
  /** Call after a step with the new tick; writes a hash line every `hashEveryTicks`. */
  checkpoint(tick: number, hash: () => string): void;
  end(tick: number, hash: string): void;
}

export function commandLogWriter(header: RunHeader, write: WriteLine, opts: { hashEveryTicks: number }): CommandLogWriter {
  write(headerLine('commands', header));
  return {
    step(tick, inputs) {
      for (const f of inputs) {
        if (f.commands.length === 0) continue;
        const line: CmdLine = { k: 'cmd', t: tick, p: f.player, c: f.commands };
        write(JSON.stringify(line));
      }
    },
    checkpoint(tick, hash) {
      if (opts.hashEveryTicks > 0 && tick % opts.hashEveryTicks === 0) {
        const line: HashLine = { k: 'hash', t: tick, h: hash() };
        write(JSON.stringify(line));
      }
    },
    end(tick, hash) {
      const line: EndLine = { k: 'end', t: tick, h: hash };
      write(JSON.stringify(line));
    },
  };
}

export interface EventLogWriter {
  events(events: readonly SimEvent[]): void;
  end(tick: number, hash: string): void;
}

/** `allow` is the `logging.events` allowlist; omitted means every event. */
export function eventLogWriter(header: RunHeader, write: WriteLine, opts: { allow?: readonly string[] } = {}): EventLogWriter {
  write(headerLine('events', header));
  const allow = opts.allow ? new Set(opts.allow) : null;
  return {
    events(events) {
      for (const ev of events) {
        if (allow && !allow.has(ev.type)) continue;
        const { type, tick, ...rest } = ev;
        const line: EventLine = { k: 'ev', t: tick, e: type, ...rest };
        write(JSON.stringify(line));
      }
    },
    end(tick, hash) {
      const line: EndLine = { k: 'end', t: tick, h: hash };
      write(JSON.stringify(line));
    },
  };
}

export interface ParsedLog<L> { header: HeaderLine; lines: L[] }

export function parseLog<L extends { k: string }>(text: string): ParsedLog<L> {
  const rows = text.split('\n').filter((s) => s.trim() !== '').map((s, i) => {
    try { return JSON.parse(s) as L | HeaderLine; } catch { throw new Error(`line ${i + 1}: not JSON`); }
  });
  const [first, ...rest] = rows;
  if (!first || first.k !== 'header') throw new Error('line 1: expected a header line');
  const header = first as HeaderLine;
  if (header.logVersion !== LOG_VERSION) throw new Error(`unsupported logVersion ${String(header.logVersion)}`);
  return { header, lines: rest as L[] };
}

/** The minimum a replay needs from a sim, so this module stays independent of `createSim`. */
export interface ReplayTarget {
  step(inputs: InputFrame[]): unknown;
  hash(): string;
}

export interface HashCheck { t: number; expected: string; actual: string }

export interface ReplayResult {
  ok: boolean;
  finalTick: number;
  /** Hash the log ends on: the `end` line, else the last `hash` line. */
  expectedHash: string | null;
  actualHash: string;
  checked: number;
  mismatches: HashCheck[];
}

/** Re-run a command log through a fresh sim and compare every logged hash. */
export function replayCommandLog(log: ParsedLog<CommandLogLine>, sim: ReplayTarget): ReplayResult {
  if (log.header.log !== 'commands') throw new Error(`expected a commands log, got ${log.header.log}`);
  const cmds = new Map<number, InputFrame[]>();
  const hashes = new Map<number, string>();
  let finalTick = 0;
  let expectedHash: string | null = null;
  for (const line of log.lines) {
    if (line.k === 'cmd') {
      const frames = cmds.get(line.t) ?? [];
      frames.push({ player: line.p, commands: line.c });
      cmds.set(line.t, frames);
      finalTick = Math.max(finalTick, line.t + 1);
    } else if (line.k === 'hash' || line.k === 'end') {
      hashes.set(line.t, line.h);
      if (line.t >= finalTick) { finalTick = line.t; expectedHash = line.h; }
    }
  }
  const mismatches: HashCheck[] = [];
  let checked = 0;
  const check = (t: number) => {
    const expected = hashes.get(t);
    if (expected === undefined) return;
    checked++;
    const actual = sim.hash();
    if (actual !== expected) mismatches.push({ t, expected, actual });
  };
  check(0);
  for (let t = 0; t < finalTick; t++) {
    sim.step(cmds.get(t) ?? []);
    check(t + 1);
  }
  const actualHash = sim.hash();
  return { ok: mismatches.length === 0 && expectedHash !== null, finalTick, expectedHash, actualHash, checked, mismatches };
}
