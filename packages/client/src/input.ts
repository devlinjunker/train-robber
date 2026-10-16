// Keyboard input: a source that only reports key state, and a mapper that turns that state
// into this tick's commands. The mapper asks the active view how screen directions map into
// the world (and into a car's frame aboard), so the sim never sees the screen.
import type { Command, Steering } from '@train-robber/sim';

/** One-shot actions, queued on key press. Game actions go to the sim; view actions stay in the client. */
/** 1 to 9 drop that item from the open inventory (I). */
export type SlotAction = `slot${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type GameAction = 'commit' | 'jump' | 'cancel' | 'retry' | 'switch' | 'drop' | 'heat' | 'alarm' | 'boost' | SlotAction;
export type ViewAction = 'zoomIn' | 'zoomOut' | 'toggleView' | 'toggleMapOverlay' | 'toggleZones' | 'toggleDebug' | 'toggleMinimap' | 'toggleInventory' | 'exportLogs' | 'addNote' | 'toggleMute';
export type Action = GameAction | ViewAction;

/** Bindings live in the client, not sim config. */
export const BINDINGS: Readonly<Record<string, Action>> = {
  KeyE: 'commit', Space: 'jump', Escape: 'cancel', KeyR: 'retry', Tab: 'switch', KeyX: 'drop',
  // C: the horse boost (handlingModel arcade-boost). F stays free for the whistle (M4).
  KeyC: 'boost',
  KeyQ: 'zoomOut', Minus: 'zoomOut', KeyZ: 'zoomIn', Equal: 'zoomIn',
  KeyV: 'toggleView', KeyO: 'toggleMapOverlay', KeyB: 'toggleZones', KeyM: 'toggleMinimap', Backquote: 'toggleDebug', KeyL: 'exportLogs', KeyN: 'addNote',
  // Playtest debug: H raises heat by a step, Shift+H raises an alarm's worth (see actionFor).
  KeyH: 'heat', KeyU: 'toggleMute',
  // I shows what you carry; with it open, 1 to 9 drop that item.
  KeyI: 'toggleInventory',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Digit${i + 1}`, `slot${i + 1}` as SlotAction])),
};
const SLOT_ACTIONS = Array.from({ length: 9 }, (_, i) => `slot${i + 1}` as SlotAction);
const GAME_ACTIONS = new Set<Action>(['commit', 'jump', 'cancel', 'retry', 'switch', 'drop', 'heat', 'alarm', 'boost', ...SLOT_ACTIONS]);

/** The action a key press means; Shift+H is the alarm debug key. */
export function actionFor(code: string, shift: boolean): Action | undefined {
  return code === 'KeyH' && shift ? 'alarm' : BINDINGS[code];
}
// Tab would move focus off the canvas.
const NO_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);

export interface InputSnapshot {
  held: ReadonlySet<string>;
  /** Game actions pressed since the last poll, in order. */
  actions: GameAction[];
}

/** Reports held keys and queues pressed actions; no game logic. View actions go to `onView`. */
export class KeyboardSource {
  private readonly held = new Set<string>();
  private queued: GameAction[] = [];

