// The HTML HUD over the canvas: health (a heart and a bar), the run phase above the countdown, the commit prompt, jump rejection reasons
// and results, the countdown bar and heat meter, and the controls. The debug readout lives here
// too, toggled with the backquote key. The meter is not here: it is drawn in the world above the
// horse (decision Q12).
import { clockStep, clockText, drainText, HEAT_BANDS, heatBand } from './clock';

export type NoticeKind = 'bad' | 'good' | 'warn' | 'info';

/** The run's clock: seconds left of the whole countdown, and how fast it drains now. */
/** `to`: on an open line, the town the clock counts down to; it shows in place of the drain rate. */
export interface ClockView { sec: number; total: number; rate: number; to?: string }

export interface HudState {
  phase: string;
  /** Health while a run is active, else null. */
  health: { now: number; max: number } | null;
  /** What the player carries while a run is active: value, weight against the limit, items, and the walk speed it leaves. */
  carry: { value: number; weight: number; maxWeight: number; items: number; maxItems: number; limit: boolean; speed: number } | null;
  /** The open inventory strip (I) along the bottom: a title and one entry per item, or null when it is closed. */
  inventory?: { title: string; items: readonly string[] } | null;
  /** True for a moment after a crash costs health: a red icon and the health bar flash. */
  hit: boolean;
  /** The main prompt line: what to do next. */
  prompt: string;
  /**
   * The commit prompt while idle with a free train in range: the question, how far the
   * `commit.timerSec` bar has filled (null when there is no timer), and how to answer.
   */
  commitAsk?: { title: string; progress: number | null; hint: string } | null;
  /** A short-lived notice (rejection reason, jump result, run end), or empty. */
  notice: string;
  noticeKind: NoticeKind;
  controls: string;
  debug: string | null;
  /** The countdown while a run has one, else null. */
  clock: ClockView | null;
  /** Heat while a run is active, else null. */
  heat: { now: number; max: number } | null;
  /** The wanted level runs use now (0 to `max`); `practice` when `wanted.forceLevel` sets it. Null hides it. */
  wanted?: { level: number; max: number; practice: boolean } | null;
  /** Recent heat gains, newest last, e.g. `+10 heat: debug key`. */
  heatNotices: readonly string[];
  /** True for a moment after an alarm: the screen edge pulses red. */
  alarm: boolean;
  /** The extraction horse while it is called: coming, alongside, blocked or cooling down; null hides it. */
  horse?: { text: string; kind: NoticeKind } | null;
  /** The horse boost while riding with it on: ready, running down (`share` left) or cooling down (`share` back). */
  boost?: { state: 'ready' | 'active' | 'cooldown'; share: number; text: string } | null;
  /** Just off the train with loot (extracted or got away): the total banked, top right, for `hud.lootTotalSec`; null hides it. */
  lootTotal?: { title: string; detail: string } | null;
}

