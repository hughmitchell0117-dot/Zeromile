import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type IControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

/**
 * MapLibre parses every tile in a worker, and it finds that worker with
 * `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Neither of Vite's
 * two paths handles that: dep pre-bundling rewrites the URL into `.vite/deps`
 * without copying the file (404), and serving the package unbundled makes Vite
 * inject `/@vite/client` into the worker, which touches `document` and throws
 * inside a worker. Either way no tile ever parses and the map is blank.
 *
 * `?worker&url` hands the file to Vite's own worker pipeline, which bundles it
 * correctly in both dev and build, and `setWorkerUrl` points MapLibre at it.
 */
setWorkerUrl(workerUrl);
import { SITES, site } from '../lib/sites';
import { siteCorridor } from '../lib/paths';
import { driverStart, type Load, type Tour } from '../lib/model';
import type { Reach } from '../lib/reach';
import { readTheme } from '../lib/theme';

/**
 * OpenFreeMap's dark basemap: OpenStreetMap vector tiles, no API key, no usage
 * ceiling. The roads, the coastline and the place names are all real — this
 * component only draws freight on top of them.
 */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const STYLE_URL_LIGHT = 'https://tiles.openfreemap.org/styles/positron';

const KOREA_CENTER: [number, number] = [127.75, 36.3];
/** Loose enough that a tilted camera can still see horizon without fighting the clamp. */
const KOREA_BOUNDS: [number, number, number, number] = [121.5, 30.5, 135.0, 42.0];

/** The plane is tilted by default; the 기울기 button toggles back to this. */
const DEFAULT_PITCH = 46;

type FeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry:
      | { type: 'LineString'; coordinates: [number, number][] }
      | { type: 'Point'; coordinates: [number, number] };
  }[];
};

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Collapse a plan onto the corridor network: how many trucks run each
 * dock-to-dock stretch, loaded and empty. One feature per corridor, weighted —
 * not one line per truck.
 */
