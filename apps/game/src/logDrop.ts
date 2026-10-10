// Where a replay's commands log comes from: a stored session (?replay=<session>, from the
// Playtests page) or a .commands.log file dropped onto the game page (?replay=file).
// A dropped file is kept in sessionStorage so the page can reload into replay mode.
import { parseLog, type CommandLogLine } from '@train-robber/sim';
import { openDb, readLog } from './logSink';

const FILE_KEY = 'train-robber-replay-file';
export const DROPPED = 'file';

export interface ReplaySource {
  /** The session id, or `file`. */
  id: string;
  /** Tick to open at (`&t=`), e.g. a run's commit. */
  startTick: number | null;
  /** The commands log as NDJSON, and a name to show for it. */
  load(): Promise<{ name: string; text: string }>;
}

export function replaySourceFromUrl(search = location.search): ReplaySource | null {
  const q = new URLSearchParams(search);
  const id = q.get('replay');
  if (!id) return null;
  const t = Number(q.get('t'));
  return {
    id,
    startTick: q.has('t') && Number.isFinite(t) && t >= 0 ? t : null,
    async load() {
      if (id === DROPPED) {
        const stored = sessionStorage.getItem(FILE_KEY);
        if (!stored) throw new Error('No dropped log in this tab. Drop a .commands.log file onto the page.');
        return JSON.parse(stored) as { name: string; text: string };
      }
      const text = await readLog(await openDb(), id, 'commands');
      if (!text) throw new Error(`Session ${id} is no longer stored in this browser (only the newest 20 are kept). Drop its .commands.log file here instead.`);
      return { name: id, text };
    },
  };
}

/** Check a dropped file is a commands log before leaving the page for it. */
function checkLog(text: string): void {
  const log = parseLog<CommandLogLine>(text);
  if (log.header.log !== 'commands') throw new Error(`this is the ${log.header.log} log; drop the .commands.log file`);
}

export function installLogDrop(): void {
  const hint = document.createElement('div');
  hint.textContent = 'Drop a .commands.log file to watch it';
  hint.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:#000a;color:#fff;font:20px monospace;z-index:10;pointer-events:none;border:4px dashed #fc6';
  document.body.appendChild(hint);
  const hasFile = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  addEventListener('dragover', (e) => { if (hasFile(e)) { e.preventDefault(); hint.style.display = 'flex'; } });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) hint.style.display = 'none'; });
  addEventListener('drop', (e) => {
    hint.style.display = 'none';
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    void file.text().then((text) => {
      try {
        checkLog(text);
        sessionStorage.setItem(FILE_KEY, JSON.stringify({ name: file.name, text }));
      } catch (err) {
        alert(`${file.name}: ${(err as Error).message}`);
        return;
      }
      // Reloading ends a live session cleanly (its logs get their end line on pagehide).
      location.href = `${location.pathname}?replay=${DROPPED}`;
    });
  });
}
