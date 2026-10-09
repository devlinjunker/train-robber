import { z } from 'zod';
import { hashState } from '@train-robber/sim';

export const TuningSchema = z.object({
  schemaVersion: z.literal(1),
  tickRate: z.literal(60),
  player: z.object({ speedTilesPerSec: z.number().positive() }).strict(),
}).strict();
export type Tuning = z.infer<typeof TuningSchema>;

export interface ResolvedConfig { tuning: Tuning; hash: string }

function deepMerge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = k in out && typeof out[k] === 'object' ? deepMerge(out[k], v) : v;
  return out as T;
}

/** merge base + overlays -> validate (strict) -> hash. */
export function resolveConfig(base: unknown, overlays: unknown[] = []): ResolvedConfig {
  const merged = overlays.reduce<unknown>((acc, o) => deepMerge(acc, o), base);
  const tuning = TuningSchema.parse(merged);
  return { tuning, hash: hashState(tuning) };
}
