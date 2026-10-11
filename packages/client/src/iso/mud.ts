// The mud cue in the isometric view (Devlin, extra-maps playtest 2026-10-11): while the horse is
// in mud it kicks up clods behind its hind legs, leaves hoof prints that fade, and its legs get
// muddy and dry off a few seconds after it leaves. View only: the sim already slows the horse.
import { Graphics } from 'pixi.js';
import { groundEllipse, shade } from './draw';
import { MUD_COLOUR } from './terrain';
import { depthOf, isoX, isoY, TILE_H } from '../projection';
import type { ActorPose } from '../interp';

const CLOD_COLOUR = shade(MUD_COLOUR, 0.6);
const PRINT_COLOUR = shade(MUD_COLOUR, 0.45);
const GRAVITY = 16;
const MAX_CLODS = 120, PRINT_SEC = 5, PRINT_EVERY_TILES = 0.9;
/** Legs coat in this many seconds in mud and dry in DRY_SEC out of it. */
const COAT_SEC = 0.6, DRY_SEC = 4;

interface Clod { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number }
interface Print { x: number; y: number; bornSec: number }

export interface MudInput {
  horse: ActorPose | null;
  /** Tiles per second. */
  speed: number;
  inMud: boolean;
  timeSec: number;
}

export interface MudEffect {
  /** Hoof prints, on the ground under everything. */
  prints: Graphics;
  /** Flying clods, sorted with the horse. */
  clods: Graphics;
  /** How muddy the horse's legs are, 0 to 1. */
  muddiness: number;
  update(input: MudInput): void;
}

/** View-only randomness: the sim never sees it. */
const rand = Math.random;

export function createMud(): MudEffect {
  const prints = new Graphics(), clods = new Graphics();
  const flying: Clod[] = [], trail: Print[] = [];
  let lastSec: number | null = null, owed = 0, travelled = 0, leftFoot = false;
  const fx: MudEffect = {
    prints, clods, muddiness: 0,
    update({ horse, speed, inMud, timeSec }) {
      const dt = lastSec === null ? 0 : Math.min(0.1, Math.max(0, timeSec - lastSec));
      lastSec = timeSec;
      const kicking = horse !== null && inMud && speed > 0.3;
      fx.muddiness = kicking ? Math.min(1, fx.muddiness + dt / COAT_SEC) : Math.max(0, fx.muddiness - dt / DRY_SEC);

      if (kicking && horse) {
        // More clods the faster it goes, thrown up and back from the hind legs.
        owed += dt * (8 + speed * 5);
        for (; owed >= 1 && flying.length < MAX_CLODS; owed--) {
          const side = rand() < 0.5 ? 1 : -1, back = 0.55 + 0.2 * rand();
          flying.push({
            x: horse.x - horse.hx * back - horse.hy * 0.18 * side,
            y: horse.y - horse.hy * back + horse.hx * 0.18 * side,
            z: 0.15,
            vx: -horse.hx * speed * (0.25 + 0.3 * rand()) + (rand() - 0.5) * 1.6,
            vy: -horse.hy * speed * (0.25 + 0.3 * rand()) + (rand() - 0.5) * 1.6,
            vz: 2.5 + 2.5 * rand(),
            r: 0.08 + 0.1 * rand(),
          });
        }
        // Prints, alternating feet, about a stride apart.
        travelled += speed * dt;
        while (travelled >= PRINT_EVERY_TILES) {
          travelled -= PRINT_EVERY_TILES;
          leftFoot = !leftFoot;
          const s = leftFoot ? 0.2 : -0.2;
          trail.push({ x: horse.x - horse.hy * s, y: horse.y + horse.hx * s, bornSec: timeSec });
        }
      } else owed = 0;

      clods.clear();
      let depth = 0;
      for (let i = flying.length - 1; i >= 0; i--) {
        const c = flying[i]!;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt; c.vz -= GRAVITY * dt;
        if (c.z <= 0) { flying.splice(i, 1); continue; }
        clods.circle(isoX(c.x, c.y), isoY(c.x, c.y, c.z), c.r * TILE_H);
        depth = Math.max(depth, depthOf(c.x, c.y));
      }
      clods.fill(CLOD_COLOUR);
      // The clods land behind the horse, so they sort just in front of the nearest one's ground point.
      clods.zIndex = depth;

      prints.clear();
      while (trail.length && timeSec - trail[0]!.bornSec > PRINT_SEC) trail.shift();
      for (const p of trail) groundEllipse(prints, p.x, p.y, 0.16).fill({ color: PRINT_COLOUR, alpha: 0.7 * (1 - (timeSec - p.bornSec) / PRINT_SEC) });
    },
  };
  return fx;
}
