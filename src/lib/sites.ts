/**
 * Facility-level geography: the actual docks, ports and industrial estates a
 * load is picked up from, rather than "Busan".
 *
 * Freight never moves city-to-city — it moves 신항 3부두 to 오창과학산업단지. The
 * whole board is generated at this resolution; the city is just the label the
 * map falls back to when you are zoomed out far enough that the sites in a
 * city are two pixels apart.
 *
 * Coordinates are the city centroid plus a hand-set offset, accurate to about
 * a kilometre — close enough that the geometry is honest at every zoom level
 * this map supports.
 */

import { CITY_BY_ID, type City } from './geo';

export type SiteKind = '항만' | '물류단지' | '물류센터' | '산업단지' | '공장' | '터미널' | '시장';

export type Site = {
  id: string;
  cityId: string;
  ko: string;
  kind: SiteKind;
  lon: number;
  lat: number;
  /** Share of the city's freight originating or terminating here. */
  weight: number;
};

/** [name, kind, Δlon, Δlat, weight] against the city centroid. */
type Entry = [string, SiteKind, number, number, number];

const TABLE: Record<string, Entry[]> = {
  seoul: [
    ['동남권물류단지', '물류단지', 0.15, -0.09, 1],
    ['가락 농수산물시장', '시장', 0.13, -0.07, 0.7],
    ['구로디지털산업단지', '산업단지', -0.08, -0.09, 0.6],
    ['서부트럭터미널', '터미널', -0.11, -0.03, 0.8],
  ],
  incheon: [
    ['인천신항', '항만', 0.06, -0.13, 1],
    ['남동국가산업단지', '산업단지', 0.1, -0.05, 0.85],
    ['인천공항 화물터미널', '터미널', -0.25, 0.01, 0.7],
    ['청라물류단지', '물류단지', -0.05, 0.07, 0.55],
  ],
  icheon: [
    ['호법물류단지', '물류단지', -0.06, -0.06, 1],
    ['마장 유통물류센터', '물류센터', -0.09, 0.03, 0.7],
    ['부발 반도체공장', '공장', 0.06, 0.01, 0.6],
  ],
  pyeongtaek: [
    ['평택항 포승부두', '항만', -0.28, 0.03, 1],
    ['고덕 반도체캠퍼스', '공장', 0.1, 0.05, 0.8],
    ['평택 브레인시티산단', '산업단지', 0.04, 0.03, 0.5],
  ],
  ansan: [
    ['반월국가산업단지', '산업단지', 0.04, -0.05, 1],
    ['시화 MTV단지', '산업단지', -0.06, -0.03, 0.7],
  ],
  cheonan: [
    ['성거 물류단지', '물류단지', 0.03, 0.06, 1],
    ['백석 산업단지', '산업단지', -0.05, -0.02, 0.6],
    ['천안 종합물류터미널', '터미널', 0.06, -0.03, 0.7],
  ],
  asan: [
    ['인주 국가산업단지', '산업단지', -0.09, 0.09, 1],
    ['아산 자동차공장', '공장', -0.03, 0.04, 0.8],
  ],
  dangjin: [
    ['당진항 고대부두', '항만', 0.07, 0.12, 1],
    ['당진 제철소', '공장', 0.09, 0.1, 0.9],
    ['송악 산업단지', '산업단지', 0.04, -0.01, 0.5],
  ],
  daejeon: [
    ['대덕산업단지', '산업단지', 0.03, 0.06, 1],
    ['대전 종합물류단지', '물류단지', -0.06, 0.04, 0.85],
    ['유성 첨단산업단지', '산업단지', -0.09, 0.02, 0.6],
  ],
  cheongju: [
    ['오창과학산업단지', '산업단지', -0.06, 0.09, 1],
    ['청주 화물터미널', '터미널', 0.02, -0.03, 0.6],
  ],
  chungju: [
    ['충주 기업도시산단', '산업단지', -0.05, -0.04, 1],
    ['산척 물류센터', '물류센터', 0.08, 0.06, 0.5],
  ],
  gunsan: [
    ['군산항 5부두', '항만', -0.07, 0.03, 1],
    ['새만금 산업단지', '산업단지', -0.12, -0.04, 0.7],
  ],
  jeonju: [
    ['팔복동 공단', '산업단지', -0.03, 0.03, 1],
    ['전주 과학산업단지', '산업단지', 0.05, -0.05, 0.7],
  ],
  gwangju: [
    ['평동 산업단지', '산업단지', -0.09, -0.02, 1],
    ['하남 산업단지', '산업단지', -0.05, 0.05, 0.85],
    ['광주 화물터미널', '터미널', 0.03, 0.02, 0.6],
  ],
  mokpo: [
    ['목포신항', '항만', -0.05, 0.04, 1],
    ['대양 산업단지', '산업단지', 0.05, -0.02, 0.6],
  ],
  suncheon: [
    ['율촌 제1산업단지', '산업단지', 0.06, -0.06, 1],
    ['순천 물류센터', '물류센터', -0.02, 0.02, 0.5],
  ],
  yeosu: [
    ['여수국가산업단지', '산업단지', -0.09, 0.06, 1],
    ['여수항 신북부두', '항만', 0.02, -0.02, 0.7],
  ],
  jinju: [
    ['상평 산업단지', '산업단지', -0.03, 0.01, 1],
    ['진주 물류센터', '물류센터', 0.04, 0.04, 0.6],
  ],
  changwon: [
    ['창원국가산업단지', '산업단지', -0.04, -0.02, 1],
    ['마산 자유무역지역', '산업단지', -0.1, 0.01, 0.7],
    ['진해신항 배후단지', '항만', 0.03, -0.08, 0.8],
  ],
  gimhae: [
    ['골든루트 산업단지', '산업단지', -0.05, 0.05, 1],
    ['김해 물류센터', '물류센터', 0.03, -0.02, 0.7],
  ],
  busan: [
    ['부산신항 3부두', '항만', -0.24, -0.09, 1],
    ['신선대부두', '항만', 0.02, -0.06, 0.9],
    ['감천항 물류센터', '물류센터', -0.07, -0.08, 0.7],
    ['사상 공업단지', '산업단지', -0.06, 0.01, 0.6],
  ],
  yangsan: [
    ['유산 물류단지', '물류단지', -0.03, -0.02, 1],
    ['양산 일반산업단지', '산업단지', 0.02, 0.03, 0.7],
  ],
  ulsan: [
    ['울산항 4부두', '항만', 0.06, -0.02, 1],
    ['온산국가산업단지', '산업단지', 0.03, -0.11, 0.9],
    ['울산 자동차공장', '공장', 0.05, 0.01, 0.85],
  ],
  daegu: [
    ['성서 산업단지', '산업단지', -0.08, -0.02, 1],
    ['검단 물류단지', '물류단지', 0.02, 0.04, 0.8],
    ['대구 화물터미널', '터미널', 0.05, -0.03, 0.6],
  ],
  gumi: [
    ['구미국가산단 4단지', '산업단지', -0.07, -0.02, 1],
    ['구미 물류센터', '물류센터', 0.03, 0.02, 0.6],
  ],
  pohang: [
    ['포항제철소', '공장', -0.03, -0.04, 1],
    ['영일만항', '항만', 0.02, 0.07, 0.8],
    ['철강 산업단지', '산업단지', -0.05, -0.01, 0.7],
  ],
  andong: [['안동 일반산업단지', '산업단지', 0.04, -0.03, 1]],
  wonju: [
    ['문막 산업단지', '산업단지', -0.1, -0.02, 1],
    ['원주 기업도시', '물류단지', -0.04, 0.03, 0.7],
  ],
  chuncheon: [
    ['후평 산업단지', '산업단지', 0.03, 0.01, 1],
    ['춘천 물류센터', '물류센터', -0.04, -0.03, 0.6],
  ],
  gangneung: [
    ['옥계항', '항만', 0.1, -0.13, 1],
    ['강릉 과학산업단지', '산업단지', -0.04, 0.02, 0.7],
  ],
};

