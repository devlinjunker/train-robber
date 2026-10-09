import { readFileSync, writeFileSync } from 'node:fs';
import { replayText } from './replay';
import { recordGolden } from './golden';

const [cmd, ...args] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => number> = {
  replay([file]) {
    if (!file) { console.error('usage: tools replay <commands.ndjson>'); return 2; }
    const r = replayText(readFileSync(file, 'utf8'));
    for (const w of r.warnings) console.warn(`warning: ${w}`);
    for (const m of r.mismatches) console.error(`tick ${m.t}: expected ${m.expected}, got ${m.actual}`);
    if (r.expectedHash === null) console.error('log has no hash or end line to compare against');
    console.log(`${r.ok ? 'ok' : 'FAILED'}: ${r.finalTick} ticks, ${r.checked} hashes checked, final ${r.actualHash} (log ${r.expectedHash ?? 'none'})`);
    return r.ok ? 0 : 1;
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
process.exit(run(args));