const CSS = `
.tr-hud { position: fixed; inset: 0; pointer-events: none; font: 14px/1.35 ui-monospace, Menlo, Consolas, monospace; color: #fff; }
.tr-hud .top { position: absolute; top: 40px; right: 8px; display: flex; gap: 14px; align-items: center;
  background: rgba(0,0,0,.55); padding: 6px 12px; border-radius: 8px; }
.tr-hud .phase { font-weight: 700; letter-spacing: .06em; }
.tr-hud .clock-head { display: flex; gap: 12px; align-items: baseline; }
.tr-hud .wanted { font-weight: 700; color: #ffcf7a; letter-spacing: .04em; }
.tr-hud .wanted.zero { color: #aaa; }
.tr-hud .wanted.practice { color: #9ecbff; }
.tr-hud .side { position: absolute; top: 80px; right: 8px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
/* On narrow screens the countdown panel spans the top, so health and carry drop below it. */
@media (max-width: 1000px) { .tr-hud .top { top: 118px; } .tr-hud .side { top: 158px; } }
.tr-hud .carry { background: rgba(0,0,0,.55); padding: 4px 12px; border-radius: 8px; font-weight: 700; }
.tr-hud .heart { color: #ff5a4e; font-size: 18px; line-height: 1; }
.tr-hud .inv { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin: 0 auto 8px; max-width: min(92vw, 900px); }
.tr-hud .inv-title { flex-basis: 100%; font-size: 12px; opacity: .85; text-shadow: 0 1px 2px #000; }
.tr-hud .inv-item { background: rgba(0,0,0,.6); border: 1px solid #fff4; padding: 3px 10px; border-radius: 6px; white-space: nowrap; font-size: 13px; }
.tr-hud .carry.slow { color: #ffb02e; }
.tr-hud .loot-total { background: rgba(20,50,20,.85); border: 2px solid #6bff8a; padding: 6px 14px; border-radius: 8px; text-align: right; }
.tr-hud .loot-total .lt-title { font-size: 18px; font-weight: 800; color: #6bff8a; }
.tr-hud .loot-total .lt-detail { font-size: 13px; }
.tr-hud .horse-call { background: rgba(0,0,0,.55); padding: 4px 12px; border-radius: 8px; font-weight: 700; }
.tr-hud .horse-call.good { color: #6bff8a; }
.tr-hud .horse-call.warn { color: #ffb02e; }
.tr-hud .horse-call.bad { color: #ff6b5e; animation: tr-hit-blink .5s steps(1) infinite; }
.tr-hud .boost { display: flex; gap: 8px; align-items: center; background: rgba(0,0,0,.55); padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 700; }
.tr-hud .boost-bar { width: 90px; height: 8px; background: #222; border: 1px solid #fff6; border-radius: 3px; overflow: hidden; }
.tr-hud .boost-bar > div { height: 100%; background: #7a7a7a; }
.tr-hud .boost.ready .boost-bar > div { background: #6bd3ff; }
.tr-hud .boost.active { color: #ffe066; }
.tr-hud .boost.active .boost-bar > div { background: #ffe066; }
.tr-hud .health { width: 180px; height: 14px; background: #3a1d1d; border: 1px solid #fff8; border-radius: 3px; overflow: hidden; }
.tr-hud .health > div { height: 100%; background: linear-gradient(#ff7a6b, #d63c2f); transition: width .2s; }
.tr-hud .bottom { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); text-align: center; }
.tr-hud .prompt { font-size: 20px; font-weight: 700; text-shadow: 0 2px 3px #000; }
.tr-hud .ask { display: inline-block; margin: 0 auto 10px; text-align: center; min-width: 320px;
  background: rgba(10,30,60,.8); border: 2px solid #9fd3ff; border-radius: 10px; padding: 10px 18px; box-shadow: 0 0 16px #9fd3ff88;
  animation: tr-ask-flash .7s ease-in-out infinite alternate; }
@keyframes tr-ask-flash { from { border-color: #9fd3ff; box-shadow: 0 0 6px #9fd3ff44; } to { border-color: #ffffff; box-shadow: 0 0 22px #9fd3ffcc; } }
.tr-hud .ask-title { font-size: 24px; font-weight: 800; text-shadow: 0 2px 3px #000; }
.tr-hud .ask-bar { margin: 8px auto 4px; width: 260px; height: 10px; background: #0008; border: 1px solid #fff8; border-radius: 3px; overflow: hidden; }
.tr-hud .ask-bar > div { height: 100%; background: #9fd3ff; }
.tr-hud .ask-hint { font-size: 13px; opacity: .9; text-shadow: 0 1px 2px #000; }
.tr-hud .notice { margin-top: 6px; font-size: 18px; font-weight: 700; padding: 4px 12px; border-radius: 6px; display: inline-block; }
.tr-hud .notice.bad { background: rgba(160,40,30,.85); }
.tr-hud .notice.good { background: rgba(40,130,60,.85); }
.tr-hud .notice.warn { background: rgba(200,120,20,.9); }
.tr-hud .hit { width: 22px; height: 22px; border-radius: 50%; background: #ff3b30; color: #fff; font-weight: 900; text-align: center; line-height: 22px;
  box-shadow: 0 0 10px #ff3b30; visibility: hidden; }
.tr-hud .top.hit-on .hit { visibility: visible; animation: tr-hit-blink .25s steps(1) infinite; }
.tr-hud .top.hit-on .health { border-color: #ff3b30; box-shadow: 0 0 8px #ff3b30; animation: tr-hit-blink .25s steps(1) infinite; }
@keyframes tr-hit-blink { 50% { opacity: .25; } }
.tr-hud .notice.info { background: rgba(30,60,120,.85); }
.tr-hud .controls { margin-top: 8px; font-size: 12px; opacity: .8; text-shadow: 0 1px 2px #000; }
.tr-hud .clock { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px;
  background: rgba(0,0,0,.55); padding: 6px 12px; border-radius: 8px; }
.tr-hud .clock-row { display: flex; gap: 10px; align-items: center; }
.tr-hud .clock-time { font-size: 22px; font-weight: 800; min-width: 64px; text-align: right; }
.tr-hud .clock-bar { width: 280px; height: 16px; background: #222; border: 1px solid #fff8; border-radius: 3px; overflow: hidden; }
/* Stripes slide left at the drain rate, so a faster clock visibly runs faster. */
.tr-hud .clock-bar > div { height: 100%; transition: width .25s linear, background-color .3s;
  background-image: repeating-linear-gradient(-45deg, rgba(255,255,255,.22) 0 6px, transparent 6px 12px); background-size: 34px 16px;
  animation: tr-clock-run var(--tr-stripe-sec, 1s) linear infinite; }
@keyframes tr-clock-run { from { background-position: 0 0; } to { background-position: -34px 0; } }
.tr-hud .clock.calm .clock-bar > div { background-color: #4caf50; }
.tr-hud .clock.low .clock-bar > div { background-color: #e0a020; }
.tr-hud .clock.critical .clock-bar > div { background-color: #e53935; }
.tr-hud .clock.critical .clock-time { color: #ff6b5e; animation: tr-hit-blink .5s steps(1) infinite; }
.tr-hud .clock-rate { font-size: 18px; font-weight: 800; min-width: 52px; color: #bbb; }
.tr-hud .clock-rate.fast { color: #ffb02e; }
.tr-hud .clock-rate.faster { color: #ff6b5e; }
.tr-hud .clock-rate.town { color: #e8d9a8; font-size: 15px; white-space: nowrap; }
.tr-hud .heat-row { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.tr-hud .heat-bar { position: relative; width: 240px; height: 10px; border: 1px solid #fff6; border-radius: 3px; overflow: hidden;
  background: linear-gradient(90deg, #2c3a2c 0 33.3%, #4a3a1c 33.3% 66.6%, #4a1f1c 66.6% 100%); }
.tr-hud .heat-bar > div { height: 100%; transition: width .2s, background-color .2s; }
.tr-hud .heat-bar .tick { position: absolute; top: 0; bottom: 0; width: 1px; background: #fff8; }
.tr-hud .heat-row.cool .heat-bar > div { background-color: #8bc34a; }
.tr-hud .heat-row.warm .heat-bar > div { background-color: #ffb02e; }
.tr-hud .heat-row.hot .heat-bar > div { background-color: #ff3b30; }
.tr-hud .heat-label { min-width: 110px; font-weight: 700; }
.tr-hud .heat-notices { display: flex; flex-direction: column; align-items: center; font-size: 13px; font-weight: 700; color: #ffcf7a; text-shadow: 0 1px 2px #000; }
.tr-hud .edge { position: absolute; inset: 0; box-shadow: inset 0 0 60px 18px rgba(255,40,30,.75); opacity: 0; }
.tr-hud .edge.on { animation: tr-edge-pulse .5s ease-in-out infinite alternate; }
@keyframes tr-edge-pulse { from { opacity: .15; } to { opacity: 1; } }
.tr-hud .debug { position: absolute; top: 8px; left: 8px; margin: 0; font-size: 11px; white-space: pre; overflow: hidden; text-overflow: ellipsis; max-width: min(33vw, 480px);
  background: rgba(0,0,0,.45); padding: 6px 8px; border-radius: 4px; }
`;

