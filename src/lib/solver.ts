/**
 * Tour construction and improvement.
 *
 * Baseline models today's board: myopic, first-come-first-serve, grab the
 * biggest number on the screen and worry about the way home later.
 *
 * The optimiser then runs simulated annealing over insert / remove / relocate
 * / swap / reorder moves, scoring each driver-day by net won with an explicit
 * penalty for finishing away from base. It is a real local search, run live —
 * not a pre-baked animation.
 */

import {
  HOME_RADIUS_KM,
  LEG_HANDLING_HOURS,
  MAX_DUTY_HOURS,
  MAX_LEGS,
  driverStart,
  feasible,
  hrs,
  km,
  settle,
  type Driver,
  type Leg,
  type Load,
  type Tour,
} from './model';
import { mulberry32 } from './generate';

/**
 * Won per km of unclosed return, charged on top of the fuel the driver already
 * eats. This is the stranding risk the Loop Guarantee underwrites — priced in
 * so the search actively hunts for closed loops.
 */
const STRAND_PENALTY_PER_KM = 1_400;

export function scoreTour(t: Tour): number {
  if (t.legs.length === 0) return 0;
  const overshoot = Math.max(0, t.returnKm - HOME_RADIUS_KM);
  return t.net - overshoot * STRAND_PENALTY_PER_KM;
}

// ── Baseline: the shouting board ───────────────────────────────────────────

/** How far a driver will chase a load they saw on the board. */
const CHASE_RADIUS_KM = 95;

export function buildBaseline(drivers: Driver[], loads: Load[], seed = 4242): Tour[] {
  const rand = mulberry32(seed);
  const taken = new Set<number>();

  // Arrival order is effectively random — that is the whole problem.
  const order = drivers.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const tours: Tour[] = drivers.map((d) => settle(d, []));

  for (const di of order) {
    const driver = drivers[di];
    let at = driverStart(driver);
    let hours = 0;
    const legs: Leg[] = [];

    // Grab loads one at a time, always taking the biggest visible number
    // within chasing distance. Where it drops you is tomorrow's problem —
    // the board shows a price, not a plan, and nobody is looking two legs out.
    for (let pick = 0; pick < MAX_LEGS; pick++) {
      let best: Load | null = null;
      let bestScore = -Infinity;

      for (const load of loads) {
        if (taken.has(load.id)) continue;
        const approach = km(at, load.fromSite);
        if (approach > CHASE_RADIUS_KM) continue;
        const spend = hrs(at, load.fromSite) + load.hours + LEG_HANDLING_HOURS;
        // Nobody on the board plans the way home — but everybody watches the
        // clock. A driver still turns down a load that can't legally get them
        // back to the yard, so the baseline is myopic, not illegal. Without
        // this it was handing out 15-hour days that `feasible()` then threw
        // out, which flattered the optimiser for the wrong reason.
        if (hours + spend + hrs(load.toSite, driver.depot) > MAX_DUTY_HOURS) continue;
        if (load.revenue > bestScore) {
          bestScore = load.revenue;
          best = load;
        }
      }

      if (!best) break;
      taken.add(best.id);
      hours += hrs(at, best.fromSite) + best.hours + LEG_HANDLING_HOURS;
      legs.push({ load: best, deadheadKm: km(at, best.fromSite) });
      at = best.toSite;
      // Most drivers run out of leads and take the empty run home.
      if (rand() > (pick === 0 ? 0.82 : 0.55)) break;
    }

    tours[di] = settle(driver, legs);
  }

  return tours;
}

// ── Optimiser ──────────────────────────────────────────────────────────────

type Move = 'insert' | 'remove' | 'relocate' | 'swap' | 'reorder';

export type RouteLock = {
  loadIds: number[];
  driverId: number;
  /** Available driving + handling time for the user's vehicle. */
  maxHours?: number;
  /** Hard payload ceiling for every load assigned to the user's vehicle. */
  maxTons?: number;
  /** Maximum full-loop distance for the input corridor. */
  maxKm?: number;
  /** Loads that satisfy the selected body and cargo-handling requirements. */
  allowedLoadIds?: number[];
  /** Preferred minimum chain length for the user's recommended loop. */
  minLegs?: number;
};

/** How many distinct days to keep for the driver to compare. */
const LOCKED_ALTERNATIVES = 4;

