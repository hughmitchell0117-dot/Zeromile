/**
 * Synthetic load board over real Korean city coordinates.
 *
 * Seeded so every demo run is identical. Rates are calibrated against public
 * 5t 화물 spot ranges; the shipper price carries the brokerage spread that the
 * driver never gets to see today.
 */

import { CITIES } from './geo';
import { LEG_HANDLING_HOURS, hrs, km as roadKm, type Driver, type Load } from './model';
import { SITE_BY_ID, SITES, bayFor, pickSite } from './sites';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOODS = [
  '전자부품', '자동차부품', '냉장식품', '건축자재', '화학원료',
  '의류/잡화', '가전제품', '철강코일', '농산물', '생활용품',
  '음료/주류', '포장재', '반도체 장비', '가구',
];

const DRIVER_NAMES = [
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
  '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍',
];

export type RouteBridgeOptions = {
  startSite: string;
  homeSite: string;
  maxHours: number;
  maxTons: number;
  goods: string;
  idStart: number;
  seed?: number;
};

/**
 * Add a small, deterministic corridor to the synthetic freight board so every
 * valid start/garage pair has something the optimiser can close. The normal
 * board remains the search space; these loads only guarantee that its random
 * draw cannot make a perfectly valid location pair return an empty result.
 */
export function generateRouteBridgeLoads({
  startSite,
  homeSite,
  maxHours,
  maxTons,
  goods,
  idStart,
  seed = 918_273,
}: RouteBridgeOptions): Load[] {
  if (!SITE_BY_ID[startSite] || !SITE_BY_ID[homeSite]) return [];

  const directHours = hrs(startSite, homeSite);
  const legCount = Math.min(
    3,
    Math.max(0, Math.floor((maxHours - directHours + 1e-6) / LEG_HANDLING_HOURS)),
  );
  if (legCount === 0) return [];

  let stops = corridorStops(startSite, homeSite, legCount);
  const routeHours = stops.slice(0, -1).reduce(
    (total, stop, index) => total + hrs(stop, stops[index + 1]),
    legCount * LEG_HANDLING_HOURS,
  );
  // A geographically close waypoint can still sit across a mountain or bay.
  // Fall back to zero-detour dock transfers rather than breaking the clock.
  if (routeHours > maxHours + 1e-6) stops = zeroDetourStops(startSite, homeSite, legCount);

  const rand = mulberry32(seed + idStart * 17 + startSite.length * 31 + homeSite.length * 43);
  return stops.slice(0, -1).map((fromSite, index) => {
    const toSite = stops[index + 1];
    const origin = SITE_BY_ID[fromSite];
    const destination = SITE_BY_ID[toSite];
    const distance = roadKm(fromSite, toSite);
    const tons = Math.max(1, Math.min(maxTons, 1 + (index % 3)));
    const revenue =
      Math.round(((62_000 + distance * 1_015) * (0.96 + index * 0.03)) / 1_000) * 1_000;
    return {
      id: idStart + index,
      from: origin.cityId,
      to: destination.cityId,
      fromSite,
      toSite,
      fromBay: bayFor(origin, rand),
      toBay: bayFor(destination, rand),
      ref: `ZR-${String(idStart + index + 1).padStart(6, '0')}`,
      km: distance,
      hours: hrs(fromSite, toSite),
      revenue,
      shipperPrice: Math.round(revenue / 0.76 / 1_000) * 1_000,
      tons,
      goods,
    };
  });
}