  constructor(onView: (a: ViewAction) => void, target: Pick<Window, 'addEventListener'> = window) {
    target.addEventListener('keydown', (e) => {
      this.held.add(e.code);
      if (NO_SCROLL.has(e.code)) e.preventDefault();
      const a = actionFor(e.code, e.shiftKey);
      if (!a || e.repeat) return;
      if (GAME_ACTIONS.has(a)) this.queued.push(a as GameAction);
      else onView(a as ViewAction);
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    // A key released while the window is unfocused never sends keyup.
    target.addEventListener('blur', () => this.held.clear());
  }

  /** Forget held keys, e.g. after a modal dialog swallowed their keyup. */
  release(): void { this.held.clear(); }

  poll(): InputSnapshot {
    const actions = this.queued;
    this.queued = [];
    return { held: this.held, actions };
  }
}

/** What the mapper needs to know about the game and the active view this tick. */
export interface MapContext {
  steering: Steering;
  aboard: boolean;
  /** A key direction on screen as a unit world direction, as the active view draws the world. */
  keyDirToWorld(dx: number, dy: number): [number, number];
  /**
   * Aboard: a key direction on screen as a unit direction in the car's frame, [toward the front,
   * toward the right side], as the active view draws the car. Null when not aboard.
   */
  keyDirToCar(dx: number, dy: number): [number, number] | null;
  /** The commit query's answer: the train E would commit to, if any. */
  commitTarget(): string | null;
  /** The switch query's answer: the train Tab would move the run to, if any. */
  switchTarget(): string | null;
  /** How many items the player carries; X drops the last one picked up. */
  carriedCount(): number;
  /** Whether the inventory panel (I) is open, so number keys drop items. */
  inventoryOpen(): boolean;
}

/**
 * A unit world direction in a car's frame, [toward the front, toward the right side], for a car
 * whose front points along (ux, uy). Right of travel is (-uy, ux), as in the sim's car poses.
 */
export function worldDirToCar(wx: number, wy: number, car: { ux: number; uy: number }): [number, number] {
  return [wx * car.ux + wy * car.uy, wy * car.ux - wx * car.uy];
}

/** Walking aboard uses half the move axis, so half of `player.speedTilesPerSec`; Shift runs at full. */
export const WALK_AXIS = 64;
const FULL = 127;

const q = (v: number) => Math.round(Math.max(-FULL, Math.min(FULL, v))) || 0; // never -0

export class InputMapper {
  private lastMove = { x: 0, y: 0 };
  private lastSteer = { x: 0, y: 0 };
  private eDown = false;

  /** Commands for one tick. Intents are only sent when they change, which keeps the log small. */
  commands(snap: InputSnapshot, ctx: MapContext): Command[] {
    const k = snap.held;
    const axis = (pos: string, neg: string) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    let x = 0, y = 0, sx = 0, sy = 0;
    if (ctx.aboard) {
      // WASD walk screen-relative in both steering variants, turned into the car's frame.
      const dir = ctx.keyDirToCar(axis('KeyD', 'KeyA'), axis('KeyS', 'KeyW'));
      if (dir) {
        const scale = k.has('ShiftLeft') || k.has('ShiftRight') ? FULL : WALK_AXIS;
        x = q(dir[0] * scale); y = q(dir[1] * scale);
      }
    } else {
      // W/S throttle in both variants. Heading-relative: A/D turn the horse. Screen-relative:
      // the arrows give a screen direction, sent as the world direction the horse turns to face.
      y = axis('KeyS', 'KeyW') * FULL;
      if (ctx.steering === 'heading') x = axis('KeyD', 'KeyA') * FULL;
      else {
        const [wx, wy] = ctx.keyDirToWorld(axis('ArrowRight', 'ArrowLeft'), axis('ArrowDown', 'ArrowUp'));
        sx = q(wx * FULL); sy = q(wy * FULL);
      }
    }
    const out: Command[] = [];
    if (x !== this.lastMove.x || y !== this.lastMove.y) out.push({ type: 'move', x, y });
    if (sx !== this.lastSteer.x || sy !== this.lastSteer.y) out.push({ type: 'steer', x: sx, y: sy });
    this.lastMove = { x, y }; this.lastSteer = { x: sx, y: sy };
    // E: a press commits while riding (or searches aboard) and a release ends the hold, so the sim
    // always knows whether E is held. A tap shorter than a tick still arrives as a queued press.
    const eHeld = k.has('KeyE');
    if (!this.eDown && (eHeld || snap.actions.includes('commit'))) {
      this.eDown = true;
      // Riding, ask the sim which train, if any, can be committed; with none, interact gets the reason.
      const target = ctx.aboard ? null : ctx.commitTarget();
      out.push(target ? { type: 'startRun', trainId: target } : { type: 'interact', held: true });
    }
    if (this.eDown && !eHeld) { this.eDown = false; out.push({ type: 'interact', held: false }); }
    for (const a of snap.actions) {
      if (a === 'commit') continue;
      if (a === 'jump') out.push({ type: 'jump' });
      else if (a === 'cancel') out.push({ type: 'cancelRun' });
      else if (a === 'switch') {
        // Name the train the prompt showed; with none, the sim says why.
        const target = ctx.switchTarget();
        out.push(target ? { type: 'switchTrain', trainId: target } : { type: 'switchTrain' });
      }
      else if (a === 'heat') out.push({ type: 'debugHeat' });
      else if (a === 'alarm') out.push({ type: 'debugHeat', source: 'alarmRaised' });
      else if (a === 'boost') out.push({ type: 'boost' });
      else if (a === 'drop') out.push({ type: 'drop', slot: Math.max(0, ctx.carriedCount() - 1) });
      else if (a.startsWith('slot')) {
        // Number keys only drop while the inventory is open, and only an item that is there.
        const slot = Number(a.slice(4)) - 1;
        if (ctx.inventoryOpen() && slot < ctx.carriedCount()) out.push({ type: 'drop', slot });
      }
      else out.push({ type: 'quickRetry' });
    }
    return out;
  }
}
