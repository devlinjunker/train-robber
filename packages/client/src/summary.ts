// The end-of-run summary (phase 2 M5): outcome, loot banked, time, heat, the wanted level change,
// and the bank, with a quick retry. Built from the sim's events only, so it never decides anything.
import type { HeatRoll, PersistentState, RunOutcome, SimEvent } from '@train-robber/sim';

/** One run on the host's local leaderboard, as the summary shows it. */
export interface BestRun { score: number; date: string }

export interface RunSummaryView {
  outcome: RunOutcome;
  /** Ticks from commit to the end. */
  durationTicks: number;
  heat: number;
  /** The run end's heat roll for +wanted (M6b), or null when this outcome does not roll. */
  heatRoll: HeatRoll | null;
  /** Wanted levels a hit adds (`wanted.perHeatRoll`). */
  perHeatRoll?: number;
  /** What the outcome banked (or, in practice, would have banked). */
  banked: number;
  /** Loot value lost on the way: thrown off, falls and mount spills. */
  lost: number;
  /** Items picked up during the run. */
  picked: number;
  before: PersistentState;
  after: PersistentState;
  /** The wanted level the run was played at. */
  wantedLevel: number;
  practice: boolean;
  endOfLine: boolean;
}

const TITLES: Record<RunOutcome, string> = {
  extracted: 'EXTRACTED', cashedOut: 'GOT AWAY', expired: 'RUN EXPIRED', died: 'YOU DIED', cancelled: 'RUN CANCELLED', caught: 'CAUGHT',
};
const KIND: Record<RunOutcome, 'good' | 'bad' | 'info'> = { extracted: 'good', cashedOut: 'good', expired: 'bad', died: 'bad', cancelled: 'info', caught: 'bad' };

const CSS = `
.tr-summary { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); z-index: 2; min-width: 320px; max-width: min(460px, calc(100vw - 32px));
  background: rgba(10,14,10,.88); border: 1px solid #fff4; border-radius: 10px; padding: 14px 18px; color: #fff;
  font: 14px/1.45 ui-monospace, Menlo, Consolas, monospace; box-shadow: 0 6px 24px #0008; }
.tr-summary h2 { margin: 0 0 6px; font-size: 22px; letter-spacing: .06em; }
.tr-summary.good h2 { color: #6bff8a; } .tr-summary.bad h2 { color: #ff6b5e; } .tr-summary.info h2 { color: #ffcf7a; }
.tr-summary .practice { color: #9ecbff; font-weight: 700; margin-bottom: 6px; }
.tr-summary table { border-collapse: collapse; width: 100%; }
.tr-summary td { padding: 1px 0; vertical-align: top; } .tr-summary td:last-child { text-align: right; font-weight: 700; }
.tr-summary .up { color: #ff6b5e; } .tr-summary .muted { color: #aaa; font-weight: 400; }
.tr-summary .best { margin-top: 8px; font-size: 12px; color: #ccc; }
.tr-summary .buttons { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
.tr-summary button { font: 13px ui-monospace, Menlo, Consolas, monospace; padding: 4px 10px; cursor: pointer; }
`;

const money = (v: number) => `$${Math.round(v)}`;

/** The heat roll as the summary shows it: `34% chance: hit, wanted +1`, `34% chance: missed`, or `off`. */
export function heatRollText(roll: HeatRoll | null, perHit = 1): string {
  if (!roll) return '<span class="muted">off for this outcome</span>';
  const pct = `${Math.round(roll.chance * 100)}% chance`;
  return roll.hit ? `${pct}: <span class="up">hit, wanted +${perHit}</span>` : `${pct}: missed`;
}
const stars = (level: number, max: number) => '★'.repeat(level) + '☆'.repeat(Math.max(0, max - level));

