// Replay mode (?replay=<session> or a dropped .commands.log): rebuilds the run from the log header
// and feeds the logged commands to the sim, drawn by the normal game client. Nothing is logged
// or recorded while watching.
import type { Application } from 'pixi.js';
import { createGameClient, showFatal } from '@train-robber/client';
import { headerWarnings } from '@train-robber/config';
import { createReplay, eventLogWriter, indexCommandLog, mapHash, parseLog, type CommandLogLine, type HeaderLine, type Replay } from '@train-robber/sim';
import pkg from '../package.json';
import { DEFAULT_MAP, loadMap } from './map';
import { RingBuffer } from './ringBuffer';
import { configForHeader } from './setup';
import type { ReplaySource } from './logDrop';

const SPEEDS = [0.5, 1, 2, 4, 8];
const MAX_CATCHUP = 5;
/** Time per frame the background hash check may take. */
const VERIFY_BUDGET_MS = 4;
const VERIFY_SLICE = 30;
const SEEK_SEC = 5;

export async function bootReplay(app: Application, source: ReplaySource): Promise<void> {
  let name: string, header: HeaderLine, replay: Replay, warnings: string[];
  let config: ReturnType<typeof configForHeader>;
  try {
    const file = await source.load();
    name = file.name;
    const log = parseLog<CommandLogLine>(file.text);
    header = log.header;
    if (header.log !== 'commands') throw new Error(`expected a commands log, got the ${header.log} log`);
    config = configForHeader(header);
    const map = await loadMap(header.mapId ?? DEFAULT_MAP);
    warnings = headerWarnings(header, { config, gameVersion: pkg.version, mapHash: mapHash(map), tickRateHz: config.values.sim.tickRateHz });
    if (!header.mapId) warnings.push(`log names no map, using ${DEFAULT_MAP}`);
    replay = createReplay(indexCommandLog(log), { config, map, seed: header.seed, playerIds: header.playerIds, persistent: header.persistentAtStart });
    run(app, { name, header, replay, warnings, config, map, startTick: source.startTick });
  } catch (e) {
    showFatal(app, `Replay: ${(e as Error).message}`);
    addTopLinks();
    throw e;
  }
}

function addTopLinks(): void {
  const bar = document.createElement('div');
  bar.className = 'replay-links';
  bar.innerHTML = `<a href="./">Exit replay</a><a href="playtests.html" target="_blank">Playtests</a>`;
  document.body.appendChild(bar);
  injectStyle();
}

interface Ctx {
  name: string;
  header: HeaderLine;
  replay: Replay;
  warnings: string[];
  config: ReturnType<typeof configForHeader>;
  map: Awaited<ReturnType<typeof loadMap>>;
  startTick: number | null;
}