function buildFlows(tours: Tour[]): FeatureCollection {
  const acc = new Map<string, { loaded: number; empty: number }>();

  const add = (a: string, b: string, loaded: boolean) => {
    if (!a || !b || a === b) return;
    // Undirected: both directions share one piece of road.
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const hit = acc.get(key) ?? { loaded: 0, empty: 0 };
    if (loaded) hit.loaded += 1;
    else hit.empty += 1;
    acc.set(key, hit);
  };

  for (const t of tours) {
    if (t.legs.length === 0) continue;
    let at = driverStart(t.driver);
    for (const leg of t.legs) {
      add(at, leg.load.fromSite, false);
      add(leg.load.fromSite, leg.load.toSite, true);
      at = leg.load.toSite;
    }
    add(at, t.driver.depot, false);
  }

  let maxLoaded = 1;
  let maxEmpty = 1;
  for (const v of acc.values()) {
    if (v.loaded > maxLoaded) maxLoaded = v.loaded;
    if (v.empty > maxEmpty) maxEmpty = v.empty;
  }

  const features: FeatureCollection['features'] = [];
  for (const [key, v] of acc) {
    const [a, b] = key.split('|');
    const line = siteCorridor(a, b);
    if (!line) continue;
    // sqrt so one truck stays visible next to a sixty-truck trunk lane.
    if (v.empty > 0) {
      features.push({
        type: 'Feature',
        properties: { v: Math.sqrt(v.empty / maxEmpty), n: v.empty, loaded: 0 },
        geometry: { type: 'LineString', coordinates: line },
      });
    }
    if (v.loaded > 0) {
      features.push({
        type: 'Feature',
        properties: { v: Math.sqrt(v.loaded / maxLoaded), n: v.loaded, loaded: 1 },
        geometry: { type: 'LineString', coordinates: line },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The reach envelope as geometry — as a *road network*, not as a pile of
 * routes.
 *
 * 2,775 corridors share the same few expressways, so drawing them as 2,775
 * polylines paints some stretches of the Gyeongbu 357 times over. Stacked
 * alpha drives those to full saturation while a rural spur stays at one pass,
 * and because each corridor's OSRM geometry simplifies slightly differently
 * they fan out into a thick soft ribbon instead of a line. The result reads as
 * fat white pipes laid over the map, which is what it was.
 *
 * So the corridors are collapsed onto their shared segments first: 333k drawn
 * segments become 18.6k unique ones, snapped to a ~5m grid so adjacent pieces
 * share endpoints exactly. Each segment keeps the *earliest* arrival of any
 * corridor that uses it — the first moment the front touches this piece of
 * road — which is exactly the right semantics for a flood, and incidentally
 * ~9x less geometry than before.
 *
 * Arrival is per *segment*, not per corridor. Bucketing a whole corridor by its
 * cost made the front jump a road at a time: 200km of the Gyeongbu switching on
 * as one object. A segment's band is when the truck would be standing on that
 * stretch — deadhead out, plus how far into the corridor it is — so the front
 * creeps along the road instead of hopping between them.
 */
function buildReach(reach: Reach | null): FeatureCollection {
  if (!reach) return EMPTY_FC;

  // Every corridor the truck can still run, oriented from the end it enters —
  // and then every corridor it can't. Stopping at the duty boundary meant the
  // fill only ever traced the roads inside one day's driving; the rest of the
  // expressway network was never drawn at all, so the sweep read as a handful
  // of trunk lines rather than as the country's road system.
  const runs: { line: [number, number][]; out: number; leg: number }[] = [];
  let span = 0;
  let spanBeyond = 0;

  const collect = (edges: Reach['inside'], beyond: boolean) => {
    for (const edge of edges) {
      const line = siteCorridor(edge.entry, edge.entry === edge.a ? edge.b : edge.a);
      if (!line || line.length < 2) continue;
      runs.push({ line, out: edge.out, leg: edge.leg });
      const reachAt = edge.out + edge.leg;
      if (beyond) spanBeyond = Math.max(spanBeyond, reachAt);
      else span = Math.max(span, reachAt);
    }
  };
  collect(reach.inside, false);
  collect(reach.outside, true);

  // One axis over both halves. The beyond-the-day corridors are drawn on the
  // same clock rather than on their own stretch of the sweep, because they turn
  // out to add almost no geometry of their own: they run the same expressways,
  // and a shared segment keeps the earliest arrival of any corridor using it.
  span = Math.max(span, spanBeyond);
  if (span <= 0) return EMPTY_FC;

  const q = (v: number) => Math.round(v * GRID);
  const band = new Map<string, number>();

  for (const { line, out, leg } of runs) {
    // Distance along the corridor. Equirectangular and unscaled — it only has
    // to be *proportional*, and no single corridor spans enough latitude to
    // care. Two passes: total first, then each vertex as a fraction of it.
    const at: number[] = [0];
    let total = 0;
    for (let i = 1; i < line.length; i++) {
      const dx = (line[i][0] - line[i - 1][0]) * Math.cos((line[i][1] * Math.PI) / 180);
      total += Math.hypot(dx, line[i][1] - line[i - 1][1]);
      at.push(total);
    }
    const norm = total > 0 ? 1 / total : 0;

    for (let i = 1; i < line.length; i++) {
      const ax = q(line[i - 1][0]);
      const ay = q(line[i - 1][1]);
      const bx = q(line[i][0]);
      const by = q(line[i][1]);
      if (ax === bx && ay === by) continue;

      // When the truck would be standing on this stretch of road: the deadhead
      // out, plus however far into the corridor it is. This is what makes the
      // flood continuous along a highway instead of switching all 200km of it
      // on at once.
      const t = (out + leg * at[i] * norm) / span;
      const value = Math.min(BANDS - 1, Math.max(0, Math.floor(t * BANDS)));

      // Undirected: one stretch of road, whichever way it was driven, and it
      // keeps the earliest arrival of any corridor that uses it.
      const key = ax < bx || (ax === bx && ay < by)
        ? `${ax} ${ay} ${bx} ${by}`
        : `${bx} ${by} ${ax} ${ay}`;
      const seen = band.get(key);
      if (seen === undefined || value < seen) band.set(key, value);
    }
  }

  /*
   * Stretch the used range back over the whole sweep.
   *
   * Arrival is bucketed against the *slowest corridor*, but a corridor's far
   * end is always shared with something nearer, and dedupe keeps the earliest
   * arrival — so the top third of the range comes out empty. Measured from
   * Icheon on a 12-hour day: every one of 18,591 segments landed in bands 0-39
   * of 64. The front then spent the last third of the sweep travelling across
   * road that was already lit, which is exactly the stretch where the fill
   * looked like it had run out of country.
   *
   * The remap is monotonic, so arrival order — the thing that carries the
   * meaning — is untouched. It only stops the animation from budgeting time for
   * bands that will never hold a road.
   */
  let top = 0;
  for (const value of band.values()) if (value > top) top = value;
  const stretch = top > 0 ? (BANDS - 1) / top : 1;

  const features: FeatureCollection['features'] = [];
  for (const [key, value] of band) {
    const [ax, ay, bx, by] = key.split(' ');
    features.push({
      type: 'Feature',
      properties: { band: Math.round(value * stretch) },
      geometry: {
        type: 'LineString',
        coordinates: [
          [Number(ax) / GRID, Number(ay) / GRID],
          [Number(bx) / GRID, Number(by) / GRID],
        ],
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/** The selected tours, leg by leg, each with its own colour. */
function buildHighlights(
  tours: Tour[],
  colors: Record<number, string>,
  activeId: number | null,
): FeatureCollection {
  const features: FeatureCollection['features'] = [];

  const push = (fromSite: string, toSite: string, loaded: boolean, driverId: number) => {
    const A = site(fromSite);
    const B = site(toSite);
    if (!A || !B) return;
    // With the dock-level bake this is the real road between the two docks;
    // without it, `siteCorridor` hands back the coarser city corridor and the
    // dock coordinates stitch the last mile on either end. Bracketing the road
    // with both docks is right either way — on an exact route they're just its
    // own endpoints, restated.
    const road = siteCorridor(fromSite, toSite);
    const line: [number, number][] = road
      ? [[A.lon, A.lat], ...road, [B.lon, B.lat]]
      : [[A.lon, A.lat], [B.lon, B.lat]];
    features.push({
      type: 'Feature',
      properties: {
        color: colors[driverId] ?? '#FEE500',
        loaded: loaded ? 1 : 0,
        active: activeId === null || activeId === driverId ? 1 : 0,
      },
      geometry: { type: 'LineString', coordinates: line },
    });
  };

  for (const t of tours) {
    let at = driverStart(t.driver);
    for (const leg of t.legs) {
      push(at, leg.load.fromSite, false, t.driver.id);
      push(leg.load.fromSite, leg.load.toSite, true, t.driver.id);
      at = leg.load.toSite;
    }
    push(at, t.driver.depot, false, t.driver.id);
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Every stop the truck actually makes, in order: the yard it leaves, both ends
 * of each load, and the yard it comes back to.
 *
 * Marking only the drops was what made the tour look like it teleported — two
 * numbered pins with road between them and no explanation of the dock the truck
 * visited in the middle to pick the next load up. The chain is
 * 상차 → 하차 → 상차 → 하차, and it closes on the garage.
 */
function buildTourStops(tours: Tour[], selectedLoadId: number | null): FeatureCollection {
  const features: FeatureCollection['features'] = [];

  const push = (
    siteId: string,
    kind: 'depot' | 'pickup' | 'drop',
    label: string,
    loadId?: number,
  ) => {
    const point = site(siteId);
    if (!point) return;
    features.push({
      type: 'Feature',
      properties: {
        ...(loadId === undefined ? {} : { loadId }),
        kind,
        label,
        parking: kind === 'drop' ? '화물차 주차·하역 지점' : '화물차 주차·상차 지점',
        selected: loadId !== undefined && loadId === selectedLoadId ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    });
  };

  for (const tour of tours) {
    const start = driverStart(tour.driver);
    const depot = tour.driver.depot;
    push(
      start,
      'depot',
      start === depot
        ? `출발 · 복귀 · ${site(depot)?.ko ?? ''}`
        : `출발 · ${site(start)?.ko ?? ''}`,
    );
    tour.legs.forEach((leg, index) => {
      const from = site(leg.load.fromSite);
      const to = site(leg.load.toSite);
      if (from) push(leg.load.fromSite, 'pickup', `${index + 1} 상차 · ${from.ko} · ${leg.load.fromBay}`, leg.load.id);
      if (to) push(leg.load.toSite, 'drop', `${index + 1} 하차 · ${to.ko} · ${leg.load.toBay}`, leg.load.id);
    });
    if (tour.legs.length > 0 && start !== depot) {
      push(depot, 'depot', `복귀 · ${site(depot)?.ko ?? ''}`);
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Every dock, as a point layer. Labels collide-resolve in MapLibre. */
const SITE_POINTS = {
  type: 'FeatureCollection' as const,
  features: SITES.map((s) => ({
    type: 'Feature' as const,
    properties: { ko: s.ko, kind: s.kind, port: s.kind === '항만' ? 1 : 0, w: s.weight },
    geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
  })),
};

/**
 * The map is repainted from scratch either way — the basemap style only
 * supplies geometry and label placement, every colour on screen is ours. So
 * light mode is a second palette, not a second stylesheet: `LIGHT` is latched
 * once per map instance (the component is keyed on the theme, so a flip
 * remounts it) and every paint value below reads through `pick`.
 */
let LIGHT = false;
const pick = <T,>(dark: T, light: T): T => (LIGHT ? light : dark);

/**
 * Freight reads in neutrals: on dark, loaded is near-white over black; on
 * light it inverts to near-black over paper. Empty running stays the same
 * mid-gray in both, because it has to sit *between* the two.
 */
let LOADED = '#e8edf4';
let EMPTY = '#79828f';
let PULSE = '#ffffff';
/** Reachable-and-still-home-on-time. Cool, so it never reads as freight. */
let REACH = '#48d9c9';

function applyPalette(light: boolean) {
  LIGHT = light;
  LOADED = light ? '#252c36' : '#e8edf4';
  EMPTY = light ? '#8e97a3' : '#79828f';
  PULSE = light ? '#0d1117' : '#ffffff';
  REACH = light ? '#0f9c8c' : '#48d9c9';
}

export type MapPhase = 'idle' | 'running' | 'done';

/**
 * Which half of the map is speaking, by phase. `flow` only exists on the
 * ambient hero plane — the demo map doesn't draw the aggregate flows at all,
 * so there its story is the envelope, the basemap, and the selected routes.
 */
type Mix = { flow: number; reach: number; road: number };

const EMPHASIS: Record<MapPhase, Mix> = {
  idle: { flow: 0.3, reach: 1, road: 1 },
  // The envelope leads while the solver runs, but stays clearly teal: pushed
  // much past this, thousands of overlapping full-opacity strokes bleach to
  // white on screen and read as glare instead of reach.
  running: { flow: 0, reach: 0.8, road: 0.12 },
  done: { flow: 1, reach: 0.42, road: 1 },
};

/** The hero plane has no solver and no phase — it just sits at its own mix. */
const AMBIENT_MIX: Mix = { flow: 1, reach: 0.5, road: 1 };

/**
 * The basemap's own road network, with the opacity each layer rests at.
 *
 * These are OpenFreeMap layers, repainted light-on-black by `BASEMAP_TWEAKS`
 * back when the freight network was 435 city corridors and the map needed the
 * basemap to supply a sense of "there are roads here". The envelope now draws
 * 2,775 corridors of its own, so during the solve these are dead weight laid
 * over the top of it — hence dimming them with everything else.
 */
const BASEMAP_ROADS = [
  'highway_motorway_casing', 'highway_motorway_inner', 'highway_motorway_subtle',
  'highway_major_casing', 'highway_major_inner', 'highway_major_subtle',
  'highway_minor', 'highway_path',
  'railway', 'railway_minor', 'railway_transit',
];

/** Half a second, so the handover reads as a handover and not as a glitch. */
const FADE_MS = 500;
/** 20fps. The solver wants the rest of the frame budget. */
const TICK_MS = 50;

/**
 * Where the flood front stands, in band units, and the whole envelope's
 * strength. `null` means no sweep — and no envelope, because the envelope only
 * exists while it is being flooded.
 */
type Flood = { front: number; gain: number };

/**
 * The flood runs on its own clock, not the solver's. Annealing progress
 * arrives in uneven rAF-sized lurches — a front tied to it sprints, stutters,
 * and gets cut off mid-sweep when the solve lands. So `running` starts a fixed
 * sweep of this length, and the sweep is allowed to finish into the `done`
 * phase.
 *
 * Held just past the console's TARGET_SOLVE_MS (5.4s), so the fill runs the
 * length of the optimisation and lands a beat after it rather than clearing off
 * while the annealer is still working.
 */
const FLOOD_S = 5.9;


/**
 * The front is a ramp, not an edge.
 *
 * Bands used to be *stamped* as the front crossed them and then faded in over a
 * fixed 0.45s. That reads as stepping: the front's speed varies across the
 * sweep, so early on a dozen bands are mid-fade at once and it looks smooth,
 * while late on each band finishes fading before the next is even touched and
 * the map lights up one shell at a time.
 *
 * So nothing is stamped. A band's brightness is a smooth function of its
 * distance from a continuously moving front, which makes the fade width a
 * property of the *front* rather than of wall time — it stays the same shape at
 * every speed, which is what "consistent" means here.
 */
const FRONT_SPREAD = 8;
/** The soft teal pulse riding the front — brightness and width, no bloom. */
const CREST_LEAD = 3;
const CREST_SPREAD = 4;
/** How much the crest lifts the stroke, as a multiplier at its peak. */
const CREST_WIDTH = 0.3;

/**
 * How long the flood takes to clear off once it has swept the country.
 *
 * There is deliberately nothing underneath it. No dark road network, no faded
 * envelope waiting to be brightened — ahead of the front the map is bare, and
 * the only teal anywhere is teal the fill has laid down. So when the sweep is
 * over it has to leave, or it becomes exactly the resting wash it replaced.
 */
const TAIL_MS = 750;

/** The envelope's own strength while it floods, independent of the phase mix. */
const FLOOD_REACH = 0.8;

/**
 * The envelope is drawn as a stack of bands rather than one data-driven layer,
 * and this is a performance constraint, not a style choice.
 *
 * The front has to move ~20 times a second. Animating it through a *data-driven*
 * paint expression means MapLibre rebuilds the per-vertex paint arrays for all
 * 2,775 corridors — a few hundred thousand vertices — on the main thread every
 * tick, which starves the rAF the annealer runs on and freezes the whole map.
 * Constant paint values are plain uniforms and cost nothing to change.
 *
 * So each corridor is bucketed once, at build time, by when the front reaches
 * it, and the animation is BANDS constant opacity writes per tick. Nothing
 * per-feature is ever re-evaluated.
 *
 * This costs nothing in fidelity: a corridor's slack is exactly `1 - reveal`,
 * so bucketing by arrival time buckets by brightness at the same stroke.
 */
const BANDS = 64;

/** ~5m on the ground. Beyond this, OSRM returns identical shared geometry. */
const GRID = 1e4;

/**
 * Zoom ranges over which the whole envelope fades out. It's country-scale
 * information drawn from simplified geometry; at street zoom it stops tracing
 * the real roads, so it leaves the stage instead of lingering wrong. At rest
 * it bows out early — zoomed onto a city it's already served its purpose —
 * but while the flood is sweeping it stays around longer so the animation
 * isn't cut off for a zoomed-in viewer.
 */
const ENVELOPE_FADE: [number, number] = [9, 10.5];
const FLOOD_FADE: [number, number] = [11, 12.5];

const bandLit = (k: number) => `reach-lit-${k}`;
const bandWidth = (w5: number, w11: number) =>
  ['interpolate', ['linear'], ['zoom'], 5, w5, 11, w11];

/**
 * Where a band sits relative to the front: `fill` runs 0 (nothing there yet) to
 * 1 (arrived), `crest` is the pulse riding the front. Both are smooth in the
 * front's position, so both are smooth in time whatever speed the front happens
 * to be moving at.
 */
function bandFront(k: number, flood: Flood | null) {
  if (!flood) return { fill: 0, crest: 0 };
  const d = flood.front - k;
  const t = Math.min(1, Math.max(0, d / FRONT_SPREAD));
  const g = (d - CREST_LEAD) / CREST_SPREAD;
  return {
    // Smoothstep: no corner where the ramp starts and none where it lands, so
    // the front has no visible leading or trailing edge.
    fill: t * t * (3 - 2 * t),
    crest: Math.exp(-g * g),
  };
}

/**
 * How a single band looks at a given point in the sweep. No flash, no bloom —
 * the flood is a reveal, not a light show; one crisp line per corridor,
 * brightness graded by slack.
 */
function bandState(k: number, fill: number, crest: number, reach: number, w: number) {
  const reveal = (k + 0.5) / BANDS;

  // Gamma > 1, pushing the tail *down*. Korea is small — on a full 12-hour day
  // about 94% of corridors are reachable — so the gradient, not the lit/unlit
  // split, is what carries the information.
  const slack = Math.pow(Math.max(0, 1 - reveal), 1.6);

  // These sit much higher than they used to. Every corridor is now drawn once
  // instead of an average of 21 times, so what used to arrive as stacked alpha
  // has to be asked for directly.
  // The floors matter more than the peaks. At 0.2 alpha and 0.6px the far half
  // of the network was technically drawn and effectively invisible — over paper
  // especially — which is why a full-country sweep read as a few trunk lines.
  const lift = 1 + CREST_WIDTH * crest;
  return {
    lit: Math.min(1, ((0.36 + slack * (0.92 - 0.36)) * fill + 0.28 * crest) * reach),
    w5: (0.9 + slack * (2.2 - 0.9)) * w * lift,
    w11: (2.0 + slack * (5.0 - 2.0)) * w * lift,
  };
}

/**
 * The mix is animated in JS rather than left to `line-opacity-transition`,
 * because MapLibre applies transitions only to constant paint values — the
 * data-driven ones (the flow layers, keyed on `v`) would snap while the rest
 * faded. One timer, one easing, no split.
 */
function applyEmphasis(map: MapLibreMap, ambient: boolean, mix: Mix, flood: Flood | null) {
  const dim = ambient ? 0.55 : 1;
  const { flow, road } = mix;

  const set = (id: string, prop: 'line-opacity' | 'line-width', value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value as never);
  };

  // Restore rather than overwrite once we're back at full strength: these
  // layers carry the stylesheet's own opacity ramps, and pinning them to a
  // number of ours would quietly change the resting map. `undefined` drops the
  // override and hands them back to the style.
  for (const id of BASEMAP_ROADS) {
    set(id, 'line-opacity', road > 0.99 ? undefined : road);
  }
  const ramp = (key: string, lo: number, hi: number) =>
    ['interpolate', ['linear'], ['get', key], 0, lo, 1, hi];

  set('flow-empty', 'line-opacity', ramp('v', 0.06 * dim * flow, 0.25 * dim * flow));
  set('flow-loaded', 'line-opacity', ramp('v', 0.08 * dim * flow, 0.5 * dim * flow));
  set('flow-pulse', 'line-opacity', (ambient ? 0.78 : 0.5) * dim * flow);

  // The envelope hands off to the basemap at street zoom. Its baked corridor
  // geometry is simplified for country-scale drawing — zoomed onto a single
  // dock it cuts corners and slides out from under the real roads, so past
  // the fade range it bows out entirely. Zoom-only interpolation on a
  // constant is still a uniform, so the animation stays as cheap as before.
  const [z0, z1] = flood ? FLOOD_FADE : ENVELOPE_FADE;
  const zfade = (v: number) => ['interpolate', ['linear'], ['zoom'], z0, v, z1, 0];

  const w = ambient ? 0.5 : 1;
  // Held at the flooding value rather than the mix's, because the solve lands
  // before the sweep does — riding `reach` would dim the fill mid-stride when
  // the phase flips to `done`.
  const env = flood ? FLOOD_REACH * flood.gain : 0;

  // Both properties are constants (zoom-only interpolation is still a uniform),
  // so this is BANDS × 2 uniform writes a tick and nothing per-feature.
  for (let k = 0; k < BANDS; k++) {
    const { fill, crest } = bandFront(k, flood);
    const s = bandState(k, fill, crest, env, w);
    set(bandLit(k), 'line-opacity', zfade(s.lit * dim));
    set(bandLit(k), 'line-width', bandWidth(s.w5, s.w11));
  }
}

/**
 * OpenFreeMap's dark style paints roads a few percent off the background, which
 * at peninsula zoom leaves the network nearly invisible. We repaint the
 * transportation layers as light gray on near-black and pull the major-road
 * layers down to z8 — the vector tiles carry primary/secondary that far out, the
 * stock style just doesn't draw them until z11.
 */
type BasemapTweak = { id: string; minzoom?: number; paint?: Record<string, unknown> };

const BASEMAP_TWEAKS: BasemapTweak[] = [
  { id: 'background', paint: { 'background-color': '#08090b' } },
  { id: 'water', paint: { 'fill-color': '#0d1015' } },
  { id: 'waterway', paint: { 'line-color': '#0d1015' } },
  { id: 'landuse_residential', paint: { 'fill-color': '#101215', 'fill-opacity': 0.55 } },
  { id: 'landuse_park', paint: { 'fill-color': '#0d0f12' } },
  { id: 'landcover_wood', paint: { 'fill-color': '#0d0f12' } },
  { id: 'building', paint: { 'fill-color': '#111419', 'fill-outline-color': '#171b21' } },
  // Casings are the outline, inners are the road surface: dark under light.
  // The roads stay *quiet* grays on purpose — they were painted near-white
  // back when the basemap had to carry the whole sense of "roads", and at
  // that brightness they sat above the envelope and the plan as a permanent
  // white lattice. They're context now, not content.
  {
    id: 'highway_motorway_casing',
    paint: { 'line-color': 'rgba(4,5,6,0.9)' },
  },
  {
    id: 'highway_motorway_inner',
    paint: {
      'line-color': [
        'interpolate', ['linear'], ['zoom'],
        5.8, 'rgba(74,83,94,0.5)',
        7, '#4a535e',
      ],
    },
  },
  {
    id: 'highway_motorway_subtle',
    paint: {
      'line-color': 'rgba(74,83,94,0.45)',
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 4, 0.6, 6, 1.4],
    },
  },
  {
    id: 'highway_major_casing',
    minzoom: 8,
    paint: { 'line-color': 'rgba(4,5,6,0.85)' },
  },
  {
    id: 'highway_major_inner',
    minzoom: 8,
    paint: { 'line-color': '#414a54' },
  },
  {
    id: 'highway_major_subtle',
    paint: {
      'line-color': 'rgba(66,74,84,0.45)',
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 8, 1.6],
    },
  },
  { id: 'highway_minor', minzoom: 7, paint: { 'line-color': '#454d58', 'line-opacity': 0.95 } },
  { id: 'highway_path', paint: { 'line-color': '#2b3138' } },
  { id: 'railway', paint: { 'line-color': '#3a4048' } },
  { id: 'railway_minor', paint: { 'line-color': '#33383f' } },
  { id: 'railway_transit', paint: { 'line-color': '#33383f' } },
  { id: 'boundary_state', paint: { 'line-color': 'rgba(150,160,175,0.28)' } },
  { id: 'boundary_country_z5-', paint: { 'line-color': 'rgba(160,170,185,0.35)' } },
  { id: 'boundary_country_z0-4', paint: { 'line-color': 'rgba(160,170,185,0.35)' } },
];

/**
 * The same list inverted: paper ground, cool water, roads as quiet grays that
 * stay *under* the freight ink rather than competing with it. Same layer ids
 * and the same zoom ranges — only the colours differ.
 */
const BASEMAP_TWEAKS_LIGHT: BasemapTweak[] = [
  { id: 'background', paint: { 'background-color': '#f4f2ec' } },
  { id: 'water', paint: { 'fill-color': '#dde5ec' } },
  { id: 'waterway', paint: { 'line-color': '#dde5ec' } },
  { id: 'landuse_residential', paint: { 'fill-color': '#ecebe4', 'fill-opacity': 0.6 } },
  { id: 'landuse_park', paint: { 'fill-color': '#e7e9df' } },
  { id: 'landcover_wood', paint: { 'fill-color': '#e7e9df' } },
  { id: 'building', paint: { 'fill-color': '#e4e2da', 'fill-outline-color': '#d8d6cd' } },
  { id: 'highway_motorway_casing', paint: { 'line-color': 'rgba(255,255,255,0.9)' } },
  {
    id: 'highway_motorway_inner',
    paint: {
      'line-color': [
        'interpolate', ['linear'], ['zoom'],
        5.8, 'rgba(156,166,178,0.55)',
        7, '#9ca6b2',
      ],
    },
  },
  {
    id: 'highway_motorway_subtle',
    paint: {
      'line-color': 'rgba(156,166,178,0.5)',
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 4, 0.6, 6, 1.4],
    },
  },
  { id: 'highway_major_casing', minzoom: 8, paint: { 'line-color': 'rgba(255,255,255,0.85)' } },
  { id: 'highway_major_inner', minzoom: 8, paint: { 'line-color': '#a8b1bc' } },
  {
    id: 'highway_major_subtle',
    paint: {
      'line-color': 'rgba(168,177,188,0.5)',
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 8, 1.6],
    },
  },
  { id: 'highway_minor', minzoom: 7, paint: { 'line-color': '#b4bcc6', 'line-opacity': 0.95 } },
  { id: 'highway_path', paint: { 'line-color': '#cdd3da' } },
  { id: 'railway', paint: { 'line-color': '#bcc3cb' } },
  { id: 'railway_minor', paint: { 'line-color': '#c6ccd3' } },
  { id: 'railway_transit', paint: { 'line-color': '#c6ccd3' } },
  { id: 'boundary_state', paint: { 'line-color': 'rgba(90,100,115,0.3)' } },
  { id: 'boundary_country_z5-', paint: { 'line-color': 'rgba(80,90,105,0.38)' } },
  { id: 'boundary_country_z0-4', paint: { 'line-color': 'rgba(80,90,105,0.38)' } },
];

function restyleBasemap(map: MapLibreMap) {
  for (const tweak of LIGHT ? BASEMAP_TWEAKS_LIGHT : BASEMAP_TWEAKS) {
    if (!map.getLayer(tweak.id)) continue;
    if (tweak.minzoom !== undefined) map.setLayerZoomRange(tweak.id, tweak.minzoom, 24);
    for (const [prop, value] of Object.entries(tweak.paint ?? {})) {
      map.setPaintProperty(tweak.id, prop as never, value as never);
    }
  }

  // The tilted plane needs somewhere to end: black space above the horizon with
  // a thin atmospheric seam where the ground meets it.
  map.setSky({
    'sky-color': pick('#04050a', '#cfdbe8'),
    'sky-horizon-blend': 0.55,
    'horizon-color': pick('#2a3550', '#e6ecf2'),
    'horizon-fog-blend': 0.7,
    'fog-color': pick('#080a11', '#eef0ea'),
    'fog-ground-blend': 0.72,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 10, 0.2],
  });
}

function addLayers(map: MapLibreMap, ambient: boolean, phase: MapPhase) {
  // Keep freight under the basemap's own place labels so names stay readable.
  const style = map.getStyle() as StyleSpecification;
  const firstSymbol = style.layers.find((l) => l.type === 'symbol')?.id;

  map.addSource('reach', { type: 'geojson', data: EMPTY_FC });
  // The aggregate flow network exists only on the ambient hero plane, as
  // texture behind the copy. On the demo map it was a near-white blanket over
  // the whole country that buried the envelope and the selected routes — the
  // map's actual content — so there it is simply not drawn.
  if (ambient) map.addSource('flows', { type: 'geojson', data: EMPTY_FC });
  map.addSource('highlight', { type: 'geojson', data: EMPTY_FC });
  map.addSource('load-stops', { type: 'geojson', data: EMPTY_FC });
  map.addSource('sites', { type: 'geojson', data: SITE_POINTS });

  const dim = ambient ? 0.55 : 1;
  // The hero plane is decoration behind the copy: same network, half the ink,
  // so the corridors read as texture instead of crowding the peninsula.
  const w = ambient ? 0.5 : 1;

  // Coastline. OpenMapTiles has no coast layer — the edge of the country is the
  // outline of the water polygons, so trace them off whatever source the
  // basemap's own `water` layer uses.
  const water = style.layers.find((l) => l.id === 'water') as
    | { source?: string; 'source-layer'?: string }
    | undefined;
  if (water?.source) {
    const from = {
      source: water.source,
      ...(water['source-layer'] ? { 'source-layer': water['source-layer'] } : {}),
    };
    // Ocean only: the water source also carries every river and lake, and
    // tracing those painted blue blobs inland — under the envelope and the
    // routes. The coast is the coast.
    const ocean = ['==', ['get', 'class'], 'ocean'];
    map.addLayer(
      {
        ...from,
        id: 'coast-glow',
        type: 'line',
        filter: ocean,
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': pick('#6f9fce', '#7ba3c8'),
          'line-blur': 6,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 9, 9],
          'line-opacity': ambient ? 0.4 : 0.26,
        },
      } as never,
      firstSymbol,
    );
    map.addLayer(
      {
        ...from,
        id: 'coast-edge',
        type: 'line',
        filter: ocean,
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': pick('#b7d3ea', '#5d7f9e'),
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 9, 1.5],
          'line-opacity': ambient ? 0.6 : 0.4,
        },
      } as never,
      firstSymbol,
    );
  }

  // ── Reach envelope ───────────────────────────────────────────────────────
  // Bottom of the freight stack, and only ever on screen while it is being
  // flooded. There is no unlit road network under it and no resting wash: the
  // teal on the map is exactly the teal the front has laid down, and when the
  // sweep is finished it clears. The plan draws on top.

  // One layer per arrival band. Every paint value here is a constant, set once
  // and then only ever overwritten with another constant by `applyEmphasis`.
  for (let k = 0; k < BANDS; k++) {
    const s = bandState(k, 0, 0, 0, w);

    map.addLayer(
      {
        id: bandLit(k),
        type: 'line',
        source: 'reach',
        filter: ['==', ['get', 'band'], k] as never,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': REACH,
          'line-width': bandWidth(s.w5, s.w11) as never,
          'line-opacity': 0,
        },
      },
      firstSymbol,
    );
  }

  // Hero-only, matching the source above.
  if (ambient) {
    // Empty running: warm, underneath, so waste reads as waste.
    map.addLayer(
      {
        id: 'flow-empty',
        type: 'line',
        source: 'flows',
        filter: ['==', ['get', 'loaded'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': EMPTY,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            5, ['interpolate', ['linear'], ['get', 'v'], 0, 0.3 * w, 1, 1.4 * w],
            11, ['interpolate', ['linear'], ['get', 'v'], 0, 0.8 * w, 1, 4 * w],
          ],
          'line-opacity': ['interpolate', ['linear'], ['get', 'v'], 0, 0.06 * dim, 1, 0.25 * dim],
        },
      },
      firstSymbol,
    );

    map.addLayer(
      {
        id: 'flow-loaded',
        type: 'line',
        source: 'flows',
        filter: ['==', ['get', 'loaded'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': LOADED,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            5, ['interpolate', ['linear'], ['get', 'v'], 0, 0.3 * w, 1, 1.8 * w],
            11, ['interpolate', ['linear'], ['get', 'v'], 0, 0.8 * w, 1, 5.5 * w],
          ],
          'line-opacity': ['interpolate', ['linear'], ['get', 'v'], 0, 0.08 * dim, 1, 0.5 * dim],
        },
      },
      firstSymbol,
    );

    // A slow dash crawling the busiest corridors — direction of travel, without
    // a swarm of dots.
    map.addLayer(
      {
        id: 'flow-pulse',
        type: 'line',
        source: 'flows',
        filter: ['all', ['==', ['get', 'loaded'], 1], ['>', ['get', 'v'], 0.55]],
        layout: { 'line-cap': 'butt' },
        paint: {
          'line-color': PULSE,
          'line-width': ambient ? 1 : 1.6,
          // Thinner lines can carry a brighter crawl without shouting.
          'line-opacity': (ambient ? 0.78 : 0.5) * dim,
          'line-dasharray': [0, 4, 3, 0],
        },
      },
      firstSymbol,
    );
  }

  // Settled: the sweep, if there is one, is owned by the animation effect and
  // starts on its own tick.
  applyEmphasis(map, ambient, ambient ? AMBIENT_MIX : EMPHASIS[phase], null);

  if (ambient) {
    // Docks as faint sparks — the network gets nodes, not just strands.
    map.addLayer(
      {
        id: 'site-spark',
        type: 'circle',
        source: 'sites',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1, 9, 2.8],
          'circle-color': ['case', ['==', ['get', 'port'], 1], pick('#9fc4e4', '#4a7ba6'), pick('#e8eef6', '#3a424e')],
          'circle-opacity': 0.4,
          'circle-blur': 0.7,
        },
      },
      firstSymbol,
    );
    return;
  }

  // Loaded and empty are still two layers, but both are solid road now. The
  // dashed hairline they used to be was wrong twice over: a deadhead is the
  // same truck on the same road, and at 1.6px it disappeared, so the tour read
  // as a numbered stop, a gap you apparently walked, and another stop — with
  // the drive home invisible, which is what made a closed loop look open.
  // Empty runs are the same colour, thinner and dimmer: unpaid, still driven.
  map.addLayer({
    id: 'highlight-halo',
    type: 'line',
    source: 'highlight',
    filter: ['==', ['get', 'loaded'], 1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 10,
      'line-blur': 5,
      'line-opacity': ['case', ['==', ['get', 'active'], 1], 0.3, 0.08],
    },
  });

  map.addLayer({
    id: 'highlight-empty',
    type: 'line',
    source: 'highlight',
    filter: ['==', ['get', 'loaded'], 0],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 9, 2.6],
      'line-opacity': ['case', ['==', ['get', 'active'], 0], 0.28, 0.62],
    },
  });

  map.addLayer({
    id: 'highlight-line',
    type: 'line',
    source: 'highlight',
    filter: ['==', ['get', 'loaded'], 1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 3,
      'line-opacity': ['case', ['==', ['get', 'active'], 0], 0.52, 1],
    },
  });

  map.addLayer({
    id: 'load-stop-halo',
    type: 'circle',
    source: 'load-stops',
    // Drops only. Every stop carrying a halo turned a tour into a string of
    // identical blobs, and the point of the halo is to say "this is where the
    // money lands".
    filter: ['==', ['get', 'kind'], 'drop'],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'selected'], 1], 13, 10],
      'circle-color': '#fee500',
      'circle-opacity': ['case', ['==', ['get', 'selected'], 1], 0.25, 0.12],
      'circle-blur': 0.55,
    },
  });

  map.addLayer({
    id: 'load-stop-dot',
    type: 'circle',
    source: 'load-stops',
    // Filled yellow is a drop, a yellow ring is a pickup, white is the yard.
    paint: {
      'circle-radius': [
        'case',
        ['==', ['get', 'selected'], 1], 6.5,
        ['==', ['get', 'kind'], 'drop'], 5,
        4,
      ],
      'circle-color': [
        'case',
        ['==', ['get', 'selected'], 1], pick('#ffffff', '#16150f'),
        ['==', ['get', 'kind'], 'drop'], '#fee500',
        ['==', ['get', 'kind'], 'depot'], pick('#ffffff', '#16150f'),
        pick('#0b0d10', '#fbfaf6'),
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': [
        'case',
        ['==', ['get', 'kind'], 'pickup'], pick('#fee500', '#c9a800'),
        pick('#3c1e1e', '#f7f5ec'),
      ],
    },
  });

  map.addLayer({
    id: 'load-stop-label',
    type: 'symbol',
    source: 'load-stops',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-optional': true,
    },
    paint: {
      'text-color': [
        'case',
        ['==', ['get', 'selected'], 1], pick('#fee500', '#8a7500'),
        pick('#f7f5ec', '#1a1913'),
      ],
      'text-halo-color': pick('rgba(7,8,10,0.96)', 'rgba(250,249,245,0.96)'),
      'text-halo-width': 2.2,
    },
  });

  // Docks. They fade in as you zoom past the point where they'd overlap.
  map.addLayer({
    id: 'site-dot',
    type: 'circle',
    source: 'sites',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 12, 5],
      'circle-color': ['case', ['==', ['get', 'port'], 1], pick('#9fb6d0', '#5a7896'), pick('#dfe5ec', '#454c56')],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.35, 8.5, 0.95],
      'circle-stroke-width': 1,
      'circle-stroke-color': pick('rgba(0,0,0,0.55)', 'rgba(255,255,255,0.7)'),
    },
  });

  map.addLayer({
    id: 'site-label',
    type: 'symbol',
    source: 'sites',
    minzoom: 8.5,
    layout: {
      'text-field': ['get', 'ko'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': pick('#c9d1da', '#3f4753'),
      'text-halo-color': pick('rgba(8,8,7,0.9)', 'rgba(250,249,245,0.9)'),
      'text-halo-width': 1.4,
    },
  });
}

