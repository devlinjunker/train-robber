import { readFileSync, writeFileSync } from 'node:fs';
import { replayText } from './replay';
import { recordGolden } from './golden';
import { validateContent } from './validate';
import { buildMaps } from './maps/cli';

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
  'build-maps'(args) {
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
  process.exit(run(args));
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
