// The wanted poster when an outlaw's life ends, and the wall of past posters (roguelite life). Pure
// DOM over the canvas, like the run summary. The host owns the records; this only draws them.

/** The seeded face parts a poster draws (hat, hair, beard, scar, bandana), each an index into its list. */
export interface PosterFace { hat: number; beard: number; scar: number; bandana: number; brow: number }

/** One finished life, as the poster shows it. */
export interface PosterView {
  lifeId: string;
  name: string;
  nickname: string;
  face: PosterFace;
  /** `died`: DECEASED across it. `rodeOff`: the outlaw got out alive (a ticket, or the last day of a `life.days` life). */
  ending: 'died' | 'rodeOff';
  /** The ticket out they bought (`life.tickets`), whose stamp goes across the poster. */
  ticket?: { id: string; name: string; stamp: string };
  /** The life score. */
  reward: number;
  /** Cash banked in the life. */
  cash: number;
  robberies: number;
  bestHaul: number;
  days: number;
  maxWanted: number;
  /** "crushed under a train", "rode off alive". */
  cause: string;
  /** "near Town 2", "on Alpha Flats". */
  place: string;
  endedAt: string;
}

export interface PosterPanelOptions {
  maxWantedLevel: number;
}

const CSS = `
.tr-poster-back { position: fixed; inset: 0; z-index: 3; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; overflow-y: auto; }
.tr-poster { width: min(340px, calc(100vw - 32px)); background: #e9d8b0; color: #2b1d10; border: 1px solid #8a6a3a;
  box-shadow: 0 8px 30px #000a, inset 0 0 40px #b8955a88; padding: 16px 18px 14px; font-family: Georgia, 'Times New Roman', serif; text-align: center; position: relative; box-sizing: border-box; }
.tr-poster h1 { margin: 0; font-size: 44px; letter-spacing: .12em; line-height: 1; font-weight: 900; }
.tr-poster .sub { font-size: 12px; letter-spacing: .3em; margin: 4px 0 8px; text-transform: uppercase; }
.tr-poster svg { width: 150px; height: 150px; background: #d9c497; border: 2px solid #5a4020; display: block; margin: 0 auto; }
.tr-poster .name { font-size: 20px; font-weight: 700; margin-top: 8px; }
.tr-poster .reward { font-size: 28px; font-weight: 900; margin: 6px 0 2px; letter-spacing: .04em; }
.tr-poster .facts { font-size: 13px; line-height: 1.4; margin-top: 6px; }
.tr-poster .stamp { position: absolute; left: 50%; top: 120px; transform: translateX(-50%) rotate(-18deg); border: 4px solid #a3201a; color: #a3201a;
  font: 900 32px/1 Georgia, serif; letter-spacing: .12em; padding: 4px 10px; opacity: .85; background: #e9d8b066; pointer-events: none; }
.tr-poster .stamp.alive { border-color: #1f6b2a; color: #1f6b2a; font-size: 22px; }
.tr-poster .best { margin-top: 6px; font: 12px ui-monospace, Menlo, Consolas, monospace; color: #5a4020; }
.tr-poster .buttons { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
.tr-poster button { font: 13px ui-monospace, Menlo, Consolas, monospace; padding: 5px 12px; cursor: pointer; }
.tr-wall { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; background: #3b2a18; border: 1px solid #8a6a3a; padding: 14px; box-sizing: border-box;
  color: #f1e3c0; font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace; }
.tr-wall h2 { margin: 0 0 4px; font: 700 22px Georgia, serif; letter-spacing: .06em; }
.tr-wall .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.tr-wall .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.tr-wall .card { background: #e9d8b0; color: #2b1d10; padding: 8px; text-align: center; font-family: Georgia, serif; position: relative; border: 1px solid #8a6a3a; }
.tr-wall .card.best { outline: 3px solid #f2c14e; }
.tr-wall .card svg { width: 80px; height: 80px; background: #d9c497; border: 1px solid #5a4020; }
.tr-wall .card .w { font-weight: 900; letter-spacing: .1em; font-size: 15px; }
.tr-wall .card .n { font-weight: 700; font-size: 13px; }
.tr-wall .card .r { font-weight: 900; font-size: 16px; }
.tr-wall .card .f { font-size: 11px; line-height: 1.3; }
.tr-wall .card .tag { position: absolute; top: 4px; right: 4px; font: 700 10px ui-monospace, monospace; color: #a3201a; }
.tr-wall .card .tag.alive { color: #1f6b2a; }
.tr-wall .card .tag.best-tag { left: 4px; right: auto; color: #8a5a00; }
.tr-wall .top { margin: 0 0 10px; }
.tr-wall .top td { padding: 0 10px 0 0; }
.tr-wall .empty { color: #cdb98a; }
.tr-wall button { font: 13px ui-monospace, Menlo, Consolas, monospace; padding: 4px 10px; cursor: pointer; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** A poster-like reward: whole dollars, rounded to $10 from $100 and to $50 from $1,000, with thousands separators. */
export function posterReward(v: number): string {
  const r = v >= 1000 ? Math.round(v / 50) * 50 : v >= 100 ? Math.round(v / 10) * 10 : Math.round(v);
  return `$${r.toLocaleString('en-US')}`;
}
const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** What is stamped across a poster: DECEASED, the ticket's stamp, or RODE OFF. */
export const posterStamp = (p: Pick<PosterView, 'ending' | 'ticket'>): string => p.ending === 'died' ? 'DECEASED' : p.ticket?.stamp ?? 'RODE OFF';
export const fullName = (p: { name: string; nickname: string }) => p.nickname ? `“${p.nickname}” ${p.name}` : p.name;

/** The face as an SVG woodcut: head, eyes, then whichever hat, beard, scar and bandana the seed picked. */
export function faceSvg(f: PosterFace): string {
  const ink = '#2b1d10';
  const hats = [
    '<path d="M18 46 L82 46 L82 50 L18 50 Z M32 46 L36 22 L64 22 L68 46 Z" />',
    '<path d="M12 48 Q50 38 88 48 L88 52 Q50 44 12 52 Z M30 46 Q32 20 50 20 Q68 20 70 46 Z" />',
    '<path d="M22 46 L78 46 L74 50 L26 50 Z M34 46 L38 28 Q50 22 62 28 L66 46 Z" />',
    '<path d="M28 44 Q30 26 50 26 Q70 26 72 44 Z" />',
  ];
  const beards = [
    '',
    '<path d="M36 70 Q50 92 64 70 Q58 78 50 78 Q42 78 36 70 Z" />',
    '<path d="M38 68 Q50 64 62 68 Q58 72 50 70 Q42 72 38 68 Z" />',
    '<path d="M32 62 Q34 92 50 94 Q66 92 68 62 Q62 76 50 78 Q38 76 32 62 Z" />',
  ];
  const scars = ['', '<path d="M60 54 L68 66" stroke-width="2" stroke="#7a1e14" fill="none" />', '<path d="M34 72 L42 64" stroke-width="2" stroke="#7a1e14" fill="none" />'];
  const bandanas = ['', '<path d="M30 70 L70 70 L66 84 L50 92 L34 84 Z" fill="#7a1e14" />'];
  const brows = ['<path d="M38 56 L46 55 M54 55 L62 56" stroke-width="2" stroke="' + ink + '" />', '<path d="M38 54 L46 57 M54 57 L62 54" stroke-width="2" stroke="' + ink + '" />'];
  const pick = (list: string[], i: number) => list[((i % list.length) + list.length) % list.length]!;
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="${ink}">`
    + '<ellipse cx="50" cy="64" rx="18" ry="22" fill="#c9ad7a" stroke="' + ink + '" stroke-width="2" />'
    + '<rect x="42" y="84" width="16" height="12" fill="#c9ad7a" stroke="' + ink + '" stroke-width="2" />'
    + '<circle cx="43" cy="60" r="2" /><circle cx="57" cy="60" r="2" />'
    + pick(brows, f.brow)
    + '<path d="M44 76 Q50 78 56 76" stroke="' + ink + '" stroke-width="1.5" fill="none" />'
    + pick(beards, f.beard) + pick(scars, f.scar) + pick(bandanas, f.bandana) + pick(hats, f.hat)
    + '</g></svg>';
}