export class TourOptimizer {
  readonly drivers: Driver[];
  readonly loads: Load[];
  tours: Tour[];
  /**
   * The runners-up from `finalizeLockedRoute`, best first and including the
   * winner. The beam already evaluates thousands of feasible days for the
   * user's vehicle and used to discard every one but the top scorer, which is
   * why the console could only ever offer a single "제안된 회차".
   */
  lockedAlternatives: Tour[] = [];
  /** Load ids still sitting on the board. */
  private pool: number[] = [];
  private poolAt = new Map<number, number>();
  private loadById = new Map<number, Load>();
  private rand: () => number;

  iterations = 0;
  /** 0 → 1 across the configured annealing budget. */
  progress = 0;
  private budget: number;
  private lockedLoadIds = new Set<number>();
  private lockedDriverId: number | null;
  private lockedMaxHours: number;
  private lockedMaxTons: number;
  private lockedMaxKm: number;
  private lockedAllowedLoadIds: Set<number> | null;
  private lockedMinLegs: number;
  private t0 = 26_000;
  private t1 = 220;

  constructor(
    drivers: Driver[],
    loads: Load[],
    seed: Tour[],
    budget = 90_000,
    locked?: RouteLock | null,
  ) {
    this.drivers = drivers;
    this.loads = loads;
    this.budget = budget;
    this.lockedLoadIds = new Set(locked?.loadIds ?? []);
    this.lockedDriverId = locked?.driverId ?? null;
    this.lockedMaxHours = locked?.maxHours ?? MAX_DUTY_HOURS;
    this.lockedMaxTons = locked?.maxTons ?? Infinity;
    this.lockedMaxKm = locked?.maxKm ?? Infinity;
    this.lockedAllowedLoadIds = locked?.allowedLoadIds
      ? new Set(locked.allowedLoadIds)
      : null;
    this.lockedMinLegs = locked?.minLegs ?? 0;
    this.rand = mulberry32(9137);
    this.tours = seed.map((t) => settle(t.driver, t.legs.map((l) => ({ ...l }))));

    for (const l of loads) this.loadById.set(l.id, l);
    const assigned = new Set<number>();
    for (const t of this.tours) for (const l of t.legs) assigned.add(l.load.id);
    for (const l of loads) if (!assigned.has(l.id)) this.push(l.id);
  }

  private push(id: number) {
    this.poolAt.set(id, this.pool.length);
    this.pool.push(id);
  }

  private pull(i: number): number {
    const id = this.pool[i];
    const last = this.pool.pop()!;
    if (i < this.pool.length) {
      this.pool[i] = last;
      this.poolAt.set(last, i);
    }
    this.poolAt.delete(id);
    return id;
  }

  private temperature(): number {
    const p = Math.min(1, this.iterations / this.budget);
    return this.t0 * Math.pow(this.t1 / this.t0, p);
  }

  private accept(delta: number, temp: number): boolean {
    if (delta > 0) return true;
    return this.rand() < Math.exp(delta / temp);
  }

  private score(tour: Tour): number {
    const routeScore = scoreTour(tour);
    if (tour.driver.id !== this.lockedDriverId || this.lockedMinLegs === 0) return routeScore;
    return routeScore + Math.min(tour.legs.length, this.lockedMinLegs) * 600_000;
  }

  private pickTour(): number {
    return Math.floor(this.rand() * this.tours.length);
  }

  /**
   * Legal shape check — hours and leg count are hard, closure is priced.
   *
   * Except for the user's own vehicle. They handed us a return garage as an
   * input, so for them closure is a promise, not a preference: a priced
   * penalty can still be outbid by a fat one-way load, and the demo would
   * cheerfully route the customer somewhere they can't get home from.
   */
  private legal(t: Tour): boolean {
    const mine = t.driver.id === this.lockedDriverId;
    const maxHours = mine
      ? Math.min(MAX_DUTY_HOURS, this.lockedMaxHours)
      : MAX_DUTY_HOURS;
    // Leg count is not a constraint — the clock is. A chain grows until the
    // day, including the drive home, can't hold another pickup.
    if (t.hours > maxHours) return false;
    if (mine) {
      if (t.legs.length > 0 && t.returnKm > HOME_RADIUS_KM) return false;
      // Legs run pickup → drop in sequence, so the deck only ever holds one
      // load at a time. The ceiling is per load, not the sum of the day —
      // summing it was a second, invisible cap on chain length: four 2t loads
      // busted a 5t truck that never carried more than 2t at once.
      if (t.legs.some((leg) => leg.load.tons > this.lockedMaxTons)) return false;
      if (t.loadedKm + t.emptyKm > this.lockedMaxKm) return false;
      return t.legs.every(
        (leg) => !this.lockedAllowedLoadIds || this.lockedAllowedLoadIds.has(leg.load.id),
      );
    }
    return true;
  }

