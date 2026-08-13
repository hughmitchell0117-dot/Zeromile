/**
 * What the agent can see and do.
 *
 * Two halves that have to stay in sync: `TOOL_DECLARATIONS`, which is the
 * schema Gemini plans against, and `TOOLS`, which actually runs. The rule for
 * everything in here is that the model never computes a number — it reads one.
 * Every won figure, every kilometre and every hour handed back comes off the
 * solved `Tour` or the cost model in `src/lib/model.ts`, so the agent can be
 * wrong about phrasing but not about money.
 *
 * Tools that fail return `{ error }` rather than throwing. A thrown error would
 * end the turn; an error the model can read is one it can recover from — most
 * often by asking the driver the question it was missing.
 */

import { consoleHandle, consoleReady, type TripPatch } from './bus';
import { CITIES } from '../geo';
import { SITES, cityOf, siteLabel } from '../sites';
import { applyTheme } from '../theme';
import {
  COST_WON_PER_KM,
  FUEL_WON_PER_KM,
  TOLL_WON_PER_KM,
  CO2_KG_PER_KM,
  HOME_RADIUS_KM,
  LEG_HANDLING_HOURS,
  MAX_DUTY_HOURS,
  MAX_LEGS,
} from '../model';
import type { CargoCondition, VehicleType } from '../loading';

/** A Gemini function declaration. Deliberately the OpenAPI subset Google takes. */
export type ToolDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ToolResult = Record<string, unknown>;

