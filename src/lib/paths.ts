/**
 * Baked road geometry. Every corridor on the map is a real OSRM route over
 * OpenStreetMap, fetched once by `npm run bake` and stored as an encoded
 * polyline. Nothing here talks to the network at runtime.
 */

import ROUTES from '../data/routes.json';
import SITE_ROUTES from '../data/site-routes.json';
import { site } from './sites';

const PATHS: Record<string, string> = ROUTES.paths;
const SITE_PATHS: Record<string, string> = SITE_ROUTES.paths;

/** Google's polyline algorithm, precision 5. */
function decode(str: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < str.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

const cache = new Map<string, [number, number][] | null>();

/** Look a pair up in a table, either way round, decoding at most once. */
function lookup(
  table: Record<string, string>,
  prefix: string,
  a: string,
  b: string,
): [number, number][] | null {
  const key = `${prefix}${a}>${b}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const forward = table[`${a}>${b}`];
  if (forward) {
    const pts = decode(forward);
    cache.set(key, pts);
    return pts;
  }
  const back = table[`${b}>${a}`];
  if (back) {
    const pts = decode(back).reverse();
    cache.set(key, pts);
    return pts;
  }
  cache.set(key, null);
  return null;
}

/**
 * The driving route between two cities as lon/lat pairs, in the direction
 * asked for. Routes are baked undirected and reversed on demand.
 */
export function corridor(a: string, b: string): [number, number][] | null {
  if (a === b) return null;
  return lookup(PATHS, 'c:', a, b);
}

/**
 * The driving route between two docks. This is the dense network — 2,775 dock
 * pairs against 435 city pairs — and it's what the map draws when it has it.
 *
 * Falls back to the city corridor between the two docks' cities, so a partial
 * or interrupted `npm run bake` degrades to the coarser network instead of
 * dropping the road off the map. Two docks in the same city have no fallback:
 * a city has no corridor to itself.
 */
export function siteCorridor(a: string, b: string): [number, number][] | null {
  if (a === b) return null;
  const exact = lookup(SITE_PATHS, 's:', a, b);
  if (exact) return exact;

  const ca = site(a)?.cityId;
  const cb = site(b)?.cityId;
  if (!ca || !cb || ca === cb) return null;
  return corridor(ca, cb);
}