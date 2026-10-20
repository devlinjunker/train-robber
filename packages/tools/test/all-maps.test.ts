// Rules every playtest map in maps-src must keep, whatever its shape: it builds to the checked-in
// file, its trains have their routes, one side of the track is always open to ride beside, and the rider
// can reach the track from the spawn.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMapFile, stringifyMap } from '../src/maps/build';
import { corridorProblems, reachProblems, routeProblems } from '../src/maps/checks';
import { lapProblems, trainGapProblems } from '../src/maps/simChecks';
import { MAPS_OUT, MAPS_SRC, SCENERY_OUT } from '../src/maps/cli';

const ids = readdirSync(MAPS_SRC).filter((f) => f.endsWith('.tmj')).map((f) => f.replace(/\.tmj$/, '')).sort();

describe.each(ids)('map %s', (id) => {
  const { map, scenery, minRadiusTiles } = buildMapFile(join(MAPS_SRC, `${id}.tmj`));
  it('matches the checked-in build', () => {
    expect(stringifyMap(map)).toBe(readFileSync(join(MAPS_OUT, `${id}.json`), 'utf8'));
    const sceneryFile = join(SCENERY_OUT, `${id}.json`);
    expect(existsSync(sceneryFile) ? readFileSync(sceneryFile, 'utf8') : null).toBe(scenery && stringifyMap(scenery));
  });

  it('has closed routes for its trains, with no curve tighter than the cars allow', () => {
    expect(routeProblems(map, minRadiusTiles)).toEqual([]);
  });

  it('keeps rock and water off the cars and leaves one side of every track open to ride beside', () => {
    expect(corridorProblems(map, scenery)).toEqual([]);
  });

  it('lets the rider reach the track from the spawn', () => {
    expect(reachProblems(map)).toEqual([]);
  });

  it('starts its trains and runs the sim for a full lap of the longest route', () => {
    expect(lapProblems(map, id)).toEqual([]);
  });

  it('keeps every train clear of every other train', () => {
    expect(trainGapProblems(map, id)).toEqual([]);
  });
});
