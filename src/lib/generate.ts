/**
 * Synthetic load board over real Korean city coordinates.
 *
 * Seeded so every demo run is identical. Rates are calibrated against public
 * 5t 화물 spot ranges; the shipper price carries the brokerage spread that the
 * driver never gets to see today.
 */

import { CITIES } from './geo';
import { hrs, km as roadKm, type Driver, type Load } from './model';
import { bayFor, pickSite } from './sites';

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
