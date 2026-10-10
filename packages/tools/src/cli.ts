import { readFileSync, writeFileSync } from 'node:fs';
import { replayText } from './replay';
import { recordGolden } from './golden';
import { validateContent } from './validate';
import { buildMaps, watchMaps } from './maps/cli';
import { benchTicks, runBotSweep } from './bots';
import { formatReport, reportFromLogs } from './report';

const [cmd, ...args] = process.argv.slice(2);

// A command returns an exit code, or null to keep the process running (watchers).
const commands: Record<string, (args: string[]) => number | null> = {
  replay([file]) {
    if (!file) { console.error('usage: tools replay <commands log>'); return 2; }
    const r = replayText(readFileSync(file, 'utf8'));
    for (const n of r.notes) console.log(`note at tick ${n.t}: ${n.text}`);
    for (const w of r.warnings) console.warn(`warning: ${w}`);
    for (const m of r.mismatches) console.error(`tick ${m.t}: expected ${m.expected}, got ${m.actual}`);
    if (r.expectedHash === null) console.error('log has no hash or end line to compare against');
    console.log(`${r.ok ? 'ok' : 'FAILED'}: ${r.finalTick} ticks, ${r.checked} hashes checked, final ${r.actualHash} (log ${r.expectedHash ?? 'none'})`);
    return r.ok ? 0 : 1;
  },
  'build-maps'(args) {
    if (args.includes('--watch')) { watchMaps(); return null; }
    return buildMaps(args.includes('--check'));
  },
  validate() {
    const r = validateContent();
    for (const ok of r.resolved) {
      const v = Object.entries(ok.variants).map(([g, id]) => `${g}:${id}`).join(' ');
      console.log(`ok ${ok.preset} [${v}] ${ok.hash}`);
    }
    for (const e of r.errors) console.error(`error: ${e}`);
    return r.errors.length ? 1 : 0;
  },
  bots(args) {
    const flag = (name: string, def: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
    const seeds = flag('seeds', 1000), seconds = flag('seconds', 90);
    const t0 = performance.now();
    const r = runBotSweep({ seeds, seconds });
    const ms = performance.now() - t0;
    for (const [bot, rep] of Object.entries(r.reports)) console.log(`${bot}:\n  ${formatReport(rep).replaceAll('\n', '\n  ')}`);
    for (const v of r.violations.slice(0, 20)) console.error(`FAIL ${v.bot} seed ${v.seed} [${v.variants}] tick ${v.tick}: ${v.message}`);
    console.log(`${r.violations.length ? 'FAILED' : 'ok'}: ${r.runs} bot runs over ${seeds} seeds, ${r.ticks} ticks in ${(ms / 1000).toFixed(1)} s (${((ms * 1000) / r.ticks).toFixed(2)} us/tick), ${r.violations.length} violations`);
    return r.violations.length ? 1 : 0;
  },
  bench(args) {
    // A tick at 60 Hz has 16.7 ms; the sim should use a small slice of it, leaving the rest to rendering.
    const i = args.indexOf('--max-mean-us');
    const limit = i >= 0 ? Number(args[i + 1]) : 1000;
    const r = benchTicks();
    const ok = r.meanUs <= limit;
    console.log(`${ok ? 'ok' : 'FAILED'}: ${r.ticks} ticks, mean ${r.meanUs.toFixed(2)} us (limit ${limit}), p99 ${r.p99Us.toFixed(2)} us, max ${r.maxUs.toFixed(0)} us`);
    return ok ? 0 : 1;
  },
  report(files) {
    if (!files.length) { console.error('usage: tools report <file>.events.log...'); return 2; }
    console.log(formatReport(reportFromLogs(files.map((f) => readFileSync(f, 'utf8')))));
    return 0;
  },
  'record-golden'([out]) {
    const text = recordGolden();
    if (out) writeFileSync(out, text); else process.stdout.write(text);
    return 0;
  },
};

const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.log(`usage: tools <${Object.keys(commands).join('|')}> [args]`);
  process.exit(cmd ? 1 : 0);
}
try {
  const code = run(args);
  if (code !== null) process.exit(code);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