  private isLocked(loadId: number): boolean {
    return this.lockedLoadIds.has(loadId);
  }

  private firstFlexiblePosition(tour: Tour): number {
    let lastLocked = -1;
    tour.legs.forEach((leg, index) => {
      if (this.isLocked(leg.load.id)) lastLocked = index;
    });
    return lastLocked + 1;
  }

  private chooseMove(): Move {
    const r = this.rand();
    if (r < 0.32) return 'insert';
    if (r < 0.46) return 'remove';
    if (r < 0.7) return 'relocate';
    if (r < 0.88) return 'swap';
    return 'reorder';
  }

  /** Run a chunk of annealing. Call from rAF so the counters move live. */
  run(iterations: number): void {
    for (let n = 0; n < iterations; n++) {
      if (this.iterations >= this.budget) break;
      this.iterations++;
      const temp = this.temperature();

      switch (this.chooseMove()) {
        case 'insert':
          this.tryInsert(temp);
          break;
        case 'remove':
          this.tryRemove(temp);
          break;
        case 'relocate':
          this.tryRelocate(temp);
          break;
        case 'swap':
          this.trySwap(temp);
          break;
        case 'reorder':
          this.tryReorder(temp);
          break;
      }
    }
    this.progress = Math.min(1, this.iterations / this.budget);
  }

  get done(): boolean {
    return this.iterations >= this.budget;
  }

  get unassignedCount(): number {
    return this.pool.length;
  }

  /**
   * Finish the user's route with a deterministic beam search anchored to the
   * exact input start/depot. This removes fleet-level randomness from the
   * first recommendation while still evaluating real road hours and km.
   */
  finalizeLockedRoute(): void {
    if (this.lockedDriverId === null || this.lockedMinLegs === 0) return;
    const tourIndex = this.tours.findIndex((tour) => tour.driver.id === this.lockedDriverId);
    if (tourIndex < 0) return;
    const driver = this.tours[tourIndex].driver;
    const allowed = this.loads.filter(
      (load) =>
        (!this.lockedAllowedLoadIds || this.lockedAllowedLoadIds.has(load.id)) &&
        load.tons <= this.lockedMaxTons,
    );
    type Candidate = { tour: Tour; ids: Set<number> };
    let beam: Candidate[] = [{ tour: settle(driver, []), ids: new Set() }];
    /* Every feasible day the beam touches, keyed by its load set so the same
       three loads in a different order count once. */
    const feasible = new Map<string, Tour>();

    // Depth runs until the day is full: a chain stops growing when no load can
    // be appended without busting the hours, the corridor budget or the drive
    // home. `MAX_LEGS` here is only the arithmetic backstop on that loop, and
    // in practice the clock ends it first.
    for (let depth = 1; depth <= MAX_LEGS; depth++) {
      const expanded: Candidate[] = [];
      for (const candidate of beam) {
        for (const load of allowed) {
          if (candidate.ids.has(load.id)) continue;
          const legs = [...candidate.tour.legs, { load, deadheadKm: 0 }];
          const next = settle(driver, legs);
          if (next.hours > this.lockedMaxHours + 2) continue;
          if (next.loadedKm + next.emptyKm > this.lockedMaxKm + 120) continue;
          const ids = new Set(candidate.ids);
          ids.add(load.id);
          expanded.push({ tour: next, ids });
          if (
            depth >= this.lockedMinLegs &&
            next.hours <= this.lockedMaxHours &&
            next.loadedKm + next.emptyKm <= this.lockedMaxKm &&
            next.returnKm <= HOME_RADIUS_KM
          ) {
            const key = [...ids].sort((a, b) => a - b).join(',');
            const held = feasible.get(key);
            if (!held || scoreTour(next) > scoreTour(held)) feasible.set(key, next);
          }
        }
      }
      expanded.sort((a, b) => routeBeamScore(b.tour) - routeBeamScore(a.tour));
      // Narrower once the chains are long: the branching factor is the same at
      // every depth, so a constant width would make an unbounded depth cost
      // unbounded time on the frame that finalises the route.
      beam = expanded.slice(0, depth <= 4 ? 180 : 80);
      if (beam.length === 0) break;
    }

    this.lockedAlternatives = pickDistinctTours(
      [...feasible.values()].sort((a, b) => scoreTour(b) - scoreTour(a)),
      LOCKED_ALTERNATIVES,
    );
    const best: Tour | null = this.lockedAlternatives[0] ?? null;
    if (!best) return;
    const chosen = new Set(best.legs.map((leg) => leg.load.id));
    this.tours = this.tours.map((tour, index) =>
      index === tourIndex
        ? best!
        : settle(
            tour.driver,
            tour.legs.filter((leg) => !chosen.has(leg.load.id)),
          ),
    );
  }