/**
 * One button that flips the plane between flat and tilted. Drag-rotate and the
 * compass both work, but neither is discoverable — this is.
 */
class TiltControl implements IControl {
  private map?: MapLibreMap;
  private button?: HTMLButtonElement;
  private container?: HTMLDivElement;
  private readonly sync = () => {
    if (!this.button || !this.map) return;
    const tilted = this.map.getPitch() > 6;
    this.button.textContent = tilted ? '평면' : '기울기';
    this.button.setAttribute('aria-label', tilted ? '지도 평면 보기' : '지도 기울여 보기');
  };

  onAdd(map: MapLibreMap) {
    this.map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group map-tilt-ctrl';
    const button = document.createElement('button');
    button.type = 'button';
    button.addEventListener('click', () => {
      map.easeTo({ pitch: map.getPitch() > 6 ? 0 : DEFAULT_PITCH, duration: 500 });
    });
    container.appendChild(button);
    this.container = container;
    this.button = button;
    this.sync();
    map.on('pitchend', this.sync);
    return container;
  }

  onRemove() {
    this.map?.off('pitchend', this.sync);
    this.container?.remove();
    this.map = undefined;
  }
}

export type KoreaMapProps = {
  tours: Tour[];
  /** Bumped by the parent whenever `tours` mutates mid-anneal. */
  version?: number;
  /** The selected tours, drawn over the aggregate flow. */
  highlights?: Tour[];
  /** Stable route color keyed by driver id. */
  highlightColors?: Record<number, string>;
  /** Hovered route; other selected routes stay visible but dim. */
  activeHighlightId?: number | null;
  /** Load selected from a destination label. */
  selectedLoadId?: number | null;
  /** Called when a destination cargo label is clicked. */
  onSelectLoad?: (load: Load) => void;
  /**
   * What the truck can still reach and get home from. Drawn under everything
   * else; pass null to leave the envelope off.
   */
  reach?: Reach | null;
  /**
   * Drives the handover between envelope and plan. Entering `running` also
   * starts the flood sweep, which runs on its own fixed clock.
   */
  phase?: MapPhase;
  /** Hero variant: quieter, no interaction, no dock layer. */
  ambient?: boolean;
};

