/**
 * The agent's control surface over the running demo.
 *
 * The simulator's state lives inside `DemoConsole` — presets, the trip form,
 * the annealer's phase, the solved fleet. Lifting all of that into `App` just
 * so a chat panel could reach it would be a large refactor of a component that
 * already works. So instead the console *registers* a handle here on mount:
 * a few imperative actions plus a snapshot getter. The agent's tools call
 * through this bus, and nothing else in the app has to change shape.
 *
 * Everything crossing this boundary is plain JSON. The snapshot is what gets
 * serialised into Gemini's context, so it has to stay small and readable —
 * labels, not ids, wherever a human would say a name.
 */

import { useEffect, useRef } from 'react';
import type { CargoCondition, VehicleType } from '../loading';

export type TripSnapshot = {
  current: string;
  currentLabel: string;
  returnDepot: string;
  returnDepotLabel: string;
  startHour: number;
  deadlineHour: number;
  maxDriveHours: number;
  truckTons: number;
  vehicleType: VehicleType;
  cargoType: CargoCondition;
};

export type LegSnapshot = {
  index: number;
  ref: string;
  from: string;
  to: string;
  fromBay: string;
  toBay: string;
  km: number;
  hours: number;
  tons: number;
  goods: string;
  revenueWon: number;
  deadheadKm: number;
};

export type TourSnapshot = {
  driverId: number;
  driverName: string;
  depot: string;
  legs: LegSnapshot[];
  returnKm: number;
  loadedKm: number;
  emptyKm: number;
  emptyRatio: number;
  hours: number;
  revenueWon: number;
  costWon: number;
  netWon: number;
};

export type StatsSnapshot = {
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

export type LoadingItemSnapshot = {
  loadId: number;
  ref: string;
  goods: string;
  tons: number;
  destination: string;
  loadOrder: number;
  unloadOrder: number;
  zone: string;
  deckSide: string;
  orientation: string;
  stacked: boolean;
  treatment: string;
  treatmentOptions: string[];
  secureMinutes: number;
  reason: string;
  dimensions: { lengthM: number; widthM: number; heightM: number };
};

export type ConsoleSnapshot = {
  /** 'idle' before a run, 'running' while the annealer works, 'done' after. */
  phase: 'idle' | 'running' | 'done';
  progress: number;
  solveMs: number;
  scenario: { id: string; label: string; loads: number; drivers: number; description: string };
  scenarioOptions: { id: string; label: string; description: string }[];
  /** What the trip form currently holds — may be half-filled. */
  trip: TripSnapshot;
  /** True once both locations are set and the run button is live. */
  tripReady: boolean;
  /** True when the form has moved since the last solve. */
  tripDirty: boolean;
  /** Loads this vehicle could legally carry that also fit the day. */
  eligibleLoads: number;
  candidateGoods: string[];
  compatibilityNote: string;
  baseStats: StatsSnapshot;
  optStats: StatsSnapshot | null;
  /** The driver's own tour — the one the phone and the 3D bay are showing. */
  myTour: TourSnapshot | null;
  /** Runner-up tours the solver kept, for "what else could I have run?". */
  alternatives: TourSnapshot[];
  loadingPlan: LoadingItemSnapshot[];
  focusedLoadId: number | null;
  totalLoadedTons: number;
};

export type TripPatch = Partial<{
  current: string;
  returnDepot: string;
  startHour: number;
  deadlineHour: number;
  maxDriveHours: number;
  truckTons: number;
  vehicleType: VehicleType;
  cargoType: CargoCondition;
}>;

export type ConsoleHandle = {
  snapshot: () => ConsoleSnapshot;
  setTrip: (patch: TripPatch) => void;
  run: () => void;
  reset: () => void;
  setScenario: (id: string) => void;
  focusLoad: (loadId: number | null) => void;
  setLoadTreatment: (loadId: number, treatment: string) => void;
};

let handle: ConsoleHandle | null = null;
const listeners = new Set<() => void>();

/** Thrown as a plain message so the tool layer can hand it back to the model. */
export const NOT_MOUNTED =
  'The simulator console is not on screen yet. Call navigate({ section: "lab" }) first, then retry.';

export function consoleHandle(): ConsoleHandle {
  if (!handle) throw new Error(NOT_MOUNTED);
  return handle;
}

export function consoleReady(): boolean {
  return handle !== null;
}

export function onConsoleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Register the live console. The handle is re-read from a ref on every call, so
 * the tools always see this render's closures without re-registering — and
 * without the identity churn that would cause.
 */
export function useAgentConsole(handle: ConsoleHandle) {
  const ref = useRef(handle);
  ref.current = handle;

  useEffect(() => {
    const stable: ConsoleHandle = {
      snapshot: () => ref.current.snapshot(),
      setTrip: (patch) => ref.current.setTrip(patch),
      run: () => ref.current.run(),
      reset: () => ref.current.reset(),
      setScenario: (id) => ref.current.setScenario(id),
      focusLoad: (id) => ref.current.focusLoad(id),
      setLoadTreatment: (id, treatment) => ref.current.setLoadTreatment(id, treatment),
    };
    setConsoleHandle(stable);
    return () => setConsoleHandle(null);
  }, []);
}

function setConsoleHandle(next: ConsoleHandle | null) {
  handle = next;
  listeners.forEach((fn) => fn());
}