  private tryInsert(temp: number) {
    if (this.pool.length === 0) return;
    const pi = Math.floor(this.rand() * this.pool.length);
    const loadId = this.pool[pi];
    const load = this.loadById.get(loadId)!;

    const ti = this.pickTour();
    const tour = this.tours[ti];

    const firstAllowed = tour.driver.id === this.lockedDriverId
      ? this.firstFlexiblePosition(tour)
      : 0;
    const pos = firstAllowed + Math.floor(this.rand() * (tour.legs.length + 1 - firstAllowed));
    const legs = tour.legs.map((l) => ({ ...l }));
    legs.splice(pos, 0, { load, deadheadKm: 0 });

    const next = settle(tour.driver, legs);
    if (!this.legal(next)) return;
    if (this.accept(this.score(next) - this.score(tour), temp)) {
      this.tours[ti] = next;
      this.pull(pi);
    }
  }

  private tryRemove(temp: number) {
    const ti = this.pickTour();
    const tour = this.tours[ti];
    if (tour.legs.length === 0) return;

    const pos = Math.floor(this.rand() * tour.legs.length);
    if (this.isLocked(tour.legs[pos].load.id)) return;
    const legs = tour.legs.map((l) => ({ ...l }));
    const [dropped] = legs.splice(pos, 1);

    const next = settle(tour.driver, legs);
    if (this.accept(this.score(next) - this.score(tour), temp)) {
      this.tours[ti] = next;
      this.push(dropped.load.id);
    }
  }

  private tryRelocate(temp: number) {
    const ai = this.pickTour();
    const bi = this.pickTour();
    if (ai === bi) return;
    const a = this.tours[ai];
    const b = this.tours[bi];
    if (a.legs.length === 0) return;

    const from = Math.floor(this.rand() * a.legs.length);
    if (this.isLocked(a.legs[from].load.id)) return;
    const firstAllowed = b.driver.id === this.lockedDriverId
      ? this.firstFlexiblePosition(b)
      : 0;
    const to = firstAllowed + Math.floor(this.rand() * (b.legs.length + 1 - firstAllowed));

    const aLegs = a.legs.map((l) => ({ ...l }));
    const [moved] = aLegs.splice(from, 1);
    const bLegs = b.legs.map((l) => ({ ...l }));
    bLegs.splice(to, 0, moved);

    const nextA = settle(a.driver, aLegs);
    const nextB = settle(b.driver, bLegs);
    if (!this.legal(nextB)) return;

    const delta = this.score(nextA) + this.score(nextB) - this.score(a) - this.score(b);
    if (this.accept(delta, temp)) {
      this.tours[ai] = nextA;
      this.tours[bi] = nextB;
    }
  }

  private trySwap(temp: number) {
    const ai = this.pickTour();
    const bi = this.pickTour();
    if (ai === bi) return;
    const a = this.tours[ai];
    const b = this.tours[bi];
    if (a.legs.length === 0 || b.legs.length === 0) return;

    const i = Math.floor(this.rand() * a.legs.length);
    const j = Math.floor(this.rand() * b.legs.length);
    if (
      this.isLocked(a.legs[i].load.id) ||
      this.isLocked(b.legs[j].load.id)
    ) return;

    const aLegs = a.legs.map((l) => ({ ...l }));
    const bLegs = b.legs.map((l) => ({ ...l }));
    const tmp = aLegs[i];
    aLegs[i] = bLegs[j];
    bLegs[j] = tmp;

    const nextA = settle(a.driver, aLegs);
    const nextB = settle(b.driver, bLegs);
    if (!this.legal(nextA) || !this.legal(nextB)) return;

    const delta = this.score(nextA) + this.score(nextB) - this.score(a) - this.score(b);
    if (this.accept(delta, temp)) {
      this.tours[ai] = nextA;
      this.tours[bi] = nextB;
    }
  }

