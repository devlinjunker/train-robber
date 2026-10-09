// Picks the map for a session from the URL (?map=alpha-flats) and validates it.
// Maps are the built files in packages/content/base/maps; only the chosen one is fetched.
import { MapDefSchema, type MapDef } from '@train-robber/config';

export const DEFAULT_MAP = 'alpha-flats';

type Loader = () => Promise<unknown>;
const builtMaps = import.meta.glob('../../../packages/content/base/maps/*.json', { import: 'default' }) as Record<string, Loader>;
const byId = new Map(Object.entries(builtMaps).map(([path, load]) => [path.replace(/^.*\/|\.json$/g, ''), load]));

export class MapLoadError extends Error {
  constructor(id: string, detail: string) { super(`map ${id}: ${detail}`); this.name = 'MapLoadError'; }
}

export function mapIdFromUrl(search = location.search): string {
  return new URLSearchParams(search).get('map') || DEFAULT_MAP;
}

/** Load and validate one map by id. `maps` is injectable for tests. */
export async function loadMap(id: string, maps: ReadonlyMap<string, Loader> = byId): Promise<MapDef> {
  const load = maps.get(id);
  if (!load) throw new MapLoadError(id, `not found (have ${[...maps.keys()].sort().join(', ') || 'none'})`);
  const parsed = MapDefSchema.safeParse(await load());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new MapLoadError(id, `invalid at ${issue.path.join('.') || 'root'}: ${issue.message}`);
  }
  if (parsed.data.id !== id) throw new MapLoadError(id, `file holds map ${parsed.data.id}`);
  return parsed.data;
}