const SECTIONS = ['top', 'problem', 'reframe', 'lab', 'driver', 'moat', 'guarantee', 'method'] as const;
const VEHICLES: VehicleType[] = ['카고', '윙바디', '냉장탑차'];
const CARGO: CargoCondition[] = ['일반 화물', '냉장·냉동', '취급주의'];

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const enumOf = (values: readonly string[], description: string) => ({
  type: 'string',
  enum: [...values],
  description,
});

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  /* ── Getting around the page ──────────────────────────────────────── */
  {
    name: 'navigate',
    description:
      'Scroll the pitch site to a section. Use this to bring the viewer somewhere before you act there — always navigate to "lab" before setting up or running an optimization, and to "driver" when talking about the phone screen. Sections: top (hero), problem (empty-running today), reframe (how chaining works), lab (the live simulator and the 3D loading bay), driver (the driver phone), moat (business case), guarantee (the depot-return promise), method (methodology and charts).',
    parameters: {
      type: 'object',
      properties: { section: enumOf(SECTIONS, 'Section id to scroll to.') },
      required: ['section'],
    },
  },
  {
    name: 'set_theme',
    description: 'Switch the site between the dark (carbon) and light (paper) theme.',
    parameters: {
      type: 'object',
      properties: { theme: enumOf(['dark', 'light'], 'Theme to apply.') },
      required: ['theme'],
    },
  },

  /* ── Resolving places ─────────────────────────────────────────────── */
  {
    name: 'find_location',
    description:
      'Resolve free text a driver said — "부산", "Busan port", "의왕", "인천항 근처" — into real location ids from the 30 cities and 75 docks this simulator routes over. ALWAYS call this before set_trip; never invent an id. If it returns more than one plausible match, ask the driver which one before continuing.',
    parameters: {
      type: 'object',
      properties: { query: str('What the driver said, Korean or English.') },
      required: ['query'],
    },
  },
  {
    name: 'list_cities',
    description: 'List all 30 cities the network covers, with their ids. Use when the driver asks where the service runs.',
    parameters: { type: 'object', properties: {} },
  },

  /* ── The trip form ────────────────────────────────────────────────── */
  {
    name: 'get_trip_status',
    description:
      'Read the trip form as it stands: what is filled in, what is still missing, how many loads currently qualify, and whether a run has happened. Call this at the start of a conversation and whenever you are unsure what you already know.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_trip',
    description:
      'Fill in part of the trip form. Send only the fields you have just learned — the rest keep their current values, and the form is visibly updated on screen as you go. Location fields need ids from find_location. Note the vehicle and cargo fields are a linked pair: choosing 냉장·냉동 forces 냉장탑차, and 카고 cannot take 냉장·냉동 or 취급주의, so the form will repair an impossible combination and say so in the result.',
    parameters: {
      type: 'object',
      properties: {
        current: str('Location id where the truck is right now.'),
        returnDepot: str('Location id of the garage the day must end at.'),
        startHour: num('Hour of day the driver starts, 0-23.'),
        deadlineHour: num('Hour of day the driver must be home by, 0-24.'),
        maxDriveHours: num(`Maximum hours behind the wheel, up to ${MAX_DUTY_HOURS}.`),
        truckTons: num('Payload capacity in tonnes, e.g. 1, 2.5, 5, 11, 25.'),
        vehicleType: enumOf(VEHICLES, 'Body type.'),
        cargoType: enumOf(CARGO, 'Cargo condition the driver can handle.'),
      },
    },
  },
  {
    name: 'set_scenario',
    description:
      'Choose the load-board scenario the fleet is solved against: quick (180 loads, ~1s), standard (400 loads, a normal operating day), dense (650 loads, weekday peak). Standard is the default and is right for almost every conversation.',
    parameters: {
      type: 'object',
      properties: { scenario: enumOf(['quick', 'standard', 'dense'], 'Scenario id.') },
      required: ['scenario'],
    },
  },

  /* ── Running the solver ───────────────────────────────────────────── */
  {
    name: 'run_optimization',
    description:
      'Run the annealer. Requires both locations to be set. This is the moment of the demo — navigate to "lab" first so the viewer watches it happen. It returns as soon as the run is launched; the search takes a few seconds, so tell the driver it is running and then call get_result_summary.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'reset_simulation',
    description: 'Throw away the current solve and return the console to its unoptimized baseline.',
    parameters: { type: 'object', properties: {} },
  },

  /* ── Reading the answer ───────────────────────────────────────────── */
  {
    name: 'get_result_summary',
    description:
      'The headline of the last run: empty-running before and after, net income per driver, loads served, CO2, and how long the search took. Call this after run_optimization. If it reports phase "running", wait and call it again.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_tour',
    description:
      "The driver's own solved tour, leg by leg: pickup and drop docks with their bay numbers, the waybill ref, distance, hours, tonnage, goods, the revenue on each leg, the empty kilometres driven to reach it, and the run home. This is the source for any question about the day itself.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'explain_leg',
    description:
      'One leg in detail, with its share of the day and its cost breakdown, so you can answer "why am I going there first?" or "what does that leg actually pay me?".',
    parameters: {
      type: 'object',
      properties: { index: num('1-based leg number as shown to the driver.') },
      required: ['index'],
    },
  },
  {
    name: 'list_alternatives',
    description:
      'Runner-up tours the solver kept for this driver — the other ways the day could have been chained, with their numbers, so you can explain why the chosen one won.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'compare_to_single_load',
    description:
      'The pitch in one call: this chained tour against the ordinary way of working, where a driver takes the single best-paying load and runs home empty. Returns both sides plus the difference. The comparison rests on a stated assumption — repeat that assumption to the driver, do not hide it.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_economics',
    description:
      'The cost model every number on this site is built from: fuel and tolls per kilometre, handling time per leg, the legal duty ceiling, and the depot-return radius guarantee. Use it when the driver asks how a figure was arrived at.',
    parameters: { type: 'object', properties: {} },
  },

  /* ── The loading bay ──────────────────────────────────────────────── */
  {
    name: 'get_loading_plan',
    description:
      'How the truck is packed for this tour: every item in load order, which end of the deck it sits on, whether it is stacked or turned, how long it takes to secure, and the reason it is placed there. Loading is in reverse drop order, so the first delivery is nearest the door.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'focus_load',
    description:
      'Highlight one item in the 3D loading bay so the viewer can see the piece being discussed. Pass the load id from get_loading_plan, or null to clear.',
    parameters: {
      type: 'object',
      properties: { loadId: num('Load id, or omit to clear the highlight.') },
    },
  },
  {
    name: 'set_load_treatment',
    description:
      'Change how one item is handled — the options come from that item\'s treatmentOptions in get_loading_plan. The bay re-packs and the securing time changes, which is a good way to show the plan is real and not a picture.',
    parameters: {
      type: 'object',
      properties: {
        loadId: num('Load id from get_loading_plan.'),
        treatment: str('One of that load\'s treatmentOptions, exactly as written.'),
      },
      required: ['loadId', 'treatment'],
    },
  },
];

