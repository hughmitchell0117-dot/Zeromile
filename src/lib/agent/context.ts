/**
 * The live state of the demo, rendered as text for the system instruction.
 *
 * This exists to buy back requests. Every tool round trip is a separate call
 * against a 15-per-minute ceiling, and the agent was burning most of them
 * *reading* — get_trip_status to see the form, get_result_summary to see the
 * run, get_my_tour to see the day. None of that is a decision; it is a page
 * the model could simply have been handed.
 *
 * So it is handed to it. This block is rebuilt on every request and injected
 * into the system instruction, which means it never enters the conversation
 * history, never goes stale, and costs tokens instead of round trips. Tools
 * are then only for *doing* things and for detail that isn't worth carrying
 * every turn.
 */

import { consoleHandle, consoleReady } from './bus';

const won = (value: number) => `${Math.round(value).toLocaleString('en-US')}원`;
const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
};

export function liveContext(): string {
  if (!consoleReady()) {
    return 'LIVE STATE: the simulator console is not mounted yet. Call navigate({section:"lab"}) before anything else.';
  }

  let snapshot;
  try {
    snapshot = consoleHandle().snapshot();
  } catch {
    return 'LIVE STATE: unavailable this turn.';
  }

  const { trip, myTour } = snapshot;
  const lines: string[] = [];

  lines.push(
    `Scenario: ${snapshot.scenario.label} — ${snapshot.scenario.loads} loads, ${snapshot.scenario.drivers} trucks.`,
  );

  lines.push(
    `Trip form: current=${trip.currentLabel || 'EMPTY'}${trip.current ? ` (${trip.current})` : ''}` +
      ` · depot=${trip.returnDepotLabel || 'EMPTY'}${trip.returnDepot ? ` (${trip.returnDepot})` : ''}` +
      ` · ${trip.startHour}시 출발, ${trip.deadlineHour}시 복귀, 최대 ${trip.maxDriveHours}시간 운전` +
      ` · ${trip.truckTons}t ${trip.vehicleType} · ${trip.cargoType}`,
  );

  lines.push(
    `Form ready to run: ${snapshot.tripReady ? 'yes' : `NO — missing ${[!trip.current && 'current location', !trip.returnDepot && 'return depot'].filter(Boolean).join(' and ')}`}` +
      ` · edited since last run: ${snapshot.tripDirty ? 'yes' : 'no'}` +
      ` · loads that qualify: ${snapshot.eligibleLoads}`,
  );

  lines.push(
    `Solver: ${snapshot.phase}${snapshot.phase === 'running' ? ` (${Math.round(snapshot.progress * 100)}%)` : ''}${
      snapshot.phase === 'done' ? ` in ${round(snapshot.solveMs / 1000, 2)}s` : ''
    }`,
  );

  if (snapshot.optStats) {
    const before = snapshot.baseStats;
    const after = snapshot.optStats;
    lines.push(
      `Fleet result: empty running ${round(before.emptyRatio * 100)}% → ${round(after.emptyRatio * 100)}%` +
        ` · net per driver ${won(before.avgNet)} → ${won(after.avgNet)}` +
        ` · loads served ${before.loadsServed} → ${after.loadsServed} of ${after.totalLoads}` +
        ` · closed loops ${before.closedLoops} → ${after.closedLoops}`,
    );
  }

  if (myTour) {
    lines.push(
      `This driver's tour: ${myTour.legs.length} legs · ${round(myTour.loadedKm)}km loaded, ${round(myTour.emptyKm)}km empty (${round(myTour.emptyRatio * 100)}%)` +
        ` · ${round(myTour.hours, 2)}h · revenue ${won(myTour.revenueWon)} − cost ${won(myTour.costWon)} = net ${won(myTour.netWon)}` +
        ` · home to ${myTour.depot}, last ${round(myTour.returnKm)}km empty.`,
    );
    for (const leg of myTour.legs) {
      lines.push(
        `  leg ${leg.index}: ${leg.from} → ${leg.to} · ${leg.goods} ${leg.tons}t` +
          ` · ${round(leg.km)}km, ${round(leg.hours, 2)}h · ${won(leg.revenueWon)}` +
          ` · ${leg.deadheadKm > 0 ? `${round(leg.deadheadKm)}km empty approach` : 'no empty approach'}` +
          ` · 운송장 ${leg.ref}, ${leg.fromBay} → ${leg.toBay}`,
      );
    }
  }

  if (snapshot.loadingPlan.length) {
    lines.push(
      `Loading bay: ${snapshot.loadingPlan.length} items, ${round(snapshot.totalLoadedTons, 2)}t total. ` +
        snapshot.loadingPlan
          .map((item) => `#${item.loadId} ${item.goods} ${item.tons}t (${item.zone}, ${item.treatment})`)
          .join(' · ') +
        '. Call get_loading_plan only if you need the placement reasons or the treatment options.',
    );
  }

  if (snapshot.alternatives.length) {
    lines.push(
      `Runner-up tours kept: ${snapshot.alternatives.length}. Call list_alternatives for their numbers.`,
    );
  }

  return `LIVE STATE — refreshed automatically before every one of your turns. Never call a tool merely to read something already written here.\n${lines.join('\n')}`;
}
