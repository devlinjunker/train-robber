// The boost cue in the isometric view (Devlin, M3 playtest 2026-10-18: the boost was hard to
// notice away from the train): while the horse boosts it throws up puffs of dust behind it that
// swell, drift and fade. View only: the sim already applies the boost.
import { Graphics } from 'pixi.js';
import { oval } from './draw';
import { depthOf, isoX, isoY, TILE_H } from '../projection';
import type { ActorPose } from '../interp';

const DUST_COLOUR = 0xf6eedc;
const MAX_PUFFS = 100, PUFF_SEC = 1.1, PUFFS_PER_SEC = 34;

interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; bornSec: number; r: number }

export interface DustInput {
  horse: ActorPose | null;
  boosting: boolean;
  /** Tiles per second. */
  speed: number;
  timeSec: number;
  groundZ?: number;
}

export interface DustEffect {
  /** Dust puffs, sorted with the horse. */
  puffs: Graphics;
  update(input: DustInput): void;
}

/** View-only randomness: the sim never sees it. */
const rand = Math.random;

/** `strength` scales how opaque the puffs are (1 = default; ?boostDust= in the URL, 0 hides them). */
export function createDust(strength = 1): DustEffect {
  const puffs = new Graphics();
  const live: Puff[] = [];
  let lastSec: number | null = null, owed = 0;
  return {
    puffs,
    update({ horse, boosting, speed, timeSec, groundZ = 0 }) {
      const dt = lastSec === null ? 0 : Math.min(0.1, Math.max(0, timeSec - lastSec));
      lastSec = timeSec;
      if (boosting && horse && strength > 0) {
        owed += dt * PUFFS_PER_SEC;
        for (; owed >= 1 && live.length < MAX_PUFFS; owed--) {
          const side = (rand() - 0.5) * 0.7, back = 0.7 + 0.3 * rand();
          live.push({
            x: horse.x - horse.hx * back - horse.hy * side,
            y: horse.y - horse.hy * back + horse.hx * side,
            z: groundZ + 0.05,
            // Thrown back off the hooves, then left behind as the horse runs on.
            vx: -horse.hx * speed * 0.15 + (rand() - 0.5) * 1.2,
            vy: -horse.hy * speed * 0.15 + (rand() - 0.5) * 1.2,
            vz: 0.8 + 1.0 * rand(),
            bornSec: timeSec,
            r: 0.26 + 0.15 * rand(),
          });
        }
      } else owed = 0;

      puffs.clear();
      let depth = 0;
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i]!;
        const age = (timeSec - p.bornSec) / PUFF_SEC;
        if (age >= 1) { live.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vx *= 1 - 2 * dt; p.vy *= 1 - 2 * dt; p.vz *= 1 - 2 * dt;
        const r = p.r * (1 + 2.5 * age) * TILE_H;
        oval(puffs, isoX(p.x, p.y), isoY(p.x, p.y, p.z), r, r * 0.7).fill({ color: DUST_COLOUR, alpha: Math.min(1, 0.6 * strength) * (1 - age * age) });
        depth = Math.max(depth, depthOf(p.x, p.y));
      }
      puffs.zIndex = depth;
    },
  };
}
