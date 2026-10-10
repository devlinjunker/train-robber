// The HTML HUD over the canvas: health, the run phase, the commit prompt, jump rejection reasons
// and results, and the controls. The debug readout lives here too, toggled with the backquote key.
// The meter is not here: it is drawn in the world above the horse (decision Q12).

export type NoticeKind = 'bad' | 'good' | 'warn' | 'info';

export interface HudState {
  phase: string;
  /** Health while a run is active, else null. */
  health: { now: number; max: number } | null;
  /** True for a moment after a crash costs health: a red icon and the health bar flash. */
  hit: boolean;
  /** The main prompt line: what to do next. */
  prompt: string;
  /** A short-lived notice (rejection reason, jump result, run end), or empty. */
  notice: string;
  noticeKind: NoticeKind;
  controls: string;
  debug: string | null;
}

const CSS = `
.tr-hud { position: fixed; inset: 0; pointer-events: none; font: 14px/1.35 ui-monospace, Menlo, Consolas, monospace; color: #fff; }
.tr-hud .top { position: absolute; top: 40px; right: 8px; display: flex; gap: 14px; align-items: center;
  background: rgba(0,0,0,.55); padding: 6px 12px; border-radius: 8px; }
.tr-hud .phase { font-weight: 700; letter-spacing: .06em; }
.tr-hud .health { width: 180px; height: 14px; background: #3a1d1d; border: 1px solid #fff8; border-radius: 3px; overflow: hidden; }
.tr-hud .health > div { height: 100%; background: linear-gradient(#ff7a6b, #d63c2f); transition: width .2s; }
.tr-hud .bottom { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); text-align: center; }
.tr-hud .prompt { font-size: 20px; font-weight: 700; text-shadow: 0 2px 3px #000; }
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
.tr-hud .debug { position: absolute; top: 8px; left: 8px; margin: 0; font-size: 11px; white-space: pre; overflow: hidden; text-overflow: ellipsis; max-width: min(36vw, 560px);
  background: rgba(0,0,0,.45); padding: 6px 8px; border-radius: 4px; }
`;

export function createHud(parent: HTMLElement = document.body): { update(s: HudState): void } {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'tr-hud';
  root.innerHTML = `<pre class="debug"></pre>
    <div class="top"><span class="phase"></span><span class="hit">!</span><span class="hp-label">health</span><div class="health"><div></div></div><span class="hp-text"></span></div>
    <div class="bottom"><div class="prompt"></div><div class="notice"></div><div class="controls"></div></div>`;
  parent.appendChild(root);
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const top = q('.top'), hit = q('.hit');
  const debug = q('.debug'), phase = q('.phase'), hpLabel = q('.hp-label'), health = q('.health'), bar = q<HTMLDivElement>('.health > div'),
    hpText = q('.hp-text'), prompt = q('.prompt'), notice = q('.notice'), controls = q('.controls');
  // Only touch the DOM when a value changes.
  let last: Partial<HudState> = {};
  const set = (el: HTMLElement, text: string) => { if (el.textContent !== text) el.textContent = text; };

  return {
    update(s) {
      set(phase, s.phase.toUpperCase());
      const hasHp = s.health !== null;
      hpLabel.style.display = health.style.display = hpText.style.display = hit.style.display = hasHp ? '' : 'none';
      if (last.hit !== s.hit) top.classList.toggle('hit-on', s.hit);
      if (s.health) {
        const pct = Math.max(0, Math.min(100, (s.health.now / s.health.max) * 100));
        bar.style.width = `${pct}%`;
        set(hpText, `${s.health.now}/${s.health.max}`);
      }
      set(prompt, s.prompt);
      set(notice, s.notice);
      notice.style.display = s.notice ? '' : 'none';
      if (last.noticeKind !== s.noticeKind) notice.className = `notice ${s.noticeKind}`;
      set(controls, s.controls);
      debug.style.display = s.debug === null ? 'none' : '';
      if (s.debug !== null) set(debug, s.debug);
      last = s;
    },
  };
}
