/** Freight economics for a 5t Korean cargo truck, plus the core data types. */

import { CITY_BY_ID, type City } from './geo';
import { primarySite } from './sites';
import MATRIX from '../data/sites.json';
import CITY_MATRIX from '../data/cities.json';

/** ₩/L diesel × L/km for a loaded 5t. Roughly 1,650원 ÷ 3.5km/L. */
export const FUEL_WON_PER_KM = 471;
/** Blended expressway toll, 고속도로 2종. */
export const TOLL_WON_PER_KM = 46;
export const COST_WON_PER_KM = FUEL_WON_PER_KM + TOLL_WON_PER_KM;

/** Diesel: 2.68 kg CO₂ per litre ÷ 3.5 km per litre. */
export const CO2_KG_PER_KM = 0.766;

/**
 * Legal + humane ceiling on a single driver-day. This is *duty* time, not
 * seat time: driving, loading, unloading and dock waiting all count against
 * it, because they all count against the driver getting home.
 */
export const MAX_DUTY_HOURS = 13;
/**
 * Loading, unloading, waiting — charged **per dock stop**, not per leg. A leg
 * is two stops: you back onto a bay to pick up and again to drop. Charging it
 * once per leg was quietly giving every tour back an hour and a half it never
 * had, which made four-leg days look reachable when they aren't.
 */
export const HANDLING_HOURS = 0.4;
/** Both ends of one leg. */
export const LEG_HANDLING_HOURS = HANDLING_HOURS * 2;
/** A tour must finish this close to base to count as closed. */
export const HOME_RADIUS_KM = 60;
/**
 * There is no policy cap on how many loads a tour may chain — the clock is the
 * cap, and `MAX_DUTY_HOURS` (which includes the drive home) is what actually
 * stops a chain growing. This constant is only the arithmetic ceiling that
 * follows from it: every leg costs at least its two dock stops, so no legal
 * duty day can hold more legs than this. It exists so the solver's loops and
 * beam depth have a finite bound, not to express a rule.
 */
export const MAX_LEGS = Math.floor(MAX_DUTY_HOURS / LEG_HANDLING_HOURS);

export type Load = {
  id: number;
  /** City ids — what the solver's distance matrix is keyed on. */
  from: string;
  to: string;
  /** The actual dock this load sits on, inside those cities. */
  fromSite: string;
  toSite: string;
  /** Berth / dock / gate at each end. */
  fromBay: string;
  toBay: string;
  /** 운송장 번호, as it appears on the driver's phone. */
  ref: string;
  km: number;
  hours: number;
  /** Gross paid to the driver by the broker chain. */
  revenue: number;
  /** What the shipper actually paid before the layers took their cut. */
  shipperPrice: number;
  tons: number;
  goods: string;
};

export type Driver = {
  id: number;
  home: string;
  /** The yard itself — a site inside `home`. */
  depot: string;
  /** Where the truck is now. Defaults to the depot at the start of a normal day. */
  current?: string;
  name: string;
};

/** One assigned load inside a tour, with its deadhead approach. */
export type Leg = {
  load: Load;
  /** Empty km driven to reach this load's origin. */
  deadheadKm: number;
};

export type Tour = {
  driver: Driver;
  legs: Leg[];
  /** Empty km from the last drop back to base. */
  returnKm: number;
  loadedKm: number;
  emptyKm: number;
  hours: number;
  revenue: number;
  cost: number;
  net: number;
};

export type Stats = {
  emptyRatio: number;
  avgNet: number;
  medianNet: number;
  loadsServed: number;
  totalLoads: number;
  co2Tons: number;
  totalKm: number;
  avgHours: number;
  closedLoops: number;
};

// ── Distance matrix ────────────────────────────────────────────────────────
// Real driving distances and times between all 75 docks, routed with OSRM over
// OpenStreetMap and baked by `npm run bake`. In production this is the same
// shape as a Kakao Navi matrix call — the site just ships the answers.

const idx: Record<string, number> = Object.fromEntries(
  MATRIX.ids.map((id, i) => [id, i]),
);

/** Road km between two docks. */
export function km(a: string, b: string): number {
  return MATRIX.km[idx[a]]?.[idx[b]] ?? 0;
}