  /**
   * 2-opt: reverse the stretch between two positions. On the old four-leg
   * ceiling this collapsed to a pair exchange, so that is what it did; a chain
   * that can now run eight or ten loads needs the real move, because untangling
   * a long tour is exactly where the crossing legs are.
   */
  private tryReorder(temp: number) {
    const ti = this.pickTour();
    const tour = this.tours[ti];
    if (tour.legs.length < 2) return;
    if (tour.legs.some((leg) => this.isLocked(leg.load.id))) return;

    const i = Math.floor(this.rand() * tour.legs.length);
    let j = Math.floor(this.rand() * tour.legs.length);
    if (i === j) j = (j + 1) % tour.legs.length;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);

    const legs = tour.legs.map((l) => ({ ...l }));
    for (let a = lo, b = hi; a < b; a++, b--) {
      const tmp = legs[a];
      legs[a] = legs[b];
      legs[b] = tmp;
    }

    const next = settle(tour.driver, legs);
    if (!this.legal(next)) return;
    if (this.accept(this.score(next) - this.score(tour), temp)) {
      this.tours[ti] = next;
    }
  }
}

function routeBeamScore(tour: Tour): number {
  return scoreTour(tour) + tour.legs.length * 500_000 - tour.returnKm * 900;
}

/**
 * Take the best `limit` tours that are meaningfully different from each other.
 *
 * Ranking by score alone returns four versions of the same day with one load
 * swapped, which is not a choice. The first pass demands two differing loads,
 * then it relaxes to one so a genuinely narrow board still fills the strip
 * rather than coming back with a single option.
 *
 * `ranked` must already be sorted best-first; ties keep the earlier entry.
 */
function pickDistinctTours(ranked: Tour[], limit: number): Tour[] {
  const ids = ranked.map((tour) => new Set(tour.legs.map((leg) => leg.load.id)));
  // Indices, not tours: the candidate pool runs to thousands and an
  // `indexOf` per comparison would make this quadratic over it.
  const picked: number[] = [];

  for (const minDelta of [2, 1]) {
    for (let i = 0; i < ranked.length && picked.length < limit; i++) {
      if (picked.includes(i)) continue;
      const novel = picked.every((k) => {
        let shared = 0;
        for (const id of ids[i]) if (ids[k].has(id)) shared++;
        return Math.max(ids[k].size, ids[i].size) - shared >= minDelta;
      });
      if (novel) picked.push(i);
    }
    if (picked.length >= limit) break;
  }
  // Back to best-first: the relaxed second pass appends behind the strict one.
  return picked.sort((a, b) => a - b).map((i) => ranked[i]);
}

/**
 * Pick the tour to put on the driver's phone: a closed multi-leg loop with a
 * strong hourly rate. This is showcase selection, not cherry-picking — every
 * tour in the result set satisfies the same constraints.
 */
export function showcaseTour(tours: Tour[]): Tour | null {
  let best: Tour | null = null;
  let bestScore = -Infinity;
  for (const t of tours) {
    if (t.legs.length < 3) continue;
    if (!feasible(t)) continue;
    // Leave headroom in the day rather than parading a tour that lands on the
    // legal ceiling. A flat 11 did this too, but it silently excluded anyone
    // whose own budget was already short.
    if (t.hours > MAX_DUTY_HOURS * 0.85) continue;
    const perHour = t.net / Math.max(1, t.hours);
    const loadedShare = t.loadedKm / Math.max(1, t.loadedKm + t.emptyKm);
    // Longer chains are the product, so length is a tiebreaker between days
    // that earn the same per hour — it used to be a bonus for exactly three
    // legs, which quietly made a five-leg day look worse than a three-leg one.
    const score = perHour * (0.6 + loadedShare) * (1 + 0.04 * (t.legs.length - 2));
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best ?? tours.find((t) => t.legs.length >= 2 && feasible(t)) ?? null;
}

/** Alternate loops offered behind “다른 루프 보기”. */
export function alternateTours(tours: Tour[], exclude: Tour | null, n = 2): Tour[] {
  return tours
    .filter((t) => t !== exclude && t.legs.length >= 2 && feasible(t))
    .sort((a, b) => b.net / Math.max(1, b.hours) - a.net / Math.max(1, a.hours))
    .slice(0, n);
}
