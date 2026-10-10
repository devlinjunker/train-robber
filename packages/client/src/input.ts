// Keyboard input: a source that only reports key state, and a mapper that turns that state
// into this tick's commands. The mapper asks the active view how screen directions map into
// the world (and into a car's frame aboard), so the sim never sees the screen.
import type { Command, Steering } from '@train-robber/sim';

/** One-shot actions, queued on key press. Game actions go to the sim; view actions stay in the client. */
export type GameAction = 'commit' | 'jump' | 'cancel' | 'retry';
export type ViewAction = 'zoomIn' | 'zoomOut' | 'toggleView' | 'toggleMapOverlay' | 'toggleZones' | 'toggleDebug' | 'exportLogs';
export type Action = GameAction | ViewAction;

/** Bindings live in the client, not sim config. */
export const BINDINGS: Readonly<Record<string, Action>> = {
  KeyE: 'commit', Space: 'jump', Escape: 'cancel', KeyR: 'retry',
  KeyQ: 'zoomOut', Minus: 'zoomOut', KeyZ: 'zoomIn', Equal: 'zoomIn',
  KeyV: 'toggleView', KeyO: 'toggleMapOverlay', KeyB: 'toggleZones', Backquote: 'toggleDebug', KeyL: 'exportLogs',
};
const GAME_ACTIONS = new Set<Action>(['commit', 'jump', 'cancel', 'retry']);
const NO_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

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
      const a = BINDINGS[e.code];
      if (!a || e.repeat) return;
      if (GAME_ACTIONS.has(a)) this.queued.push(a as GameAction);
      else onView(a as ViewAction);
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    // A key released while the window is unfocused never sends keyup.
    target.addEventListener('blur', () => this.held.clear());
  }

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
    for (const a of snap.actions) {
      if (a === 'commit') {
        // Ask the sim which train, if any, can be committed; with none, interact gets the reason.
        const target = ctx.commitTarget();
        out.push(target ? { type: 'startRun', trainId: target } : { type: 'interact', held: false });
      } else if (a === 'jump') out.push({ type: 'jump' });
      else if (a === 'cancel') out.push({ type: 'cancelRun' });
      else out.push({ type: 'quickRetry' });
    }
    return out;
  }
}
