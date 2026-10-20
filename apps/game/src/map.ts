// Picks the map for a session from the URL (?map=alpha-flats) and validates it.
// Maps are the built files in packages/content/base/maps; only the chosen one is fetched.
// ?map=gen generates one from the run seed instead (packages/mapgen), with the generator's
// settings from base/map-gen.json and any ?set=mapGen.<path>=<value> overrides.
import { MapDefSchema, SceneryDefSchema, resolveMapGen, type MapDef, type ResolvedConfig, type SceneryDef } from '@train-robber/config';
import { generateMap, GENERATED_MAP_ID } from '@train-robber/mapgen';
import mapGenDefaults from '@train-robber/content/base/map-gen.json';

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

export { GENERATED_MAP_ID };

/** A generated map and its scenery from the run seed and the config's `mapGen` overrides. Same inputs, same map. */
export function generatedMap(seed: string, config: Pick<ResolvedConfig, 'values'>): { map: MapDef; scenery: SceneryDef } {
  const { map, scenery } = generateMap(seed, resolveMapGen(mapGenDefaults, config.values.mapGen));
  return { map, scenery };
}

/** The session's map and scenery: generated for `gen`, else the built file by id. */
export async function sessionMap(id: string, seed: string, config: Pick<ResolvedConfig, 'values'>, search = location.search): Promise<{ map: MapDef; scenery: SceneryDef | null }> {
  if (id === GENERATED_MAP_ID) {
    const { map, scenery } = generatedMap(seed, config);
    return { map, scenery: new URLSearchParams(search).get('scenery') === 'off' ? null : scenery };
  }
  const map = await loadMap(id);
  return { map, scenery: await loadScenery(map, sceneryById, search) };
}