/** Follows the events and builds a summary when a run ends (quick retries get none). */
export function createSummaryTracker() {
  let lost = 0, picked = 0, wantedLevel = 0, practice = false;
  let ended: Extract<SimEvent, { type: 'RunEnded' }> | null = null;
  return {
    /** Returns the summary when this event completes one. */
    event(e: SimEvent): RunSummaryView | null {
      if (e.type === 'RunStarted') {
        // A resumed run keeps its losses so far; a fresh one starts from zero.
        if (!e.resumed) { lost = 0; picked = 0; }
        wantedLevel = e.wantedLevel; practice = !!e.practice;
      } else if (e.type === 'LootLost' || e.type === 'LootSpilled') lost += e.value;
      else if (e.type === 'LootPickedUp') picked++;
      else if (e.type === 'RunEnded') ended = e;
      else if (e.type === 'PersistentChanged' && ended) {
        const r = ended;
        ended = null;
        if (r.retry) return null;
        return {
          outcome: r.outcome, durationTicks: r.durationTicks, heat: r.heat, heatRoll: r.heatRoll ?? null, banked: r.cashOut, lost, picked,
          before: e.before, after: e.after, wantedLevel, practice: practice || !!e.practice, endOfLine: !!r.endOfLine,
        };
      }
      return null;
    },
  };
}

export interface SummaryPanelOptions {
  tickRateHz: number;
  maxWantedLevel: number;
  /** `wanted.perHeatRoll`: what a heat roll that hits adds. */
  perHeatRoll?: number;
  /** Quick retry is on (`playtest.quickRetry`). */
  quickRetry: boolean;
  onRetry(): void;
  /** The host's best runs, best first, read when a summary opens. */
  bestRuns?(): readonly BestRun[];
}

export function createSummaryPanel(opts: SummaryPanelOptions, parent: HTMLElement = document.body) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'tr-summary';
  root.style.display = 'none';
  parent.appendChild(root);

  const hide = () => {
    root.style.display = 'none';
  };
  const button = (text: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', (ev) => { onClick(); (ev.currentTarget as HTMLButtonElement).blur(); });
    return b;
  };

  return {
    show(v: RunSummaryView) {
      hide();
      const sec = v.durationTicks / opts.tickRateHz;
      const time = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
      const dWanted = v.after.wantedLevel - v.before.wantedLevel;
      const wantedText = v.practice
        ? `${stars(v.wantedLevel, opts.maxWantedLevel)} ${v.wantedLevel} (forced)`
        : dWanted === 0 ? `${stars(v.after.wantedLevel, opts.maxWantedLevel)} ${v.after.wantedLevel}, no change`
          : `${v.before.wantedLevel} → ${v.after.wantedLevel} <span class="up">${dWanted > 0 ? '+' : ''}${dWanted}</span>`;
      const lootText = v.banked > 0 ? (v.practice ? `${money(v.banked)} <span class="muted">(practice: not banked)</span>` : money(v.banked))
        : v.outcome === 'extracted' || v.outcome === 'cashedOut' ? '$0' : '$0 <span class="muted">(loot lost)</span>';
      const rows: [string, string][] = [
        ['Loot banked', lootText],
        ...(v.lost > 0 ? [['Lost on the way', money(v.lost)] as [string, string]] : []),
        ['Items picked up', String(v.picked)],
        ['Time', time],
        ['Heat at end', String(Math.round(v.heat))],
        ['Heat roll', heatRollText(v.heatRoll, opts.perHeatRoll ?? 1)],
        ['Wanted level', wantedText],
        ...(v.practice ? [] : [['Bank', `${money(v.after.bank)} <span class="muted">lifetime ${money(v.after.lifetimeEarned)}</span>`] as [string, string]]),
      ];
      const best = opts.bestRuns?.() ?? [];
      const rank = !v.practice && v.banked > 0 ? best.filter((b) => b.score > v.banked).length + 1 : null;
      const bestLine = best.length === 0 ? '' : `Best runs: ${best.slice(0, 3).map((b) => money(b.score)).join(', ')}${rank !== null && rank <= best.length ? `  ·  this run #${rank}` : ''}`;
      root.className = `tr-summary ${KIND[v.outcome]}`;
      root.innerHTML = `<h2>${TITLES[v.outcome]}${v.endOfLine ? ' <span class="muted">(end of the line)</span>' : ''}</h2>`
        + (v.practice ? `<div class="practice">Practice run at wanted level ${v.wantedLevel}: nothing was saved</div>` : '')
        + `<table>${rows.map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`).join('')}</table>`
        + (bestLine ? `<div class="best">${bestLine}</div>` : '');
      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      if (opts.quickRetry) buttons.append(button('Quick retry (R)', () => { hide(); opts.onRetry(); }));
      buttons.append(button('Close', hide));
      root.append(buttons);
      root.style.display = '';
    },
    hide,
  };
}