function corridorStops(startSite: string, homeSite: string, legCount: number): string[] {
  if (legCount === 1) return [startSite, homeSite];
  if (startSite === homeSite) {
    const nearby = SITES
      .filter((site) => site.id !== startSite)
      .sort((a, b) => hrs(startSite, a.id) - hrs(startSite, b.id))
      .slice(0, legCount - 1)
      .map((site) => site.id);
    return [startSite, ...nearby, homeSite];
  }

  const directHours = Math.max(hrs(startSite, homeSite), 0.01);
  const used = new Set([startSite, homeSite]);
  const waypoints: string[] = [];
  for (let step = 1; step < legCount; step++) {
    const targetProgress = step / legCount;
    const candidate = SITES
      .filter((site) => !used.has(site.id))
      .map((site) => {
        const fromStart = hrs(startSite, site.id);
        const detour = Math.max(0, fromStart + hrs(site.id, homeSite) - directHours);
        const score = Math.abs(fromStart / directHours - targetProgress) * 2 + detour / directHours;
        return { id: site.id, score };
      })
      .sort((a, b) => a.score - b.score)[0];
    if (!candidate) break;
    used.add(candidate.id);
    waypoints.push(candidate.id);
  }
  return waypoints.length === legCount - 1
    ? [startSite, ...waypoints, homeSite]
    : zeroDetourStops(startSite, homeSite, legCount);
}

function zeroDetourStops(startSite: string, homeSite: string, legCount: number): string[] {
  return Array.from({ length: legCount + 1 }, (_, index) => {
    if (index === 0) return startSite;
    if (index === legCount) return homeSite;
    return index < legCount / 2 ? startSite : homeSite;
  });
}

/** Cumulative weight table for gravity-proportional city sampling. */
function weightedPicker(rand: () => number) {
  const total = CITIES.reduce((s, c) => s + c.weight, 0);
  return () => {
    let r = rand() * total;
    for (const c of CITIES) {
      r -= c.weight;
      if (r <= 0) return c;
    }
    return CITIES[CITIES.length - 1];
  };
}

export function generateLoads(count: number, seed = 20260801): Load[] {
  const rand = mulberry32(seed);
  const pick = weightedPicker(rand);
  const loads: Load[] = [];

  let id = 0;
  let guard = 0;
  while (loads.length < count && guard++ < count * 40) {
    const a = pick();
    const b = pick();
    if (a.id === b.id) continue;

    // Real driving distance between the two docks, not centroid haversine —
    // a 신항 pickup is genuinely further from Seoul than "Busan" is.
    const origin = pickSite(a.id, rand);
    const dest = pickSite(b.id, rand);
    const km = roadKm(origin.id, dest.id);
    // Freight volume decays with distance; keep the board realistic rather
    // than a uniform scatter of 400km hauls.
    if (rand() > Math.exp(-km / 320) + 0.18) continue;
    if (km < 35) continue;

    const tons = 1 + Math.floor(rand() * 5);
    const variance = 0.9 + rand() * 0.22;
    const tonFactor = 0.86 + tons * 0.05;
    const revenue =
      Math.round(((62_000 + km * 1_015) * variance * tonFactor) / 1_000) * 1_000;

    // Shipper → 주선업체 → sub-broker → driver. 18–34% disappears in the middle.
    const spread = 0.18 + rand() * 0.16;
    const shipperPrice = Math.round(revenue / (1 - spread) / 1_000) * 1_000;

    loads.push({
      id: id++,
      from: a.id,
      to: b.id,
      fromSite: origin.id,
      toSite: dest.id,
      fromBay: bayFor(origin, rand),
      toBay: bayFor(dest, rand),
      ref: `HC-${String(26_0000 + id * 7 + Math.floor(rand() * 6)).padStart(6, '0')}`,
      km,
      hours: hrs(origin.id, dest.id),
      revenue,
      shipperPrice,
      tons,
      goods: GOODS[Math.floor(rand() * GOODS.length)],
    });
  }

  return loads;
}

export function generateDrivers(count: number, seed = 77001): Driver[] {
  const rand = mulberry32(seed);
  const pick = weightedPicker(rand);
  return Array.from({ length: count }, (_, i) => {
    const home = pick();
    return {
      id: i,
      home: home.id,
      depot: pickSite(home.id, rand).id,
      name: `${DRIVER_NAMES[Math.floor(rand() * DRIVER_NAMES.length)]} 기사`,
    };
  });
}