export default function KoreaMap({
  tours,
  version = 0,
  highlights = [],
  highlightColors = {},
  activeHighlightId = null,
  selectedLoadId = null,
  onSelectLoad,
  reach = null,
  phase = 'idle',
  ambient = false,
}: KoreaMapProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  const toursRef = useRef(tours);
  toursRef.current = tours;
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const onSelectLoadRef = useRef(onSelectLoad);
  onSelectLoadRef.current = onSelectLoad;
  // Read once at style load; after that the effect below owns it.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** Where the crossfade currently stands, so a phase flip eases from here. */
  const mixRef = useRef<Mix>(ambient ? AMBIENT_MIX : EMPHASIS[phase]);
  /** When the current flood sweep began (ms timestamp; 0 = no sweep). */
  const floodStartRef = useRef(0);

  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    const light = readTheme() === 'light';
    applyPalette(light);

    const map = new MapLibreMap({
      container: holder,
      style: light ? STYLE_URL_LIGHT : STYLE_URL,
      center: KOREA_CENTER,
      zoom: ambient ? 5.5 : 6.1,
      minZoom: 5,
      maxZoom: 15,
      maxBounds: KOREA_BOUNDS,
      interactive: !ambient,
      // Tilted out of the box, and the user can push it further: right-drag or
      // ctrl-drag rotates and pitches, the compass button snaps back.
      pitch: ambient ? 52 : DEFAULT_PITCH,
      bearing: ambient ? -8 : 0,
      maxPitch: 72,
      dragRotate: !ambient,
      pitchWithRotate: !ambient,
      // The console is a full-bleed panel in the middle of a long page, so a
      // bare wheel over it has to scroll the page — otherwise the only way past
      // the demo is to put the cursor in the narrow gutters beside it. Ctrl/⌘ +
      // wheel zooms instead, and MapLibre paints the hint when someone tries
      // the bare wheel.
      cooperativeGestures: !ambient,
      locale: {
        'CooperativeGesturesHandler.WindowsHelpText': 'Ctrl + 스크롤로 지도 확대·축소',
        'CooperativeGesturesHandler.MacHelpText': '⌘ + 스크롤로 지도 확대·축소',
        'CooperativeGesturesHandler.MobileHelpText': '두 손가락으로 지도 이동',
      },
      attributionControl: false,
      // The glyph packs are Latin-only; Hangul renders from a local font.
      localIdeographFontFamily: "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif",
    });

    if (!ambient) {
      map.addControl(
        new NavigationControl({ showCompass: true, visualizePitch: true }),
        'top-right',
      );
      map.addControl(new TiltControl(), 'top-right');
      map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
      map.addControl(
        new AttributionControl({
          compact: true,
          customAttribution: '경로 · OSRM',
        }),
        'bottom-right',
      );
    }
    if (ambient) map.touchZoomRotate?.disableRotation();

    // `style.load` — not `load`. The latter also waits on every tile in the
    // basemap, including a Natural Earth raster that can stay pending forever;
    // gating the freight layers on it meant they were never added at all.
    const init = () => {
      if (map.getLayer('reach-dark')) return;
      // Two maps can be alive at once (hero + console); re-latch so this one
      // paints in its own theme regardless of who initialised last.
      applyPalette(light);
      restyleBasemap(map);
      addLayers(map, ambient, phaseRef.current);
      // Dev-only handle so layer styling can be poked from the console.
      if (import.meta.env.DEV && !ambient) {
        (window as unknown as { __zmMap?: MapLibreMap }).__zmMap = map;
      }
      setReady(true);
    };
    if (map.isStyleLoaded()) init();
    else map.on('style.load', init);

    mapRef.current = map;
    return () => {
      setReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, [ambient]);

  // The plan changes constantly while the solver anneals; setData is the cheap
  // path — MapLibre re-tessellates on the worker, not on the main thread.
  // Hero-only, like the source: skip the buildFlows work when it isn't drawn.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('flows') as GeoJSONSource | undefined;
    if (src) src.setData(buildFlows(toursRef.current) as never);
  }, [ready, version]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const target = ambient ? AMBIENT_MIX : EMPHASIS[phase];
    const from = { ...mixRef.current };
    const t0 = performance.now();
    let timer: ReturnType<typeof setInterval> | undefined;

    const running = phase === 'running' && !ambient;
    if (running) {
      // A fresh solve starts a fresh sweep.
      floodStartRef.current = t0;
    } else if (phase === 'idle') {
      // Reset abandons any sweep still in flight; idle shows the settled
      // envelope, not a half-finished flood.
      floodStartRef.current = 0;
    }

    const tick = () => {
      const now = performance.now();

      const k = Math.min(1, (now - t0) / FADE_MS);
      const ease = k * (2 - k);
      mixRef.current = {
        flow: from.flow + (target.flow - from.flow) * ease,
        reach: from.reach + (target.reach - from.reach) * ease,
        road: from.road + (target.road - from.road) * ease,
      };

      let flood: Flood | null = null;
      const floodStart = floodStartRef.current;
      if (!ambient && floodStart > 0) {
        // Ease-out over the fixed sweep, because most corridors sit in the
        // top third of the cost range — a linear front would crawl across a
        // near-empty map and then light everything at once.
        const e = now - floodStart;
        const u = Math.min(1, e / (FLOOD_S * 1000));
        const wave = 1 - (1 - u) * (1 - u);
        // The front has to travel past the last band by its own ramp width plus
        // the crest's tail, or the sweep ends with the top of the range still
        // mid-fill and the last stretch snaps.
        const span = BANDS + FRONT_SPREAD + CREST_LEAD + 2.5 * CREST_SPREAD;
        // Swept edge to edge, then the whole thing clears — nothing is left
        // behind, so the map goes back to having no teal on it at all.
        const tail = Math.max(0, e - FLOOD_S * 1000) / TAIL_MS;
        flood = { front: wave * span, gain: Math.max(0, 1 - tail * tail) };

        if (tail >= 1) {
          // The sweep is a loop, not a one-shot. It used to be a single fixed
          // 4.5s pass on the theory that the anneal lands in two or three —
          // which is true for the standard preset and false for the big ones,
          // where the map went quiet with the solver still working. So while
          // the solver is running the front just starts again, and whichever
          // pass is in flight when the answer lands is the one that finishes.
          if (phaseRef.current === 'running') {
            floodStartRef.current = now;
            flood = { front: 0, gain: 0 };
          } else {
            flood = null;
            floodStartRef.current = 0;
          }
        }
      }

      applyEmphasis(map, ambient, mixRef.current, flood);

      // Once the fade has landed there is nothing left to animate unless a
      // solve or a still-finishing sweep is feeding us a moving front.
      if (k >= 1 && !running && floodStartRef.current === 0 && timer) clearInterval(timer);
    };

    timer = setInterval(tick, TICK_MS);
    tick();
    return () => clearInterval(timer);
  }, [ready, ambient, phase]);

  // The envelope only moves when the driver's three inputs move, so this is a
  // rare rebuild — unlike `flows`, which churns every frame of the anneal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('reach') as GeoJSONSource | undefined;
    const fc = buildReach(reach);
    src?.setData(fc as never);
    // Dev-only, same idea as `__zmMap`: the envelope is built once and then only
    // animated, so when it looks wrong there is otherwise nothing to inspect.
    if (import.meta.env.DEV && !ambient) {
      const used = new Set<number>();
      for (const f of fc.features) used.add((f.properties as { band: number }).band);
      (window as unknown as { __zmReach?: unknown }).__zmReach = {
        input: reach?.input ?? null,
        inside: reach?.inside.length ?? 0,
        outside: reach?.outside.length ?? 0,
        segments: fc.features.length,
        // How much of the sweep actually holds road. Anything well under BANDS
        // means the front is spending time on empty range.
        bandsUsed: used.size,
        topBand: used.size ? Math.max(...used) : 0,
      };
    }
  }, [ready, ambient, reach]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || ambient) return;
    const src = map.getSource('highlight') as GeoJSONSource | undefined;
    src?.setData(buildHighlights(highlights, highlightColors, activeHighlightId) as never);
  }, [ready, ambient, highlights, highlightColors, activeHighlightId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || ambient) return;
    const src = map.getSource('load-stops') as GeoJSONSource | undefined;
    src?.setData(buildTourStops(highlights, selectedLoadId) as never);
  }, [ready, ambient, highlights, selectedLoadId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || ambient || !map.getLayer('load-stop-dot')) return;

    const click = (event: MapLayerMouseEvent) => {
      const id = Number(event.features?.[0]?.properties?.loadId);
      if (!Number.isFinite(id)) return;
      const load = highlightsRef.current
        .flatMap((tour) => tour.legs)
        .find((leg) => leg.load.id === id)?.load;
      if (load) onSelectLoadRef.current?.(load);
    };
    const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', 'load-stop-dot', click);
    map.on('click', 'load-stop-label', click);
    map.on('mouseenter', 'load-stop-dot', enter);
    map.on('mouseenter', 'load-stop-label', enter);
    map.on('mouseleave', 'load-stop-dot', leave);
    map.on('mouseleave', 'load-stop-label', leave);
    return () => {
      map.off('click', 'load-stop-dot', click);
      map.off('click', 'load-stop-label', click);
      map.off('mouseenter', 'load-stop-dot', enter);
      map.off('mouseenter', 'load-stop-label', enter);
      map.off('mouseleave', 'load-stop-dot', leave);
      map.off('mouseleave', 'load-stop-label', leave);
    };
  }, [ready, ambient]);

  // Dash offset animation. Twelve steps a second is enough to read as motion
  // and costs one paint-property write per step.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const STEPS = [
      [0, 4, 3, 0], [0.5, 4, 2.5, 0], [1, 4, 2, 0], [1.5, 4, 1.5, 0],
      [2, 4, 1, 0], [2.5, 4, 0.5, 0], [3, 4, 0, 0.5], [0, 0.5, 3, 3.5],
    ];
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % STEPS.length;
      if (map.getLayer('flow-pulse')) {
        map.setPaintProperty('flow-pulse', 'line-dasharray', STEPS[i]);
      }
    }, 90);
    return () => clearInterval(timer);
  }, [ready]);

  // Hero turntable: the plane drifts on its own, a drag takes it over, and the
  // drift creeps back in a couple of seconds after you let go. The hero map is
  // pointer-events:none (it sits under the copy), so the drag is picked up from
  // the window and gated on the holder's rect rather than on hit-testing.
  useEffect(() => {
    const map = mapRef.current;
    const holder = holderRef.current;
    if (!map || !holder || !ready || !ambient) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const DRIFT = 2.6; // deg/sec — a full turn in a bit over two minutes
    const HOLD = 900; // ms of stillness after a drag before the drift returns
    const RAMP = 1600; // ms to ease from stopped back to full speed

    let bearing = map.getBearing();
    let pitch = map.getPitch();
    let dragging = false;
    let pointer = -1;
    let lastX = 0;
    let lastY = 0;
    let last = 0;
    // Start held so the very first drift eases in instead of snapping to speed.
    let idleAt = performance.now();
    let raf = 0;

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min(t - last, 100) : 0;
      last = t;
      if (dragging) return;
      const since = t - idleAt - HOLD;
      if (since <= 0) return;
      const p = Math.min(1, since / RAMP);
      bearing += (DRIFT * (p * p * (3 - 2 * p)) * dt) / 1000;
      map.setBearing(bearing);
    };
    raf = requestAnimationFrame(frame);

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      bearing -= (e.clientX - lastX) * 0.22;
      pitch = Math.min(68, Math.max(28, pitch - (e.clientY - lastY) * 0.12));
      lastX = e.clientX;
      lastY = e.clientY;
      map.jumpTo({ bearing, pitch });
    };

    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      dragging = false;
      pointer = -1;
      idleAt = performance.now();
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };

    const down = (e: PointerEvent) => {
      // Touch drags belong to the page scroll, not to the map.
      if (dragging || e.pointerType === 'touch' || e.button !== 0) return;
      const r = holder.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right) return;
      if (e.clientY < r.top || e.clientY > r.bottom) return;
      if (e.target instanceof Element && e.target.closest('a,button,input,textarea,select')) return;
      dragging = true;
      pointer = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };

    window.addEventListener('pointerdown', down);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [ready, ambient]);

  return (
    <div
      ref={holderRef}
      className={`ml-map${ambient ? ' ambient' : ''}`}
      style={{ position: 'absolute', inset: 0 }}
    />
  );
}