export function createHud(parent: HTMLElement = document.body): { update(s: HudState): void } {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'tr-hud';
  root.innerHTML = `<div class="edge"></div><pre class="debug"></pre>
    <div class="clock calm"><div class="clock-head"><span class="phase"></span><span class="wanted"></span></div><div class="clock-row"><span class="clock-time"></span><div class="clock-bar"><div></div></div><span class="clock-rate"></span></div>
      <div class="heat-row cool"><span class="heat-label"></span><div class="heat-bar"><div></div>${HEAT_BANDS.slice(0, -1).map((b) => `<span class="tick" style="left:${b.upTo * 100}%"></span>`).join('')}</div></div>
      <div class="heat-notices"></div></div>
    <div class="top"><span class="hit">!</span><span class="hp-label heart" title="health" aria-label="health">♥</span><div class="health"><div></div></div><span class="hp-text"></span></div>
    <div class="side"><div class="loot-total"><div class="lt-title"></div><div class="lt-detail"></div></div><div class="boost"><span class="boost-text"></span><div class="boost-bar"><div></div></div></div><div class="carry"></div><div class="horse-call"></div></div>
    <div class="bottom"><div class="inv"></div><div class="ask"><div class="ask-title"></div><div class="ask-bar"><div></div></div><div class="ask-hint"></div></div><div class="prompt"></div><div class="notice"></div><div class="controls"></div></div>`;
  parent.appendChild(root);
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const top = q('.top');
  const debug = q('.debug'), phase = q('.phase'), bar = q<HTMLDivElement>('.health > div'),
    lootEl = q('.loot-total'), lootTitle = q('.lt-title'), lootDetail = q('.lt-detail'),
    hpText = q('.hp-text'), carryEl = q('.carry'), horseEl = q('.horse-call'), invEl = q('.inv'), prompt = q('.prompt'), notice = q('.notice'), controls = q('.controls');
  const wantedEl = q('.wanted');
  const clock = q('.clock'), clockTime = q('.clock-time'), clockFill = q<HTMLDivElement>('.clock-bar > div'), clockRate = q('.clock-rate');
  const boostEl = q('.boost'), boostText = q('.boost-text'), boostFill = q<HTMLDivElement>('.boost-bar > div');
  const ask = q('.ask'), askTitle = q('.ask-title'), askBar = q('.ask-bar'), askFill = q<HTMLDivElement>('.ask-bar > div'), askHint = q('.ask-hint');
  const heatRow = q('.heat-row'), heatLabel = q('.heat-label'), heatFill = q<HTMLDivElement>('.heat-bar > div'), heatNotices = q('.heat-notices'), edge = q('.edge');
  const setClass = (el: HTMLElement, cls: string) => { if (el.className !== cls) el.className = cls; };
  // Only touch the DOM when a value changes.
  let last: Partial<HudState> = {};
  const set = (el: HTMLElement, text: string) => { if (el.textContent !== text) el.textContent = text; };

  return {
    update(s) {
      set(phase, s.phase.toUpperCase());
      wantedEl.style.display = s.wanted ? '' : 'none';
      if (s.wanted) {
        const w = s.wanted;
        set(wantedEl, `WANTED ${'★'.repeat(w.level)}${'☆'.repeat(Math.max(0, w.max - w.level))}${w.practice ? ' practice' : ''}`);
        setClass(wantedEl, `wanted${w.practice ? ' practice' : w.level === 0 ? ' zero' : ''}`);
      }
      const hasHp = s.health !== null;
      top.style.display = hasHp ? '' : 'none';
      if (last.hit !== s.hit) top.classList.toggle('hit-on', s.hit);
      if (s.health) {
        const pct = Math.max(0, Math.min(100, (s.health.now / s.health.max) * 100));
        bar.style.width = `${pct}%`;
        set(hpText, `${s.health.now}/${s.health.max}`);
      }
      boostEl.style.display = s.boost ? '' : 'none';
      if (s.boost) {
        setClass(boostEl, `boost ${s.boost.state}`);
        set(boostText, s.boost.text);
        boostFill.style.width = `${Math.round(Math.max(0, Math.min(1, s.boost.share)) * 100)}%`;
      }
      carryEl.style.display = s.carry ? '' : 'none';
      if (s.carry) {
        const c = s.carry;
        const cap = c.limit ? `/${c.maxWeight}` : '';
        const items = c.limit ? `${c.items}/${c.maxItems}` : `${c.items}`;
        set(carryEl, `$${c.value}  weight ${c.weight.toFixed(1)}${cap}  items ${items}${c.speed < 1 ? `  speed ${Math.round(c.speed * 100)}%` : ''}`);
        carryEl.classList.toggle('slow', c.speed < 1);
      }
      lootEl.style.display = s.lootTotal ? '' : 'none';
      if (s.lootTotal) { set(lootTitle, s.lootTotal.title); set(lootDetail, s.lootTotal.detail); }
      horseEl.style.display = s.horse ? '' : 'none';
      if (s.horse) { set(horseEl, s.horse.text); setClass(horseEl, `horse-call ${s.horse.kind}`); }
      invEl.style.display = s.inventory ? '' : 'none';
      const inv = s.inventory ? [s.inventory.title, ...s.inventory.items].join('\n') : '';
      if (invEl.dataset.text !== inv) {
        invEl.dataset.text = inv;
        if (s.inventory) {
          invEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'inv-title', textContent: s.inventory.title }),
            ...s.inventory.items.map((t) => Object.assign(document.createElement('div'), { className: 'inv-item', textContent: t })));
        }
      }
      set(prompt, s.prompt);
      prompt.style.display = s.prompt ? '' : 'none';
      ask.style.display = s.commitAsk ? '' : 'none';
      if (s.commitAsk) {
        set(askTitle, s.commitAsk.title);
        set(askHint, s.commitAsk.hint);
        askBar.style.display = s.commitAsk.progress === null ? 'none' : '';
        askFill.style.width = `${(s.commitAsk.progress ?? 0) * 100}%`;
      }
      set(notice, s.notice);
      notice.style.display = s.notice ? '' : 'none';
      if (last.noticeKind !== s.noticeKind) notice.className = `notice ${s.noticeKind}`;
      set(controls, s.controls);
      // The panel always shows the phase; the countdown and heat appear under it during a run.
      clock.querySelector<HTMLElement>('.clock-row')!.style.display = s.clock ? '' : 'none';
      if (s.clock) {
        const share = s.clock.total > 0 ? Math.max(0, Math.min(1, s.clock.sec / s.clock.total)) : 0;
        setClass(clock, `clock ${clockStep(share)}`);
        clockFill.style.width = `${share * 100}%`;
        set(clockTime, clockText(s.clock.sec));
        set(clockRate, s.clock.to ? `to ${s.clock.to}` : drainText(s.clock.rate));
        setClass(clockRate, `clock-rate${s.clock.to ? ' town' : s.clock.rate >= 1.5 ? ' faster' : s.clock.rate > 1.001 ? ' fast' : ''}`);
        clockFill.style.setProperty('--tr-stripe-sec', `${(1 / s.clock.rate).toFixed(3)}s`);
      }
      heatRow.style.display = s.heat ? '' : 'none';
      if (s.heat) {
        const band = heatBand(s.heat.now, s.heat.max);
        setClass(heatRow, `heat-row ${band}`);
        heatFill.style.width = `${Math.max(0, Math.min(100, (s.heat.now / s.heat.max) * 100))}%`;
        set(heatLabel, `HEAT ${Math.round(s.heat.now)} · ${band}`);
      }
      const notices = s.heatNotices.join('\n');
      if (heatNotices.dataset.text !== notices) {
        heatNotices.dataset.text = notices;
        heatNotices.replaceChildren(...s.heatNotices.map((t) => Object.assign(document.createElement('div'), { textContent: t })));
      }
      if (last.alarm !== s.alarm) edge.classList.toggle('on', s.alarm);
      debug.style.display = s.debug === null ? 'none' : '';
      if (s.debug !== null) set(debug, s.debug);
      last = s;
    },
  };
}