const TICKET_CSS = `
.tr-tickets { position: fixed; left: 50%; top: 18%; transform: translateX(-50%); z-index: 2; width: min(380px, calc(100vw - 32px)); box-sizing: border-box;
  background: #3b2a18; border: 1px solid #8a6a3a; color: #f1e3c0; padding: 12px 14px; font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace; box-shadow: 0 6px 24px #0008; }
.tr-tickets h2 { margin: 0 0 4px; font: 700 20px Georgia, serif; }
.tr-tickets .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
.tr-tickets .row b { display: block; } .tr-tickets .muted { color: #cdb98a; font-size: 12px; }
.tr-tickets button { font: 13px ui-monospace, Menlo, Consolas, monospace; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
`;

/** The tickets out of the territory, bought at camp (T): each tier with its price, and Buy where the bank covers it. */
export function createTicketPanel(parent: HTMLElement = document.body) {
  const style = document.createElement('style');
  style.textContent = TICKET_CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'tr-tickets';
  root.style.display = 'none';
  parent.appendChild(root);
  const hide = () => { root.style.display = 'none'; root.innerHTML = ''; };
  return {
    show(tickets: readonly { id: string; name: string; stamp: string; price: number }[], bank: number, onBuy: (id: string) => void) {
      root.innerHTML = `<h2>A ticket out of the territory</h2><div class="muted">Bank ${money(bank)}. Buying one ends this outlaw's life: they get out alive, and the ticket is stamped on their poster.</div>`;
      for (const t of tickets) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<div><b>${esc(t.name)}</b><span class="muted">${money(t.price)} · "${esc(t.stamp)}"</span></div>`;
        const b = document.createElement('button');
        b.textContent = bank >= t.price ? 'Buy' : `${money(t.price - bank)} short`;
        b.disabled = bank < t.price;
        b.addEventListener('click', (ev) => { (ev.currentTarget as HTMLButtonElement).blur(); hide(); onBuy(t.id); });
        row.append(b);
        root.append(row);
      }
      const close = document.createElement('div');
      close.className = 'row';
      close.innerHTML = '<span class="muted">T closes</span>';
      const c = document.createElement('button');
      c.textContent = 'Not yet';
      c.addEventListener('click', (ev) => { (ev.currentTarget as HTMLButtonElement).blur(); hide(); });
      close.append(c);
      root.append(close);
      root.style.display = '';
    },
    hide,
    get open() { return root.style.display !== 'none'; },
  };
}

export function createPosterPanel(opts: PosterPanelOptions, parent: HTMLElement = document.body) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const back = document.createElement('div');
  back.className = 'tr-poster-back';
  back.style.display = 'none';
  parent.appendChild(back);
  const hide = () => { back.style.display = 'none'; back.innerHTML = ''; };
  const button = (text: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', (ev) => { (ev.currentTarget as HTMLButtonElement).blur(); onClick(); });
    return b;
  };
  const facts = (p: PosterView) => [
    `For: ${plural(p.robberies, 'train robbery').replace('robberys', 'robberies')}${p.bestHaul > 0 ? `, best haul ${money(p.bestHaul)}` : ''}`,
    p.ending === 'died' ? `Last seen ${esc(p.place)}, ${esc(p.cause)}` : p.ticket ? `${esc(p.ticket.name)}, ${esc(p.place)}` : `Rode off ${esc(p.place)}`,
    `Rode ${plural(p.days, 'day')}, max wanted ${'★'.repeat(p.maxWanted)}${'☆'.repeat(Math.max(0, opts.maxWantedLevel - p.maxWanted))}`,
  ];

  return {
    /** The poster of the life that just ended. `rank` is its place among every life (1 = best). */
    show(p: PosterView, o: { rank: number; lives: number; bestReward: number; onRideAgain(): void; onWall(): void }) {
      hide();
      const card = document.createElement('div');
      card.className = 'tr-poster';
      const dead = p.ending === 'died';
      card.innerHTML = `<h1>WANTED</h1><div class="sub">${dead ? 'dead or alive' : 'gone from the territory'}</div>${faceSvg(p.face)}`
        + `<div class="stamp${dead ? '' : ' alive'}">${esc(posterStamp(p))}</div>`
        + `<div class="name">${esc(fullName(p))}</div>`
        + `<div class="reward">REWARD ${posterReward(p.reward)}</div>`
        + `<div class="facts">${facts(p).join('<br>')}</div>`
        + `<div class="best">${o.rank === 1 && o.lives > 1 ? 'Your best outlaw yet' : `#${o.rank} of ${o.lives} outlaw${o.lives === 1 ? '' : 's'}  ·  best ${posterReward(o.bestReward)}`}</div>`;
      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      buttons.append(button('Ride again (new outlaw)', () => { hide(); o.onRideAgain(); }), button('Poster wall', () => { hide(); o.onWall(); }));
      card.append(buttons);
      back.append(card);
      back.style.display = '';
    },
    /**
     * The wall: every past poster, newest first, the best marked, under the top lives. `current` is
     * the outlaw riding now (name and score so far). `onClose` runs when it shuts.
     */
    showWall(posters: readonly PosterView[], current: { name: string; reward: number; day: number } | null, onClose: () => void) {
      hide();
      const wall = document.createElement('div');
      wall.className = 'tr-wall';
      const best = posters.reduce<PosterView | null>((b, p) => (!b || p.reward > b.reward ? p : b), null);
      const top = [...posters].sort((a, b) => b.reward - a.reward || a.endedAt.localeCompare(b.endedAt)).slice(0, 5);
      const head = document.createElement('div');
      head.className = 'head';
      head.innerHTML = `<div><h2>Poster wall</h2>${current ? `Riding now: ${esc(current.name)}, day ${current.day}, ${posterReward(current.reward)} so far` : ''}</div>`;
      const close = button('Close', () => { hide(); onClose(); });
      head.append(close);
      wall.append(head);
      if (posters.length === 0) {
        wall.insertAdjacentHTML('beforeend', '<div class="empty">No posters yet. When an outlaw dies or rides off, their poster goes up here.</div>');
      } else {
        wall.insertAdjacentHTML('beforeend', `<table class="top"><tr><td colspan="4"><b>Top lives</b></td></tr>${top.map((p, i) => `<tr><td>#${i + 1}</td><td>${posterReward(p.reward)}</td><td>${esc(fullName(p))}</td><td>${esc(posterStamp(p).toLowerCase())}, ${plural(p.days, 'day')}</td></tr>`).join('')}</table>`);
        const cards = document.createElement('div');
        cards.className = 'cards';
        cards.innerHTML = posters.map((p) => `<div class="card${p === best ? ' best' : ''}">${p === best ? '<span class="tag best-tag">BEST</span>' : ''}<span class="tag${p.ending === 'died' ? '' : ' alive'}">${esc(posterStamp(p))}</span>`
          + `<div class="w">WANTED</div>${faceSvg(p.face)}<div class="n">${esc(fullName(p))}</div><div class="r">${posterReward(p.reward)}</div>`
          + `<div class="f">${plural(p.robberies, 'robbery').replace('robberys', 'robberies')} · ${plural(p.days, 'day')}<br>${p.ending === 'died' ? `${esc(p.cause)}, ${esc(p.place)}` : `${esc(p.ticket?.name ?? 'rode off')}, ${esc(p.place)}`}</div></div>`).join('');
        wall.append(cards);
      }
      back.append(wall);
      back.style.display = '';
    },
    hide,
    get open() { return back.style.display !== 'none'; },
  };
}