export const SITES: Site[] = Object.entries(TABLE).flatMap(([cityId, entries]) => {
  const c = CITY_BY_ID[cityId];
  return entries.map(([ko, kind, dLon, dLat, weight], i) => ({
    id: `${cityId}-${i}`,
    cityId,
    ko,
    kind,
    lon: c.lon + dLon,
    lat: c.lat + dLat,
    weight,
  }));
});

export const SITE_BY_ID: Record<string, Site> = Object.fromEntries(
  SITES.map((s) => [s.id, s]),
);

export const SITES_BY_CITY: Record<string, Site[]> = SITES.reduce<Record<string, Site[]>>(
  (acc, s) => {
    (acc[s.cityId] ??= []).push(s);
    return acc;
  },
  {},
);

export function site(id: string): Site {
  return SITE_BY_ID[id];
}

/** Resolve either an exact facility id or a city to its busiest facility. */
export function primarySite(locationId: string): Site {
  return SITE_BY_ID[locationId] ?? SITES_BY_CITY[locationId]?.[0] ?? SITES[0];
}

/** Weighted pick inside a city, so the big terminals carry the most freight. */
export function pickSite(cityId: string, rand: () => number): Site {
  const list = SITES_BY_CITY[cityId];
  const total = list.reduce((s, x) => s + x.weight, 0);
  let r = rand() * total;
  for (const s of list) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return list[list.length - 1];
}

const LETTERS = 'ABCDEF';

/** The dock, berth or gate the driver actually backs into. */
export function bayFor(s: Site, rand: () => number): string {
  const n = 1 + Math.floor(rand() * 8);
  switch (s.kind) {
    case '항만':
      return `${n}번 선석 게이트`;
    case '물류단지':
    case '물류센터':
      return `${LETTERS[n % LETTERS.length]}동 도크 ${n}`;
    case '산업단지':
      return `${n}블록 하차장`;
    case '공장':
      return `제${n}공장 상차장`;
    case '터미널':
      return `${n}번 홈`;
    case '시장':
      return `${['동', '서', '남', '북'][n % 4]}문 상차장`;
  }
}

export function cityOf(siteId: string): City {
  return CITY_BY_ID[SITE_BY_ID[siteId].cityId];
}

/** "부산 신항 3부두" — the form used anywhere the city isn't already obvious. */
export function siteLabel(siteId: string): string {
  const s = SITE_BY_ID[siteId];
  if (!s) return siteId;
  return `${CITY_BY_ID[s.cityId].ko} ${s.ko}`;
}

/** Just "신항 3부두", for rows that already carry the city. */
export function siteShort(siteId: string): string {
  return SITE_BY_ID[siteId]?.ko ?? siteId;
}
