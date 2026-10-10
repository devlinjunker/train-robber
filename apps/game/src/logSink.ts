// IndexedDB sink for the command and event logs, so a session survives a reload.
// Lines are buffered and written in batches off the tick; the sim never waits on it.
import type { LogKind } from '@train-robber/sim';

const DB_NAME = 'train-robber-logs';
const KEEP_SESSIONS = 20;
const FLUSH_MS = 1000;
const FLUSH_LINES = 500;

interface SessionRow { id: string; startedAt: string }
interface LineRow { session: string; log: LogKind; line: string }

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
}

function openDb(): Promise<IDBDatabase> {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('sessions', { keyPath: 'id' });
    db.createObjectStore('lines', { autoIncrement: true }).createIndex('bySession', ['session', 'log']);
  };
  return req(open);
}

export class IndexedDbLogSink {
  private buffer: LineRow[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly db: IDBDatabase, readonly session: string) {}

  static async open(session: string, startedAt: string): Promise<IndexedDbLogSink> {
    const db = await openDb();
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put({ id: session, startedAt } satisfies SessionRow);
    await done(tx);
    await prune(db);
    return new IndexedDbLogSink(db, session);
  }

  writer(log: LogKind): (line: string) => void {
    return (line) => {
      this.buffer.push({ session: this.session, log, line });
      if (this.buffer.length >= FLUSH_LINES) void this.flush();
      else this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
    };
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const rows = this.buffer;
    this.buffer = [];
    if (rows.length === 0) return this.writing;
    this.writing = this.writing.then(() => {
      const tx = this.db.transaction('lines', 'readwrite');
      const store = tx.objectStore('lines');
      for (const r of rows) store.add(r);
      return done(tx);
    }).catch((e: unknown) => console.warn('log sink write failed', e));
    return this.writing;
  }

  /** The stored log as NDJSON, in write order. */
  async read(log: LogKind): Promise<string> {
    await this.flush();
    const tx = this.db.transaction('lines', 'readonly');
    const rows = await req(tx.objectStore('lines').index('bySession').getAll([this.session, log])) as LineRow[];
    return rows.map((r) => r.line).join('\n') + '\n';
  }
}

/** Keep only the newest sessions so storage stays bounded. */
async function prune(db: IDBDatabase): Promise<void> {
  const sessions = await req(db.transaction('sessions', 'readonly').objectStore('sessions').getAll()) as SessionRow[];
  const old = sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(KEEP_SESSIONS);
  if (old.length === 0) return;
  const tx = db.transaction(['sessions', 'lines'], 'readwrite');
  const lines = tx.objectStore('lines').index('bySession');
  for (const s of old) {
    tx.objectStore('sessions').delete(s.id);
    for (const log of ['commands', 'events'] as const) {
      lines.openKeyCursor(IDBKeyRange.only([s.id, log])).onsuccess = function () {
        const c = this.result;
        if (c) { tx.objectStore('lines').delete(c.primaryKey); c.continue(); }
      };
    }
  }
  await done(tx);
}

export function download(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}