/** Driving hours between two docks, per OSRM's speed model. */
export function hrs(a: string, b: string): number {
  return MATRIX.hours[idx[a]]?.[idx[b]] ?? 0;
}

export function city(id: string): City {
  return CITY_BY_ID[id];
}

// City-to-city, for the planner UI where the user picks a city and not a dock.
const cityIdx: Record<string, number> = Object.fromEntries(
  CITY_MATRIX.ids.map((id, i) => [id, i]),
);

export function cityKm(a: string, b: string): number {
  return CITY_MATRIX.km[cityIdx[a]]?.[cityIdx[b]] ?? 0;
}

export function cityHrs(a: string, b: string): number {
  return CITY_MATRIX.hours[cityIdx[a]]?.[cityIdx[b]] ?? 0;
}

/** Where a truck starts its day: a dock, never a city centroid. */
export function driverStart(d: Driver): string {
  return d.current ? primarySite(d.current).id : d.depot;
}

// ── Tour arithmetic ────────────────────────────────────────────────────────

export function emptyTour(driver: Driver): Tour {
  return {
    driver,
    legs: [],
    returnKm: 0,
    loadedKm: 0,
    emptyKm: 0,
    hours: 0,
    revenue: 0,
    cost: 0,
    net: 0,
  };
}

/** Recompute every derived field on a tour from its leg list. */
export function settle(driver: Driver, legs: Leg[]): Tour {
  let loadedKm = 0;
  let emptyKm = 0;
  let hours = 0;
  let revenue = 0;

  let at = driverStart(driver);
  for (const leg of legs) {
    const approach = km(at, leg.load.fromSite);
    leg.deadheadKm = approach;
    emptyKm += approach;
    hours += hrs(at, leg.load.fromSite) + leg.load.hours + LEG_HANDLING_HOURS;
    loadedKm += leg.load.km;
    revenue += leg.load.revenue;
    at = leg.load.toSite;
  }

  const returnKm = legs.length ? km(at, driver.depot) : 0;
  emptyKm += returnKm;
  hours += legs.length ? hrs(at, driver.depot) : 0;

  const cost = (loadedKm + emptyKm) * COST_WON_PER_KM;
  return {
    driver,
    legs,
    returnKm,
    loadedKm,
    emptyKm,
    hours,
    revenue,
    cost,
    net: revenue - cost,
  };
}

export function feasible(t: Tour): boolean {
  return (
    t.legs.length <= MAX_LEGS &&
    t.hours <= MAX_DUTY_HOURS &&
    (t.legs.length === 0 || t.returnKm <= HOME_RADIUS_KM)
  );
}

export function summarise(tours: Tour[], totalLoads: number): Stats {
  const working = tours.filter((t) => t.legs.length > 0);
  let loaded = 0;
  let empty = 0;
  let served = 0;
  let closed = 0;
  let hours = 0;
  const nets: number[] = [];

  for (const t of working) {
    loaded += t.loadedKm;
    empty += t.emptyKm;
    served += t.legs.length;
    hours += t.hours;
    if (t.returnKm <= HOME_RADIUS_KM) closed++;
    nets.push(t.net);
  }

  const totalKm = loaded + empty;
  nets.sort((a, b) => a - b);
  const n = nets.length || 1;

  return {
    emptyRatio: totalKm > 0 ? empty / totalKm : 0,
    avgNet: nets.reduce((s, v) => s + v, 0) / n,
    medianNet: nets.length ? nets[Math.floor(nets.length / 2)] : 0,
    loadsServed: served,
    totalLoads,
    co2Tons: (empty * CO2_KG_PER_KM) / 1000,
    totalKm,
    avgHours: hours / n,
    closedLoops: closed,
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function won(v: number): string {
  return '₩' + Math.round(v).toLocaleString('ko-KR');
}

export function wonShort(v: number): string {
  const man = v / 10000;
  if (Math.abs(man) >= 1000) return `₩${(man / 10000).toFixed(1)}억`;
  return `₩${Math.round(man)}만`;
}

export function clockFromHours(startHour: number, elapsed: number): string {
  const total = startHour + elapsed;
  const h = Math.floor(total) % 24;
  const m = Math.round((total % 1) * 60);
  const suffix = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${suffix} ${h12}:${String(m).padStart(2, '0')}`;
}