/* ── Implementations ─────────────────────────────────────────────────── */

/**
 * The live insert inside a section, not the section's heading. Landing on the
 * heading is right for reading and wrong for a demo: the thing the agent just
 * did is then still below the fold, and the recording shows a title card while
 * the interesting part happens off screen.
 */
type SectionFocus = {
  selector: string;
  align: 'start' | 'center';
  nudge?: number;
};

const SECTION_FOCUS: Record<string, SectionFocus> = {
  // Centre the map itself in the usable viewport. A fixed offset made the
  // agent overshoot on shorter screens and hid the upper half of the map.
  lab: { selector: '.ops-canvas', align: 'center' },
  driver: { selector: '.phone', align: 'start', nudge: 40 },
};

function scrollToSection(section: HTMLElement, id: string) {
  const focus = SECTION_FOCUS[id];
  const target = focus ? section.querySelector<HTMLElement>(focus.selector) : null;
  if (!focus || !target) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // The masthead is sticky, so it eats the top of anything aligned to zero.
  const mast = document.querySelector('.zm-mast')?.getBoundingClientRect().height ?? 64;
  const viewportTop = mast + 12;
  const rect = target.getBoundingClientRect();
  const top =
    focus.align === 'center'
      ? window.scrollY + rect.top + rect.height / 2 - (viewportTop + window.innerHeight) / 2
      : window.scrollY + rect.top - viewportTop + (focus.nudge ?? 0);

  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Small helper so every tool that needs a solved tour fails the same way. */
function requireTour() {
  const snap = consoleHandle().snapshot();
  if (!snap.myTour) {
    return {
      error:
        snap.phase === 'running'
          ? 'The solver is still running. Wait a moment and try again.'
          : 'No tour has been solved yet. Set the trip up and call run_optimization first.',
      phase: snap.phase,
    } as const;
  }
  return { snap, tour: snap.myTour };
}

export const TOOLS: Record<string, (args: Record<string, unknown>) => ToolResult> = {
  navigate: ({ section }) => {
    const id = String(section);
    const el = document.getElementById(id);
    if (!el) return { error: `No section "${id}" on this page.` };
    scrollToSection(el, id);
    return { ok: true, section: id };
  },

  set_theme: ({ theme }) => {
    const next = theme === 'light' ? 'light' : 'dark';
    applyTheme(next);
    return { ok: true, theme: next };
  },

  find_location: ({ query }) => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return { error: 'Empty query.' };

    const scored: { id: string; label: string; city: string; kind: string; score: number }[] = [];

    for (const city of CITIES) {
      const hit = [city.ko, city.en.toLowerCase(), city.id].some(
        (field) => field.includes(q) || q.includes(field),
      );
      if (hit) {
        // A bare city name resolves to that city's busiest dock, which is what
        // the solver keys on. Keep the city id out of the answer entirely so
        // the model can't hand back something ambiguous.
        const primary = SITES.filter((s) => s.cityId === city.id).sort((a, b) => b.weight - a.weight)[0];
        if (primary) {
          scored.push({
            id: primary.id,
            label: siteLabel(primary.id),
            city: city.ko,
            kind: primary.kind,
            score: city.ko === q || city.en.toLowerCase() === q ? 3 : 2,
          });
        }
      }
    }

    for (const site of SITES) {
      if (!site.ko.toLowerCase().includes(q) && !q.includes(site.ko.toLowerCase())) continue;
      if (scored.some((s) => s.id === site.id)) continue;
      scored.push({
        id: site.id,
        label: siteLabel(site.id),
        city: cityOf(site.id).ko,
        kind: site.kind,
        score: site.ko.toLowerCase() === q ? 3 : 1,
      });
    }

    if (!scored.length) {
      return {
        matches: [],
        hint: 'Nothing matched. The network covers 30 cities — call list_cities and ask the driver to pick the nearest.',
      };
    }
    const matches = scored.sort((a, b) => b.score - a.score).slice(0, 6);
    return {
      matches: matches.map(({ score: _score, ...rest }) => rest),
      unambiguous: matches.length === 1,
    };
  },

  list_cities: () => ({
    cities: CITIES.map((c) => ({ id: c.id, ko: c.ko, en: c.en, docks: SITES.filter((s) => s.cityId === c.id).length })),
  }),

  get_trip_status: () => {
    if (!consoleReady()) return { error: 'The simulator is not mounted yet. navigate to "lab" first.' };
    const snap = consoleHandle().snapshot();
    const missing: string[] = [];
    if (!snap.trip.current) missing.push('current');
    if (!snap.trip.returnDepot) missing.push('returnDepot');
    return {
      trip: snap.trip,
      missing,
      ready: snap.tripReady,
      dirtySinceLastRun: snap.tripDirty,
      phase: snap.phase,
      scenario: snap.scenario,
      eligibleLoads: snap.eligibleLoads,
      candidateGoods: snap.candidateGoods,
      compatibilityNote: snap.compatibilityNote,
      hasResult: snap.optStats !== null,
    };
  },

  set_trip: (args) => {
    const patch: TripPatch = {};
    const known = new Set(
      SITES.map((s) => s.id).concat(CITIES.map((c) => c.id)),
    );

    for (const field of ['current', 'returnDepot'] as const) {
      const value = args[field];
      if (value === undefined) continue;
      const id = String(value);
      if (!known.has(id)) {
        return { error: `"${id}" is not a location id. Call find_location first and use the id it returns.` };
      }
      patch[field] = id;
    }
    for (const field of ['startHour', 'deadlineHour', 'maxDriveHours', 'truckTons'] as const) {
      const value = args[field];
      if (value === undefined) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: `${field} must be a number.` };
      patch[field] = n;
    }
    if (args.vehicleType !== undefined) {
      const v = String(args.vehicleType) as VehicleType;
      if (!VEHICLES.includes(v)) return { error: `vehicleType must be one of ${VEHICLES.join(', ')}.` };
      patch.vehicleType = v;
    }
    if (args.cargoType !== undefined) {
      const c = String(args.cargoType) as CargoCondition;
      if (!CARGO.includes(c)) return { error: `cargoType must be one of ${CARGO.join(', ')}.` };
      patch.cargoType = c;
    }

    const handle = consoleHandle();
    handle.setTrip(patch);
    const snap = handle.snapshot();
    const missing: string[] = [];
    if (!snap.trip.current) missing.push('current');
    if (!snap.trip.returnDepot) missing.push('returnDepot');
    return {
      applied: patch,
      // Read back rather than echo: the form repairs impossible vehicle/cargo
      // pairs, and the model has to see that it was overruled.
      trip: snap.trip,
      missing,
      ready: snap.tripReady,
      eligibleLoads: snap.eligibleLoads,
      compatibilityNote: snap.compatibilityNote,
    };
  },

  set_scenario: ({ scenario }) => {
    const handle = consoleHandle();
    handle.setScenario(String(scenario));
    return { ok: true, scenario: handle.snapshot().scenario };
  },

  run_optimization: () => {
    const handle = consoleHandle();
    const before = handle.snapshot();
    if (!before.tripReady) {
      const missing = [!before.trip.current && 'current location', !before.trip.returnDepot && 'return depot']
        .filter(Boolean)
        .join(' and ');
      return { error: `Cannot run yet — still missing the ${missing}. Ask the driver.` };
    }
    if (before.phase === 'running') return { error: 'A run is already in progress.' };
    if (before.eligibleLoads === 0) {
      return {
        error:
          'No load on the board fits this vehicle inside this day, so the run would come back empty. Suggest widening the hours, the tonnage or the cargo type.',
        trip: before.trip,
      };
    }
    handle.run();
    return {
      started: true,
      scenario: before.scenario,
      eligibleLoads: before.eligibleLoads,
      note: 'The annealer is searching now. Tell the driver it is running, then call get_result_summary.',
    };
  },

  reset_simulation: () => {
    consoleHandle().reset();
    return { ok: true };
  },

  get_result_summary: () => {
    const snap = consoleHandle().snapshot();
    if (snap.phase === 'running') {
      return { phase: 'running', progress: round(snap.progress * 100), note: 'Still searching — call again in a moment.' };
    }
    if (!snap.optStats) return { error: 'No run has finished yet.', phase: snap.phase };
    const { baseStats: b, optStats: o } = snap;
    return {
      phase: snap.phase,
      solveSeconds: round(snap.solveMs / 1000, 2),
      scenario: snap.scenario,
      emptyRunning: {
        beforePct: round(b.emptyRatio * 100),
        afterPct: round(o.emptyRatio * 100),
        deltaPct: round((o.emptyRatio - b.emptyRatio) * 100),
      },
      netPerDriverWon: { before: Math.round(b.avgNet), after: Math.round(o.avgNet), delta: Math.round(o.avgNet - b.avgNet) },
      loadsServed: { before: b.loadsServed, after: o.loadsServed, of: o.totalLoads },
      closedLoops: { before: b.closedLoops, after: o.closedLoops },
      co2Tons: { before: round(b.co2Tons), after: round(o.co2Tons) },
      totalKm: { before: Math.round(b.totalKm), after: Math.round(o.totalKm) },
      myTourSolved: snap.myTour !== null,
    };
  },

  get_my_tour: () => {
    const got = requireTour();
    if ('error' in got) return got;
    const { tour } = got;
    return {
      driver: tour.driverName,
      depot: tour.depot,
      legCount: tour.legs.length,
      legs: tour.legs,
      returnHomeKm: round(tour.returnKm),
      loadedKm: round(tour.loadedKm),
      emptyKm: round(tour.emptyKm),
      emptyPct: round(tour.emptyRatio * 100),
      dutyHours: round(tour.hours, 2),
      revenueWon: Math.round(tour.revenueWon),
      costWon: Math.round(tour.costWon),
      netWon: Math.round(tour.netWon),
    };
  },

  explain_leg: ({ index }) => {
    const got = requireTour();
    if ('error' in got) return got;
    const { tour } = got;
    const i = Number(index);
    const leg = tour.legs[i - 1];
    if (!leg) return { error: `This tour has ${tour.legs.length} legs; there is no leg ${i}.` };
    const legKm = leg.km + leg.deadheadKm;
    return {
      leg,
      of: tour.legs.length,
      costWon: Math.round(legKm * COST_WON_PER_KM),
      netWon: Math.round(leg.revenueWon - legKm * COST_WON_PER_KM),
      shareOfDayKmPct: round(((legKm) / (tour.loadedKm + tour.emptyKm)) * 100),
      shareOfDayPayPct: round((leg.revenueWon / tour.revenueWon) * 100),
      handlingHours: LEG_HANDLING_HOURS,
      note:
        leg.deadheadKm > 0
          ? `${round(leg.deadheadKm)}km of this leg is run empty to reach the pickup.`
          : 'This leg starts where the previous one dropped — no empty approach.',
    };
  },

  list_alternatives: () => {
    const snap = consoleHandle().snapshot();
    if (!snap.alternatives.length) {
      return { alternatives: [], note: 'The solver kept no runner-up for this driver.' };
    }
    return {
      chosenNetWon: snap.myTour ? Math.round(snap.myTour.netWon) : null,
      alternatives: snap.alternatives.map((t) => ({
        legCount: t.legs.length,
        route: t.legs.map((l) => `${l.from} → ${l.to}`),
        netWon: Math.round(t.netWon),
        emptyPct: round(t.emptyRatio * 100),
        dutyHours: round(t.hours, 2),
      })),
    };
  },

  compare_to_single_load: () => {
    const got = requireTour();
    if ('error' in got) return got;
    const { tour } = got;
    if (!tour.legs.length) return { error: 'This tour has no legs to compare.' };

    // The ordinary day: take the best-paying single load, run the empty
    // approach to it, then run home empty. The return leg is assumed equal to
    // the loaded distance — the standard 편도 후 공차 복귀 shape. Stated, not buried.
    const best = [...tour.legs].sort((a, b) => b.revenueWon - a.revenueWon)[0];
    const singleKm = best.deadheadKm + best.km * 2;
    const singleNet = best.revenueWon - singleKm * COST_WON_PER_KM;

    return {
      chained: {
        legs: tour.legs.length,
        km: round(tour.loadedKm + tour.emptyKm),
        emptyPct: round(tour.emptyRatio * 100),
        hours: round(tour.hours, 2),
        netWon: Math.round(tour.netWon),
      },
      singleLoad: {
        ref: best.ref,
        route: `${best.from} → ${best.to}`,
        km: round(singleKm),
        emptyPct: round(((best.deadheadKm + best.km) / singleKm) * 100),
        hours: round(best.hours + LEG_HANDLING_HOURS, 2),
        netWon: Math.round(singleNet),
      },
      differenceWon: Math.round(tour.netWon - singleNet),
      multiple: singleNet > 0 ? round(tour.netWon / singleNet, 2) : null,
      assumption:
        'The single-load day is priced as the best-paying load on this tour, driven with its empty approach and an empty run home of the same distance as the loaded leg.',
    };
  },

  get_economics: () => ({
    fuelWonPerKm: FUEL_WON_PER_KM,
    tollWonPerKm: TOLL_WON_PER_KM,
    totalCostWonPerKm: COST_WON_PER_KM,
    co2KgPerKm: CO2_KG_PER_KM,
    handlingHoursPerLeg: LEG_HANDLING_HOURS,
    maxDutyHours: MAX_DUTY_HOURS,
    maxLegs: MAX_LEGS,
    depotReturnRadiusKm: HOME_RADIUS_KM,
    routing: 'Every distance and drive time is real OSRM routing over OpenStreetMap, baked ahead of time across 30 cities and 75 docks. Nothing is estimated as the crow flies.',
  }),

  get_loading_plan: () => {
    const snap = consoleHandle().snapshot();
    if (!snap.loadingPlan.length) {
      return {
        error: 'Nothing is loaded yet — the bay fills in once a tour is solved.',
        phase: snap.phase,
      };
    }
    return {
      vehicle: `${snap.trip.truckTons}t ${snap.trip.vehicleType}`,
      cargoCondition: snap.trip.cargoType,
      totalTons: round(snap.totalLoadedTons, 2),
      capacityTons: snap.trip.truckTons,
      items: snap.loadingPlan,
      focusedLoadId: snap.focusedLoadId,
      note: 'loadOrder is the order pieces go on; unloadOrder is the order they come off. The first drop is loaded last so it sits by the door.',
    };
  },

  focus_load: ({ loadId }) => {
    const handle = consoleHandle();
    if (loadId === undefined || loadId === null) {
      handle.focusLoad(null);
      return { ok: true, focusedLoadId: null };
    }
    const id = Number(loadId);
    const snap = handle.snapshot();
    const item = snap.loadingPlan.find((i) => i.loadId === id);
    if (!item) return { error: `Load ${id} is not on this truck.` };
    handle.focusLoad(id);
    return { ok: true, focusedLoadId: id, item };
  },

  set_load_treatment: ({ loadId, treatment }) => {
    const handle = consoleHandle();
    const id = Number(loadId);
    const snap = handle.snapshot();
    const item = snap.loadingPlan.find((i) => i.loadId === id);
    if (!item) return { error: `Load ${id} is not on this truck.` };
    const choice = String(treatment);
    if (!item.treatmentOptions.includes(choice)) {
      return { error: `"${choice}" is not an option for this load.`, options: item.treatmentOptions };
    }
    handle.setLoadTreatment(id, choice);
    const after = handle.snapshot().loadingPlan.find((i) => i.loadId === id);
    return { ok: true, item: after ?? null };
  },
};

/** Runs one tool call, turning any throw into something the model can read. */
export function runTool(name: string, args: Record<string, unknown>): ToolResult {
  const fn = TOOLS[name];
  if (!fn) return { error: `No such tool: ${name}` };
  try {
    return fn(args ?? {});
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
