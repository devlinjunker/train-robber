// The Playtests page's filters in its URL, so a filtered page can be reloaded, bookmarked or shared.
// Each filter has a readable parameter: ?version=0.2.5&tester=Dev&outcome=extracted&map=alpha-flats
// &experiment=fall-cost&runPr=61&practice=saved&save=ab12cd&v=trainMix:all-mail (variant groups use
// `v=group:id`, as the game's own URL does). `pr` and `exp` are not filters: `pr` links the page to a
// PR and `exp` focuses one experiment, so the PR and experiment filters use other names.

/** Filter key on the page → its URL parameter. Variant groups (`v:<group>`) go in `v=<group>:<id>`. */
const PARAMS: Record<string, string> = {
  version: 'version', tester: 'tester', outcome: 'outcome', experiment: 'experiment', mapId: 'map',
  pr: 'runPr', practice: 'practice', saveId: 'save',
};

/** The filters a URL asks for, as page filter keys and values. */
export function filtersFromQuery(search: string): Map<string, string> {
  const q = new URLSearchParams(search);
  const out = new Map<string, string>();
  for (const [key, param] of Object.entries(PARAMS)) {
    const v = q.get(param);
    if (v) out.set(key, v);
  }
  for (const v of q.getAll('v')) {
    const i = v.indexOf(':');
    if (i > 0 && i < v.length - 1) out.set(`v:${v.slice(0, i)}`, v.slice(i + 1));
  }
  return out;
}

/**
 * `search` with its filter parameters replaced by the set filters (empty ones dropped), other
 * parameters (`pr`, `exp`, …) kept. The experiment filter is left out while it only repeats `focus`.
 */
export function filtersToQuery(search: string, filters: ReadonlyMap<string, string>, focus?: string): string {
  const q = new URLSearchParams(search);
  for (const param of Object.values(PARAMS)) q.delete(param);
  q.delete('v');
  for (const [key, param] of Object.entries(PARAMS)) {
    const v = filters.get(key);
    if (v && !(key === 'experiment' && v === focus)) q.set(param, v);
  }
  for (const [key, v] of [...filters].filter(([k]) => k.startsWith('v:')).sort(([a], [b]) => a.localeCompare(b))) {
    if (v) q.append('v', `${key.slice(2)}:${v}`);
  }
  const s = readable(q);
  return s ? `?${s}` : '';
}

/** `query` (as filtersToQuery returns it) with `view=<view>` set, so the run table's view comes back too. */
export function viewToQuery(query: string, view: string): string {
  const q = new URLSearchParams(query);
  q.set('view', view);
  return `?${readable(q)}`;
}

/** Query text with `:` left as it is (`v=trainMix:all-mail`), which is fine in a query and easier to read. */
const readable = (q: URLSearchParams) => q.toString().replace(/%3A/gi, ':');
