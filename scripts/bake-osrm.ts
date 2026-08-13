/**
 * One-off bake of real road data into `src/data/`.
 *
 * Everything the map and the economics use — distances, drive times, the shape
 * of every corridor — comes from OSRM routing over OpenStreetMap, fetched here
 * once at build time and committed. The site itself makes no runtime routing
 * calls; it ships the answers.
 *
 *   npm run bake
 *
 * Data © OpenStreetMap contributors, ODbL. Routed with OSRM's public demo
 * server, which is rate-limited on purpose — this script paces itself and is
 * resumable, so re-runs only fetch what is missing.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { CITIES } from '../src/lib/geo';
import { SITES } from '../src/lib/sites';

const OSRM = 'https://router.project-osrm.org';
const OUT = `${process.cwd()}/src/data/`;
const PACE_MS = 650;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 429) await sleep(4000 * (i + 1));
    } catch {
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`failed after ${tries}: ${url.slice(0, 120)}`);
}

// ── Polyline (precision 5) ─────────────────────────────────────────────────

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

function encode(pts: [number, number][]): string {
  let out = '';
  let lastLat = 0;
  let lastLon = 0;
  const chunk = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of pts) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    out += chunk(la - lastLat) + chunk(lo - lastLon);
    lastLat = la;
    lastLon = lo;
  }
  return out;
}

/** Douglas–Peucker. Tolerance in degrees; 0.0012° ≈ 130m. */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];

  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let best = tol;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d: number;
      if (len2 === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

// ── Bake ───────────────────────────────────────────────────────────────────

async function bakeMatrix(
  name: string,
  points: { id: string; lon: number; lat: number }[],
) {
  const coords = points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const j = await get(`${OSRM}/table/v1/driving/${coords}?annotations=distance,duration`);
  if (j.code !== 'Ok') throw new Error(`table failed: ${j.code}`);

  const n = points.length;
  const km: number[][] = [];
  const hours: number[][] = [];
  let nulls = 0;
  for (let i = 0; i < n; i++) {
    km.push([]);
    hours.push([]);
    for (let k = 0; k < n; k++) {
      const d = j.distances[i][k];
      const t = j.durations[i][k];
      if (d === null || t === null) nulls++;
      km[i].push(Math.round((d ?? 0) / 100) / 10);
      hours[i].push(Math.round((t ?? 0) / 36) / 100);
    }
  }
  if (nulls) console.warn(`  ${nulls} unroutable cells in ${name}`);

  writeFileSync(
    `${OUT}${name}.json`,
    JSON.stringify({ ids: points.map((p) => p.id), km, hours }),
  );
  console.log(`  ${name}: ${n}×${n} matrix`);
}

type Pt = { id: string; lon: number; lat: number };

async function bakeRoutes(name: string, points: Pt[]) {
  const path = `${OUT}${name}.json`;
  const have: Record<string, string> = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8')).paths
    : {};

  const pairs: [Pt, Pt][] = [];
  for (let i = 0; i < points.length; i++) {
    for (let k = i + 1; k < points.length; k++) pairs.push([points[i], points[k]]);
  }

  const todo = pairs.filter(([a, b]) => !have[`${a.id}>${b.id}`]);
  console.log(`  ${name}: ${pairs.length} pairs, ${todo.length} to fetch`);

  let done = 0;
  for (const [a, b] of todo) {
    const url =
      `${OSRM}/route/v1/driving/` +
      `${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}` +
      `?overview=full&geometries=polyline`;
    const j = await get(url);
    if (j.code === 'Ok' && j.routes?.[0]) {
      have[`${a.id}>${b.id}`] = encode(simplify(decode(j.routes[0].geometry), 0.0012));
    }
    if (++done % 25 === 0) {
      console.log(`    ${done}/${todo.length}`);
      writeFileSync(path, JSON.stringify({ paths: have }));
    }
    await sleep(PACE_MS);
  }

  writeFileSync(path, JSON.stringify({ paths: have }));
  const bytes = JSON.stringify({ paths: have }).length;
  console.log(`  ${name}: ${Object.keys(have).length} paths, ${(bytes / 1024).toFixed(0)}kB`);
}

mkdirSync(OUT, { recursive: true });
console.log('baking real road data from OSRM / OpenStreetMap…');
await bakeMatrix('sites', SITES.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat })));
await bakeMatrix('cities', CITIES.map((c) => ({ id: c.id, lon: c.lon, lat: c.lat })));
// City corridors first: 435 pairs, and the map falls back to them for any
// dock pair the site bake hasn't reached yet. Then the dock-level network —
// 2,775 pairs, the bulk of the run, and the reason a re-bake takes half an
// hour. Both are resumable; an interrupted run picks up where it stopped.
await bakeRoutes('routes', CITIES.map((c) => ({ id: c.id, lon: c.lon, lat: c.lat })));
await bakeRoutes('site-routes', SITES.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat })));
console.log('done.');