function run(app: Application, c: Ctx): void {
  const { replay, header, config } = c;
  const { finalTick, notes } = replay.index;
  const hz = config.values.sim.tickRateHz;
  const STEP_MS = 1000 / hz;
  document.body.classList.add('replay-mode');
  addTopLinks();

  // The page's own view options win over the logged ones, so ?view=topdown still works here.
  const search = new URLSearchParams(header.url ?? '');
  const here = new URLSearchParams(location.search);
  for (const k of ['view', 'runZoom']) { const v = here.get(k); if (v !== null) search.set(k, v); }
  const client = createGameClient(app, {
    sim: replay.sim, map: c.map, config, search: `?${search}`,
    replayControls: 'Space play/pause  ·  ←/→ 5 s  ·  ,/. one tick  ·  ↑/↓ speed  ·  [/] notes',
  });
  // The debug readout's recent events, rebuilt from the replayed events.
  const recent = new RingBuffer<string>(8);
  const evLog = eventLogWriter(header, (line) => recent.push(line), { allow: config.values.logging.events });

  let playing = true, speed = 1, acc = 0, last = performance.now(), fps = 0, tickMs = 0;

  // Panel.
  const panel = document.createElement('div');
  panel.className = 'replay-panel';
  panel.innerHTML = `
    <div class="row">
      <button data-a="prev" title="Previous note ([)">◀ note</button>
      <button data-a="play" class="play" title="Play/pause (Space)">❚❚</button>
      <button data-a="next" title="Next note (])">note ▶</button>
      <select data-a="speed" title="Speed (↑/↓)">${SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}x</option>`).join('')}</select>
      <div class="track"><div class="marks"></div><input type="range" min="0" max="${finalTick}" step="1" value="0"></div>
      <span class="time"></span>
    </div>
    <div class="row info"><span class="sync"></span><span class="name"></span><span class="warn"></span></div>`;
  document.body.appendChild(panel);
  const $ = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
  const seekBar = $<HTMLInputElement>('input[type=range]');
  const speedSel = $<HTMLSelectElement>('select');
  const playBtn = $<HTMLButtonElement>('.play');
  const timeEl = $('.time'), syncEl = $('.sync'), marks = $('.marks');
  $('.name').textContent = `${c.name} · ${header.preset} ${Object.entries(header.variants).map(([g, id]) => `${g}:${id}`).join(' ')} · map ${header.mapId} · seed ${header.seed}`;
  const warnEl = $('.warn');
  if (c.warnings.length) {
    const [top, details] = [c.warnings.filter((w) => !w.startsWith('  ')), c.warnings.filter((w) => w.startsWith('  '))];
    warnEl.innerHTML = `⚠ ${top.map(esc).join(' · ')}${details.length ? ` <details><summary>${details.length} parameter${details.length === 1 ? '' : 's'} differ</summary><pre>${details.map((d) => esc(d.trim())).join('\n')}</pre></details>` : ''}`;
  }
  const pctOf = (t: number) => (finalTick ? (t / finalTick) * 100 : 0);
  marks.innerHTML = notes.map((n) => `<i class="note" style="left:${pctOf(n.t)}%" title="${esc(`${fmtTick(n.t, hz)} ${n.text}`)}"></i>`).join('');
  const desyncMark = document.createElement('i');
  desyncMark.className = 'desync';
  desyncMark.style.display = 'none';
  marks.appendChild(desyncMark);

  // Notes list.
  const list = document.createElement('div');
  list.className = 'replay-notes';
  list.innerHTML = `<b>Notes (${notes.length})</b>` + (notes.length ? notes.map((n, i) => `<div data-i="${i}"><span>${fmtTick(n.t, hz)}</span> ${esc(n.text)}</div>`).join('') : '<div class="muted">No notes in this log. N adds one while playing.</div>');
  document.body.appendChild(list);
  list.addEventListener('click', (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i;
    if (i !== undefined) seek(notes[Number(i)]!.t);
  });

  const seek = (t: number) => {
    replay.seek(t);
    acc = 0;
    client.reset();
  };
  const togglePlay = () => {
    if (!playing && replay.tick >= finalTick) seek(0);
    playing = !playing;
  };
  const jumpNote = (dir: 1 | -1) => {
    // A small margin so "previous" from just after a note goes to the one before it.
    const t = replay.tick;
    const n = dir > 0 ? notes.find((x) => x.t > t) : [...notes].reverse().find((x) => x.t < t - hz / 2);
    if (n) seek(n.t);
  };
  const setSpeed = (s: number) => { speed = s; speedSel.value = String(s); };
  const stepSpeed = (dir: 1 | -1) => setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + dir))]!);

  panel.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'play') togglePlay();
    else if (a === 'prev') jumpNote(-1);
    else if (a === 'next') jumpNote(1);
    if (a && a !== 'speed') (e.target as HTMLElement).blur();
  });
  speedSel.addEventListener('change', () => { setSpeed(Number(speedSel.value)); speedSel.blur(); });
  seekBar.addEventListener('input', () => seek(Number(seekBar.value)));
  seekBar.addEventListener('change', () => seekBar.blur());
  addEventListener('keydown', (e) => {
    if (e.repeat && e.code === 'Space') return;
    if (e.code === 'Space') togglePlay();
    else if (e.code === 'ArrowLeft') seek(replay.tick - SEEK_SEC * hz);
    else if (e.code === 'ArrowRight') seek(replay.tick + SEEK_SEC * hz);
    else if (e.code === 'Comma') { playing = false; seek(replay.tick - 1); }
    else if (e.code === 'Period') { playing = false; seek(replay.tick + 1); }
    else if (e.code === 'ArrowUp') stepSpeed(1);
    else if (e.code === 'ArrowDown') stepSpeed(-1);
    else if (e.code === 'BracketLeft') jumpNote(-1);
    else if (e.code === 'BracketRight') jumpNote(1);
    else return;
    e.preventDefault();
  });

  if (c.startTick !== null) seek(c.startTick);

  const updatePanel = () => {
    const t = replay.tick;
    // Keep the HUD's prompt and controls above the panel, whose height changes with open warnings.
    document.body.style.setProperty('--replay-panel-h', `${panel.offsetHeight}px`);
    if (document.activeElement !== seekBar) seekBar.value = String(t);
    playBtn.textContent = playing ? '❚❚' : '▶';
    timeEl.textContent = `tick ${t} / ${finalTick} · ${fmtTick(t, hz)} / ${fmtTick(finalTick, hz)}`;
    const ch = replay.check;
    const desync = ch.firstDesync;
    if (desync !== null) {
      syncEl.className = 'sync bad';
      syncEl.textContent = `desync at tick ${desync}${ch.done ? '' : ' (still checking)'}`;
      desyncMark.style.display = '';
      desyncMark.style.left = `${pctOf(desync)}%`;
      desyncMark.title = `desync at tick ${desync} (${fmtTick(desync, hz)})`;
    } else if (!ch.done) {
      syncEl.className = 'sync';
      syncEl.textContent = `checking hashes ${Math.floor(pctOf(ch.checkedTo))}%`;
    } else if (ch.compared === 0) {
      syncEl.className = 'sync warn';
      syncEl.textContent = 'no hashes in this log to check';
    } else {
      syncEl.className = 'sync good';
      syncEl.textContent = `in sync (${ch.compared} hashes)`;
    }
    let current = -1;
    notes.forEach((n, i) => { if (n.t <= t) current = i; });
    list.querySelectorAll<HTMLElement>('[data-i]').forEach((el) => el.classList.toggle('current', Number(el.dataset.i) === current));
  };

  app.ticker.add(() => {
    const now = performance.now();
    if (playing) acc += (now - last) * speed;
    last = now;
    let steps = 0;
    const maxSteps = MAX_CATCHUP * Math.ceil(speed);
    while (playing && acc >= STEP_MS && steps < maxSteps) {
      const t0 = performance.now();
      const res = replay.step();
      if (!res) { playing = false; acc = 0; break; }
      tickMs = tickMs * 0.95 + (performance.now() - t0) * 0.05;
      evLog.events(res.events);
      client.afterTick(res.events);
      acc -= STEP_MS; steps++;
    }
    if (steps === maxSteps) acc = 0;
    // The background hash check (which also records the seek snapshots) gets what is left of the frame.
    if (!replay.check.done) {
      const until = performance.now() + VERIFY_BUDGET_MS;
      while (!replay.verify(VERIFY_SLICE).done && performance.now() < until);
    }
    client.poll();
    fps = fps * 0.9 + app.ticker.FPS * 0.1;
    client.render(playing ? acc / STEP_MS : 1, { fps, tickMs, seed: header.seed, recentEvents: recent.toArray() });
    updatePanel();
  });
}

function fmtTick(t: number, hz: number): string {
  const s = t / hz;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = `
.replay-links { position: fixed; top: 8px; right: 8px; display: flex; gap: 6px; z-index: 2; }
.replay-links a { font: 12px monospace; padding: 4px 8px; background: #eee; color: #111; text-decoration: none; border: 1px solid #888; }
.replay-mode .tr-hud .bottom { bottom: calc(var(--replay-panel-h, 60px) + 18px); }
.replay-panel { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2; background: #000c; color: #eee; font: 12px ui-monospace, Menlo, Consolas, monospace; padding: 6px 10px; }
.replay-panel .row { display: flex; gap: 8px; align-items: center; }
.replay-panel .info { margin-top: 4px; flex-wrap: wrap; opacity: .9; }
.replay-panel button, .replay-panel select { font: inherit; padding: 2px 8px; }
.replay-panel .play { min-width: 36px; }
.replay-panel .track { position: relative; flex: 1; min-width: 120px; }
.replay-panel .track input { width: 100%; margin: 0; }
.replay-panel .marks { position: absolute; left: 0; right: 0; top: -6px; height: 6px; pointer-events: none; }
.replay-panel .marks i { position: absolute; width: 3px; height: 8px; margin-left: -1px; background: #fc6; }
.replay-panel .marks i.desync { background: #f55; width: 4px; height: 10px; top: -2px; }
.replay-panel .marks i.note { pointer-events: auto; }
.replay-panel .time { white-space: nowrap; min-width: 210px; text-align: right; }
.replay-panel .sync { padding: 1px 6px; border-radius: 3px; background: #444; }
.replay-panel .sync.good { background: #1d5a2a; }
.replay-panel .sync.bad { background: #8a1f1f; }
.replay-panel .sync.warn, .replay-panel .warn { color: #fc6; }
.replay-panel .warn details { display: inline; }
.replay-panel .warn pre { margin: 4px 0 0; max-height: 30vh; overflow: auto; color: #eee; }
.replay-notes { position: fixed; right: 8px; top: 72px; width: min(320px, 40vw); max-height: calc(100vh - 200px); overflow: auto; z-index: 2;
  background: #000a; color: #eee; font: 12px ui-monospace, Menlo, Consolas, monospace; padding: 6px 8px; border-radius: 4px; }
.replay-notes div { padding: 2px 4px; cursor: pointer; border-radius: 3px; }
.replay-notes div:hover { background: #fff2; }
.replay-notes div.current { background: #fc63; }
.replay-notes span { color: #fc6; }
.replay-notes .muted { opacity: .7; cursor: default; }`;
  document.head.appendChild(style);
}
