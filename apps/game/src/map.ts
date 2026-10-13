// Picks the map for a session from the URL (?map=alpha-flats) and validates it.
// Maps are the built files in packages/content/base/maps; only the chosen one is fetched.
import { MapDefSchema, SceneryDefSchema, type MapDef, type SceneryDef } from '@train-robber/config';

export const DEFAULT_MAP = 'alpha-flats';

type Loader = () => Promise<unknown>;
const builtMaps = import.meta.glob('../../../packages/content/base/maps/*.json', { import: 'default' }) as Record<string, Loader>;
const byId = new Map(Object.entries(builtMaps).map(([path, load]) => [path.replace(/^.*\/|\.json$/g, ''), load]));
const builtScenery = import.meta.glob('../../../packages/content/base/scenery/*.json', { import: 'default' }) as Record<string, Loader>;
const sceneryById = new Map(Object.entries(builtScenery).map(([path, load]) => [path.replace(/^.*\/|\.json$/g, ''), load]));

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

/**
 * The render-only scenery for a map, or null when it has none or the URL turns it off. Scenery never affects play, so a
 * bad or stale file is reported in the console and the map is drawn without it.
 */
export async function loadScenery(map: MapDef, files: ReadonlyMap<string, Loader> = sceneryById, search = location.search): Promise<SceneryDef | null> {
  // ?scenery=off draws the bare map, to compare frame rates or see the zones under the trees.
  if (new URLSearchParams(search).get('scenery') === 'off') return null;
  const load = files.get(map.id);
  if (!load) return null;
  const parsed = SceneryDefSchema.safeParse(await load());
  if (!parsed.success) { console.warn(`scenery ${map.id}: invalid at ${parsed.error.issues[0]!.path.join('.')}; drawing the map without it`); return null; }
  if (parsed.data.source.hash !== map.source.hash) { console.warn(`scenery ${map.id}: built from a different source than the map; run npm run maps`); return null; }
  return parsed.data;
}
