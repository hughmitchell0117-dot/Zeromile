/**
 * Korean city geography. Coordinates are real; `weight` is the relative freight
 * gravity used to shape the synthetic load board.
 *
 * There is no projection or coastline here any more — the map is a real
 * OpenStreetMap basemap, and distances come from the baked OSRM matrices in
 * `src/data`.
 */

export type City = {
  id: string;
  ko: string;
  en: string;
  lon: number;
  lat: number;
  /** Relative freight gravity — how much cargo originates/terminates here. */
  weight: number;
};

export const CITIES: City[] = [
  { id: 'seoul', ko: '서울', en: 'Seoul', lon: 126.978, lat: 37.567, weight: 1.0 },
  { id: 'incheon', ko: '인천', en: 'Incheon', lon: 126.705, lat: 37.456, weight: 0.9 },
  { id: 'icheon', ko: '이천', en: 'Icheon', lon: 127.435, lat: 37.272, weight: 0.85 },
  { id: 'pyeongtaek', ko: '평택', en: 'Pyeongtaek', lon: 127.113, lat: 36.992, weight: 0.8 },
  { id: 'ansan', ko: '안산', en: 'Ansan', lon: 126.831, lat: 37.322, weight: 0.7 },
  { id: 'cheonan', ko: '천안', en: 'Cheonan', lon: 127.154, lat: 36.815, weight: 0.75 },
  { id: 'asan', ko: '아산', en: 'Asan', lon: 127.002, lat: 36.79, weight: 0.5 },
  { id: 'dangjin', ko: '당진', en: 'Dangjin', lon: 126.646, lat: 36.893, weight: 0.55 },
  { id: 'daejeon', ko: '대전', en: 'Daejeon', lon: 127.385, lat: 36.351, weight: 0.8 },
  { id: 'cheongju', ko: '청주', en: 'Cheongju', lon: 127.489, lat: 36.642, weight: 0.6 },
  { id: 'chungju', ko: '충주', en: 'Chungju', lon: 127.93, lat: 36.991, weight: 0.35 },
  { id: 'gunsan', ko: '군산', en: 'Gunsan', lon: 126.737, lat: 35.968, weight: 0.45 },
  { id: 'jeonju', ko: '전주', en: 'Jeonju', lon: 127.148, lat: 35.824, weight: 0.5 },
  { id: 'gwangju', ko: '광주', en: 'Gwangju', lon: 126.853, lat: 35.16, weight: 0.7 },
  { id: 'mokpo', ko: '목포', en: 'Mokpo', lon: 126.392, lat: 34.812, weight: 0.35 },
  { id: 'suncheon', ko: '순천', en: 'Suncheon', lon: 127.487, lat: 34.951, weight: 0.35 },
  { id: 'yeosu', ko: '여수', en: 'Yeosu', lon: 127.663, lat: 34.76, weight: 0.45 },
  { id: 'jinju', ko: '진주', en: 'Jinju', lon: 128.104, lat: 35.18, weight: 0.35 },
  { id: 'changwon', ko: '창원', en: 'Changwon', lon: 128.681, lat: 35.228, weight: 0.65 },
  { id: 'gimhae', ko: '김해', en: 'Gimhae', lon: 128.889, lat: 35.229, weight: 0.5 },
  { id: 'busan', ko: '부산', en: 'Busan', lon: 129.075, lat: 35.18, weight: 1.0 },
  { id: 'yangsan', ko: '양산', en: 'Yangsan', lon: 129.037, lat: 35.335, weight: 0.4 },
  { id: 'ulsan', ko: '울산', en: 'Ulsan', lon: 129.311, lat: 35.539, weight: 0.75 },
  { id: 'daegu', ko: '대구', en: 'Daegu', lon: 128.601, lat: 35.871, weight: 0.8 },
  { id: 'gumi', ko: '구미', en: 'Gumi', lon: 128.344, lat: 36.12, weight: 0.6 },
  { id: 'pohang', ko: '포항', en: 'Pohang', lon: 129.365, lat: 36.019, weight: 0.55 },
  { id: 'andong', ko: '안동', en: 'Andong', lon: 128.729, lat: 36.568, weight: 0.3 },
  { id: 'wonju', ko: '원주', en: 'Wonju', lon: 127.947, lat: 37.342, weight: 0.45 },
  { id: 'chuncheon', ko: '춘천', en: 'Chuncheon', lon: 127.734, lat: 37.881, weight: 0.3 },
  { id: 'gangneung', ko: '강릉', en: 'Gangneung', lon: 128.896, lat: 37.752, weight: 0.35 },
];

export const CITY_BY_ID: Record<string, City> = Object.fromEntries(
  CITIES.map((c) => [c.id, c]),
);
