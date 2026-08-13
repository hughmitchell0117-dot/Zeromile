import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import KoreaMap from './KoreaMap';
import { useTheme } from '../lib/theme';
import { Check, Spark, useEased } from './ui';
import { CITIES } from '../lib/geo';
import { generateDrivers, generateLoads, generateRouteBridgeLoads } from '../lib/generate';
import { primarySite, SITE_BY_ID, SITES, siteLabel } from '../lib/sites';
import {
  HANDLING_HOURS,
  HOME_RADIUS_KM,
  driverStart,
  hrs,
  km,
  settle,
  summarise,
  won,
  wonShort,
  type Load,
  type Stats,
  type Tour,
} from '../lib/model';
import { TourOptimizer, buildBaseline, showcaseTour, type RouteLock } from '../lib/solver';
import { computeReach, dutyBudget } from '../lib/reach';
import { useAgentConsole, type ConsoleSnapshot, type TourSnapshot } from '../lib/agent/bus';
import {
  buildLoadingPlan,
  canCarryLoad,
  compatibilityNote,
  isCompatibleSelection,
  loadTreatmentOptions,
  type CargoCondition,
  type LoadingPlanItem,
  type VehicleType,
} from '../lib/loading';
import TruckLoadSimulator from './TruckLoadSimulator';

export const LOAD_COUNT = 400;

/** Well clear of any real driver id — see the `alternatives` memo. */
const OPTION_ID_BASE = 900_000;
export const DRIVER_COUNT = 170;

const PRESETS = [
  {
    id: 'quick',
    label: '빠른 검증',
    loads: 180,
    drivers: 80,
    budget: 650_000,
    seed: 20260811,
    description: '짧은 회의에서 구조를 확인하는 1초대 시나리오',
  },
  {
    id: 'standard',
    label: '표준 운영일',
    loads: LOAD_COUNT,
    drivers: DRIVER_COUNT,
    budget: 2_000_000,
    seed: 20260801,
    description: '전국 30개 도시의 일반적인 장거리 물동량 시나리오',
  },
  {
    id: 'dense',
    label: '고밀도 피크',
    loads: 650,
    drivers: 260,
    budget: 2_400_000,
    seed: 20260821,
    description: '연결 가능한 화물이 많은 주중 피크 시나리오',
  },
] as const;

export type DemoConfig = (typeof PRESETS)[number];

/**
 * Solve pacing. The preset's budget says how much work the run is; two knobs
 * decide how that work is spread over wall clock.
 *
 * A fixed slab of iterations per frame was the wrong ceiling. The same 12,000
 * moves are a 3ms frame on one board and a 40ms frame on another, so a heavy
 * scenario dropped frames while a light one wasted them, and the progress bar
 * advanced in lurches. So each frame's *ceiling* is as much work as this
 * machine measurably got through in `FRAME_COMPUTE_MS`.
 *
 * Flat out, though, a modern laptop finishes 650k moves in under a second: the
 * bar snapped to full before anyone could read a single stage label, and the
 * one part of the product that is visibly *thinking* went by in a blink. So
 * there is also a floor — the run is paced to `TARGET_SOLVE_MS`, handing out
 * only the work the schedule has earned so far. Nothing on screen is faked by
 * this: the moves counter, the elapsed clock, the temperature and the
 * convergence chart all report the real search. It is the same computation,
 * spread thin enough to watch. A machine too slow to hold the schedule simply
 * takes longer, exactly as it did before.
 */
const FRAME_COMPUTE_MS = 9;
/** Opening guess at throughput, in iterations per millisecond. */
const INITIAL_THROUGHPUT = 1_000;
/** Never hand the annealer so little that the run dies of overhead. */
const MIN_FRAME_ITERATIONS = 1_200;
/** How long a solve should take when the machine is fast enough to choose. */
const TARGET_SOLVE_MS = 5_400;

/**
 * Work released against elapsed time. Ease-out: the broad search that swings
 * the numbers gets the early seconds, convergence gets the long tail — which
 * is the half worth watching, and it keeps the bar moving to the very end
 * instead of stalling at 97%.
 */
function solveCurve(t: number): number {
  return 1 - Math.pow(1 - t, 2.2);
}

type Phase = 'idle' | 'running' | 'done';

export type RouteInput = {
  current: string;
  returnDepot: string;
  constraints: RouteConstraints;
};

type RouteConstraints = {
  startHour: number;
  deadlineHour: number;
  maxDriveHours: number;
  truckTons: number;
  vehicleType: VehicleType;
  cargoType: CargoCondition;
};

// Kakao yellow leads; the supporting hues stay saturated against the pale road network.
const ROUTE_COLORS = ['#FEE500', '#5BA9FF', '#35D39A', '#FF8B4A', '#B790FF', '#FF6B8A'];

/** One line in the live dispatch feed while the annealer runs. */
type FeedEvent = {
  id: number;
  kind: 'link' | 'gain' | 'phase';
  text: string;
  sub?: string;
  /** Net won gained this frame — used to pick the most interesting events. */
  gain?: number;
};

/**
 * One sampled frame of the solve, for the convergence chart. `p` is work done
 * (iterations against budget), `t` is milliseconds of wall clock since the run
 * started — the chart is plotted against `t`, so the trace sweeps at the speed
 * the solve is actually happening.
 */
export type SolvePoint = { p: number; t: number; empty: number; net: number };

export type MoveTally = Record<
  'insert' | 'remove' | 'relocate' | 'swap' | 'reorder',
  { proposed: number; accepted: number }
>;

/** Annealing narrative — surfaced in the feed as the temperature falls. */
const SOLVE_MILESTONES = [
  { at: 0.12, text: '고온 탐색 — 전 노선을 흔들어 봅니다', sub: '손해 보는 이동도 확률적으로 수용' },
  { at: 0.45, text: '온도 하강 — 이익 나는 연결만 남깁니다', sub: '체인 삽입·재배열 위주로 수렴' },
  { at: 0.8, text: '정밀 수렴 — 국소 최적화 구간', sub: '마지막 공차 킬로미터를 깎는 중' },
] as const;

/** The optimizer's cooling schedule, mirrored for display only. */
function annealTemp(progress: number): number {
  return 26_000 * Math.pow(220 / 26_000, Math.min(1, progress));
}

function solveStageLabel(progress: number): string {
  if (progress < 0.12) return '초기화';
  if (progress < 0.45) return '광역 탐색';
  if (progress < 0.8) return '연결 수렴';
  return '정밀 수렴';
}

/* ── Console layout ──────────────────────────────────────────────────────
   The console can be resized like an app window: its own edges and corners,
   plus the splitter between the planner rail and the stage. Sizes live in
   custom properties so a viewport media query can hand control back to the
   stylesheet on narrow screens without fighting inline styles.            */

/** Every independently sizable region of the console body. */
type Pane = 'planner' | 'rail' | 'kpi' | 'routes' | 'truck';

type Layout = {
  /** null = fill the container. Centred, so an edge drag counts double. */
  width: number | null;
  /** null = height follows content. */
  height: number | null;
} & Record<Pane, number>;

type EdgeMode = 'n' | 'w' | 'e' | 's' | 'ne' | 'nw' | 'se' | 'sw';
type GripMode = EdgeMode | Pane;

/** Grip modes that change height, and the sign the pointer delta carries. */
const HEIGHT_GRIPS: Partial<Record<GripMode, 1 | -1>> = {
  n: -1, ne: -1, nw: -1, s: 1, se: 1, sw: 1,
};
/** Grip modes that change width. West-side grips invert the delta. */
const WIDTH_GRIPS: Partial<Record<GripMode, 1 | -1>> = {
  e: 1, se: 1, ne: 1, w: -1, sw: -1, nw: -1,
};

/* One table drives every pane handle: which way it drags, whether the pointer
   delta grows or shrinks the pane, and how far it may go. `max` is a function
   because the two rails and the two stage bands trade space with the map, so
   their ceilings depend on the console's current size. */
const PANE_SPECS: Record<
  Pane,
  {
    axis: 'x' | 'y';
    sign: 1 | -1;
    min: number;
    max: (space: { mainWidth: number; stageHeight: number; layout: Layout }) => number;
    label: string;
  }
> = {
  planner: {
    axis: 'x',
    sign: 1,
    min: 288,
    max: ({ mainWidth, layout }) => mainWidth - MIN_MAP_WIDTH - MAIN_CHROME - layout.rail,
    label: '운행 조건 패널 너비',
  },
  rail: {
    axis: 'x',
    sign: -1,
    min: 300,
    max: ({ mainWidth, layout }) => mainWidth - MIN_MAP_WIDTH - MAIN_CHROME - layout.planner,
    label: '텔레메트리 패널 너비',
  },
  kpi: {
    axis: 'y',
    sign: 1,
    min: 112,
    max: ({ stageHeight, layout }) =>
      stageHeight - MIN_MAP_HEIGHT - STAGE_CHROME - layout.routes,
    label: '지표 카드 높이',
  },
  routes: {
    axis: 'y',
    sign: -1,
    min: 132,
    max: ({ stageHeight, layout }) =>
      stageHeight - MIN_MAP_HEIGHT - STAGE_CHROME - layout.kpi,
    label: '회차 후보 카드 높이',
  },
  truck: {
    axis: 'y',
    sign: 1,
    min: 168,
    max: () => 520,
    label: '3D 적재 뷰 높이',
  },
};

const PANES = Object.keys(PANE_SPECS) as Pane[];

const isPane = (mode: GripMode): mode is Pane => mode in PANE_SPECS;

const DEFAULT_LAYOUT: Layout = {
  width: null,
  height: null,
  planner: 344,
  rail: 352,
  kpi: 144,
  routes: 208,
  truck: 232,
};

const MIN_CONSOLE_WIDTH = 760;
const MIN_CONSOLE_HEIGHT = 560;
const MAX_CONSOLE_HEIGHT = 1400;
/* What the map window keeps for itself once both rails and both stage bands
   have taken their share — plus the fixed chrome those regions carry (card
   margins, stage gaps, the reserved control lanes), which the measured
   container sizes include but the pane sizes do not. */
const MIN_MAP_WIDTH = 380;
const MIN_MAP_HEIGHT = 180;
const MAIN_CHROME = 112;
const STAGE_CHROME = 66;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export type DemoResult = {
  baseStats: Stats;
  optStats: Stats | null;
  showcase: Tour | null;
  alternatives: Tour[];
  config: DemoConfig;
  route: RouteInput | null;
  /**
   * The solved fleet and the trace behind it. The methodology section draws
   * its charts from these — the same tours the map is showing, not a mock-up.
   */
  tours: Tour[];
  history: SolvePoint[];
  moves: MoveTally | null;
  solveMs: number;
};

export default function DemoConsole({
  onResult,
}: {
  onResult?: (r: DemoResult) => void;
}) {
  const { theme } = useTheme();
  const [presetId, setPresetId] = useState<DemoConfig['id']>('standard');
  const config = PRESETS.find((preset) => preset.id === presetId) ?? PRESETS[1];
  const [routeDraft, setRouteDraft] = useState<RouteInput>({
    current: '',
    returnDepot: '',
    constraints: {
      startHour: 6,
      deadlineHour: 20,
      maxDriveHours: 12,
      truckTons: 5,
      vehicleType: '윙바디',
      cargoType: '일반 화물',
    },
  });
  const [appliedRoute, setAppliedRoute] = useState<RouteInput | null>(null);
  const [recentLocations, setRecentLocations] = useState<string[]>(['seoul-0', 'icheon-0', 'busan-0']);
  const [locationStatus, setLocationStatus] = useState('');
  const [hoveredDriverId, setHoveredDriverId] = useState<number | null>(null);
  const [selectedMapLoadId, setSelectedMapLoadId] = useState<number | null>(null);
  const [loadOptions, setLoadOptions] = useState<Record<number, string>>({});
  const [registeredLoadIds, setRegisteredLoadIds] = useState<number[]>([]);
  const [pendingOptimize, setPendingOptimize] = useState(false);

  const { drivers, baseLoads, loads, baseline, baseStats, locked } = useMemo(() => {
    const baseLoads = generateLoads(config.loads, config.seed);
    let loads = baseLoads;
    const driverSeed = config.id === 'standard' ? 77001 : config.seed + 701;
    let drivers = generateDrivers(config.drivers, driverSeed);

    if (appliedRoute) {
      const startSite = primarySite(appliedRoute.current).id;
      const homeSite = primarySite(appliedRoute.returnDepot).id;
      const maxHours = Math.min(
        appliedRoute.constraints.maxDriveHours,
        appliedRoute.constraints.deadlineHour - appliedRoute.constraints.startHour,
      );
      loads = [
        ...baseLoads,
        ...generateRouteBridgeLoads({
          startSite,
          homeSite,
          maxHours,
          maxTons: appliedRoute.constraints.truckTons,
          goods: bridgeGoods(appliedRoute.constraints.cargoType),
          idStart: baseLoads.length,
          seed: config.seed,
        }),
      ];
      drivers = [
        {
          ...drivers[0],
          home: primarySite(appliedRoute.returnDepot).cityId,
          depot: primarySite(appliedRoute.returnDepot).id,
          current: appliedRoute.current,
          name: '내 차량',
        },
        ...drivers.slice(1),
      ];
    }

    let baseline = buildBaseline(drivers, loads);
    let locked: RouteLock | null = null;

    if (appliedRoute) {
      const startSite = primarySite(appliedRoute.current).id;
      const homeSite = primarySite(appliedRoute.returnDepot).id;
      const maxHours = Math.min(
        appliedRoute.constraints.maxDriveHours,
        appliedRoute.constraints.deadlineHour - appliedRoute.constraints.startHour,
      );
      // The user's vehicle starts with an empty slate. Its route is the answer,
      // rather than an arbitrary baseline load that the solver must decorate.
      baseline = baseline.map((tour) =>
        tour.driver.id === drivers[0].id ? settle(tour.driver, []) : tour,
      );
      locked = {
        loadIds: [],
        driverId: drivers[0].id,
        seedLoadIds: loads.slice(baseLoads.length).map((load) => load.id),
        maxHours,
        maxTons: appliedRoute.constraints.truckTons,
        maxKm: routeCorridorBudgetKm(startSite, homeSite, maxHours),
        minLegs: Math.max(1, loads.length - baseLoads.length),
        allowedLoadIds: loads
          .filter((load) =>
            canCarryLoad(
              load,
              appliedRoute.constraints.vehicleType,
              appliedRoute.constraints.cargoType,
            ) && isRouteRelevant(load, startSite, homeSite, maxHours),
          )
          .map((load) => load.id),
      };
    }

    return {
      drivers,
      baseLoads,
      loads,
      baseline,
      locked,
      baseStats: summarise(baseline, loads.length),
    };
  }, [config, appliedRoute]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [tours, setTours] = useState<Tour[]>(baseline);
  /** Distinct days the beam found for the driver's own vehicle, best first. */
  const [routeOptions, setRouteOptions] = useState<Tour[]>([]);
  /** Stage overlays folded away so the map is unobstructed. */
  const [mapFocus, setMapFocus] = useState(false);
  /** The route summary over the map, collapsed to its header. */
  const [noteOpen, setNoteOpen] = useState(true);
  const [version, setVersion] = useState(0);
  const [stats, setStats] = useState<Stats>(baseStats);
  const [progress, setProgress] = useState(0);
  /** Wall-clock milliseconds the current (or last) solve has taken. */
  const [solveMs, setSolveMs] = useState(0);
  const [selectedDriverIds, setSelectedDriverIds] = useState<number[]>([]);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [history, setHistory] = useState<SolvePoint[]>([]);
  const [detailDriverId, setDetailDriverId] = useState<number | null>(null);

  const optRef = useRef<TourOptimizer | null>(null);
  const rafRef = useRef(0);
  /** Per-driver {legs, net} from the previous frame, for diffing feed events. */
  const sigRef = useRef<Map<number, { legs: number; net: number }>>(new Map());
  const feedIdRef = useRef(0);
  const milestoneRef = useRef(0);

  const showcase = useMemo(
    () => (phase === 'done' ? showcaseTour(tours) : null),
    [phase, tours],
  );

  /**
   * The days on offer. Every one is the *same* truck — the driver is choosing
   * between ways to spend their own shift, not between vehicles — but selection,
   * route colour, hover and the map's highlight layer are all keyed by driver
   * id, so each option carries a synthetic one. Index 0 is the tour actually
   * applied to the fleet by `finalizeLockedRoute`.
   */
  const alternatives = useMemo(
    () => {
      if (phase !== 'done' || !appliedRoute) return [];
      return routeOptions
        .filter(
          (tour) =>
            tour.legs.length >= (locked?.minLegs ?? 1) && tour.returnKm <= HOME_RADIUS_KM,
        )
        .map((tour, index) => ({
          ...tour,
          driver: { ...tour.driver, id: OPTION_ID_BASE + index },
        }));
    },
    [phase, appliedRoute, routeOptions, locked],
  );

  const selectedTours = useMemo(
    () => alternatives.filter((tour) => selectedDriverIds.includes(tour.driver.id)),
    [alternatives, selectedDriverIds],
  );

  /**
   * How much freight the solver was actually allowed to touch — the same filter
   * that builds `locked.allowedLoadIds`, so it reports the size of the slate the
   * annealer got. When the stage comes back empty this is what separates "your
   * vehicle can't carry any of this" from "it could, but nothing chained into a
   * tour that gets you home". Keyed off the applied route, not the draft: it has
   * to describe the run that happened, not the one being typed.
   */
  const eligibleLoadCount = useMemo(() => {
    if (!appliedRoute) return 0;
    const startSite = primarySite(appliedRoute.current).id;
    const homeSite = primarySite(appliedRoute.returnDepot).id;
    const maxHours = Math.min(
      appliedRoute.constraints.maxDriveHours,
      appliedRoute.constraints.deadlineHour - appliedRoute.constraints.startHour,
    );
    return loads.filter(
      (load) =>
        canCarryLoad(
          load,
          appliedRoute.constraints.vehicleType,
          appliedRoute.constraints.cargoType,
        ) && isRouteRelevant(load, startSite, homeSite, maxHours),
    ).length;
  }, [appliedRoute, loads]);

  useEffect(() => {
    if (phase === 'done' && onResult) {
      onResult({
        baseStats,
        optStats: stats,
        showcase,
        alternatives,
        config,
        route: appliedRoute,
        tours,
        history,
        moves: optRef.current ? { ...optRef.current.moves } : null,
        solveMs,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, showcase]);

  const optimize = useCallback(() => {
    if (phase === 'running') return;
    const opt = new TourOptimizer(drivers, loads, baseline, config.budget, locked);
    optRef.current = opt;
    setPhase('running');
    setSelectedDriverIds([]);
    setRouteOptions([]);
    setDetailDriverId(null);
    setSelectedMapLoadId(null);
    setLoadOptions({});
    setRegisteredLoadIds([]);

    sigRef.current = new Map(
      baseline.map((t) => [t.driver.id, { legs: t.legs.length, net: t.net }]),
    );
    feedIdRef.current = 0;
    milestoneRef.current = 0;
    setFeed([
      {
        id: ++feedIdRef.current,
        kind: 'phase',
        text: '탐색 시작',
        sub: `화물 ${loads.length}건 · 차량 ${drivers.length}대 · ${(config.budget / 1000).toFixed(0)}k 이동 예산`,
      },
    ]);
    setHistory([{ p: 0, t: 0, empty: baseStats.emptyRatio, net: baseStats.avgNet }]);
    setSolveMs(0);

    // Interesting moves accumulate here and flush a few times a second —
    // emitting at 60fps would scroll the feed faster than anyone can read.
    let pending: FeedEvent[] = [];
    let frame = 0;
    const startedAt = performance.now();
    let throughput = INITIAL_THROUGHPUT;

    const step = () => {
      const frameStart = performance.now();

      // Ceiling: as much as this machine got through last frame, no more. The
      // frame rate is still the hard constraint on a slow board.
      const ceiling = Math.max(
        MIN_FRAME_ITERATIONS,
        Math.round(throughput * FRAME_COMPUTE_MS),
      );

      // Floor the run at TARGET_SOLVE_MS by handing out only the work this
      // moment of the schedule has earned. `solveCurve` front-loads it, which
      // is also how annealing behaves — the wide search that moves the numbers
      // happens early, and convergence is the part worth watching slowly.
      const elapsed = frameStart - startedAt;
      const earned =
        solveCurve(Math.min(1, elapsed / TARGET_SOLVE_MS)) * config.budget -
        opt.iterations;
      const chunk = Math.max(1, Math.min(ceiling, Math.round(earned)));

      opt.run(chunk);

      // Measured, not assumed. One EWMA so a single janky frame (a GC pause, a
      // map tile decode) doesn't reset the pacing. Only frames that actually
      // hit the ceiling measure throughput — a paced frame finishes early by
      // design, and reading that as "this machine got slower" would ratchet the
      // ceiling down until a slow board could never catch up.
      const spent = performance.now() - frameStart;
      if (chunk >= ceiling && spent > 0.4) {
        throughput = throughput * 0.7 + (chunk / spent) * 0.3;
      }

      frame++;
      const frameStats = summarise(opt.tours, loads.length);

      // Diff every tour against the previous frame and narrate the best moves.
      for (const tour of opt.tours) {
        const prev = sigRef.current.get(tour.driver.id);
        if (prev) {
          const gain = tour.net - prev.net;
          if (tour.legs.length > prev.legs && tour.legs.length >= 2) {
            pending.push({
              id: ++feedIdRef.current,
              kind: 'link',
              gain,
              text: `${tour.driver.name} · ${chainLabel(tour)}`,
              sub: `${tour.legs.length}구간 체인 연결 · 실수령 ${wonShort(tour.net)}`,
            });
          } else if (tour.legs.length === prev.legs && tour.legs.length > 0 && gain > 150_000) {
            pending.push({
              id: ++feedIdRef.current,
              kind: 'gain',
              gain,
              text: `${tour.driver.name} · 경로 재배열`,
              sub: `공차 절감 +${wonShort(gain)}`,
            });
          }
        }
        sigRef.current.set(tour.driver.id, { legs: tour.legs.length, net: tour.net });
      }

      const picked: FeedEvent[] = [];
      while (
        milestoneRef.current < SOLVE_MILESTONES.length &&
        opt.progress >= SOLVE_MILESTONES[milestoneRef.current].at
      ) {
        const milestone = SOLVE_MILESTONES[milestoneRef.current++];
        picked.push({
          id: ++feedIdRef.current,
          kind: 'phase',
          text: milestone.text,
          sub: milestone.sub,
        });
      }
      if (frame % 5 === 0 || opt.done || picked.length) {
        picked.push(
          ...pending.sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0)).slice(0, 2),
        );
        pending = [];
      }
      if (picked.length) setFeed((f) => [...picked, ...f].slice(0, 28));

      setTours(opt.tours);
      setVersion((v) => v + 1);
      setStats(frameStats);
      setProgress(opt.progress);
      const now = performance.now() - startedAt;
      setSolveMs(now);
      setHistory((h) => [
        ...h,
        { p: opt.progress, t: now, empty: frameStats.emptyRatio, net: frameStats.avgNet },
      ]);

      if (opt.done) {
        // The beam that finalises the route is part of the solve, so its cost
        // belongs in the number on screen.
        opt.finalizeLockedRoute();
        setSolveMs(performance.now() - startedAt);
        const finalStats = summarise(opt.tours, loads.length);
        setTours([...opt.tours]);
        setRouteOptions(opt.lockedAlternatives);
        setStats(finalStats);
        setVersion((v) => v + 1);
        setFeed((f) =>
          [
            {
              id: ++feedIdRef.current,
              kind: 'phase' as const,
              text: '수렴 완료',
              sub: `공차율 ${(baseStats.emptyRatio * 100).toFixed(1)}% → ${(finalStats.emptyRatio * 100).toFixed(1)}% · ${(
                (performance.now() - startedAt) / 1000
              ).toFixed(1)}초`,
            },
            ...f,
          ].slice(0, 28),
        );
        setPhase('done');
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [phase, drivers, loads, baseline, baseStats, config.budget, locked]);

  const reset = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    optRef.current = null;
    setPhase('idle');
    setSelectedDriverIds([]);
    setRouteOptions([]);
    setDetailDriverId(null);
    setSelectedMapLoadId(null);
    setLoadOptions({});
    setRegisteredLoadIds([]);
    setFeed([]);
    setHistory([]);
    setTours(baseline);
    setStats(baseStats);
    setProgress(0);
    setSolveMs(0);
    setVersion((v) => v + 1);
  }, [baseline, baseStats]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    optRef.current = null;
    setPhase('idle');
    setSelectedDriverIds([]);
    setRouteOptions([]);
    setDetailDriverId(null);
    setSelectedMapLoadId(null);
    setLoadOptions({});
    setRegisteredLoadIds([]);
    setFeed([]);
    setHistory([]);
    setTours(baseline);
    setStats(baseStats);
    setProgress(0);
    setSolveMs(0);
    setVersion((v) => v + 1);
    onResult?.({
      baseStats,
      optStats: null,
      showcase: null,
      alternatives: [],
      tours: [],
      history: [],
      moves: null,
      solveMs: 0,
      config,
      route: appliedRoute,
    });
  }, [baseline, baseStats, config, appliedRoute, onResult]);

  useEffect(() => {
    if (phase !== 'done' || alternatives.length === 0) return;
    // Option 1 is the one the solver actually applied, so it is the one already
    // drawn on the map when the run lands.
    setSelectedDriverIds([alternatives[0].driver.id]);
  }, [phase, alternatives]);

  const emptyPct = useEased(stats.emptyRatio * 100);
  const netAvg = useEased(stats.avgNet);
  const perHour = useEased(stats.avgNet / Math.max(1, stats.avgHours));
  const served = useEased(stats.loadsServed);
  const closed = useEased(stats.closedLoops);
  const co2Saved = useEased(Math.max(0, baseStats.co2Tons - stats.co2Tons));

  const improving = phase !== 'idle';
  const ratioColour =
    emptyPct > 30 ? 'var(--empty)' : emptyPct > 20 ? 'var(--gold)' : 'var(--green)';

  const routeChanged = !appliedRoute || JSON.stringify(appliedRoute) !== JSON.stringify(routeDraft);
  const hasRouteInput = Boolean(routeDraft.current && routeDraft.returnDepot);
  const mapHighlights =
    phase === 'idle' && appliedRoute ? [baseline[0]] : selectedTours;
  const loadingTour =
    phase === 'done'
      ? alternatives.find((tour) => tour.driver.id === (hoveredDriverId ?? selectedDriverIds[0])) ??
        alternatives[0] ??
        null
      : null;
  const displayedRoute = selectedTours[0] ?? loadingTour;
  const loadingPlan = loadingTour ? buildLoadingPlan(loadingTour, ko, loadOptions) : [];
  const loadingTourKey = loadingTour
    ? `${loadingTour.driver.id}:${loadingTour.legs.map((leg) => leg.load.id).join('-')}`
    : '';
  const modelTour = useMemo(
    () =>
      loadingTour
        ? {
            ...loadingTour,
            legs: loadingTour.legs.filter((leg) => registeredLoadIds.includes(leg.load.id)),
          }
        : null,
    [loadingTour, registeredLoadIds],
  );

  useEffect(() => {
    setRegisteredLoadIds([]);
  }, [loadingTourKey]);

  /**
   * The envelope the map floods during the solve. It's a function of exactly
   * the driver's three inputs, so while the console is idle it tracks the draft
   * live — moving a slider moves the envelope. Once a solve is under way it
   * pins to the applied route, so the flood is showing the same day the
   * annealer is actually working on.
   */
  const reachInput = phase === 'idle' ? routeDraft : (appliedRoute ?? routeDraft);
  const mapReach = useMemo(() => {
    if (!reachInput.current || !reachInput.returnDepot) return null;
    const { startHour, deadlineHour, maxDriveHours } = reachInput.constraints;
    return computeReach({
      current: reachInput.current,
      garage: reachInput.returnDepot,
      budgetHours: dutyBudget(startHour, deadlineHour, maxDriveHours),
    });
  }, [reachInput]);

  const recommendedLoads = useMemo(
    () => {
      if (!routeDraft.current || !routeDraft.returnDepot) return [];
      const startSite = primarySite(routeDraft.current).id;
      const homeSite = primarySite(routeDraft.returnDepot).id;
      const maxHours = Math.min(
        routeDraft.constraints.maxDriveHours,
        routeDraft.constraints.deadlineHour - routeDraft.constraints.startHour,
      );
      const previewLoads = [
        ...baseLoads,
        ...generateRouteBridgeLoads({
          startSite,
          homeSite,
          maxHours,
          maxTons: routeDraft.constraints.truckTons,
          goods: bridgeGoods(routeDraft.constraints.cargoType),
          idStart: baseLoads.length,
          seed: config.seed,
        }),
      ];
      return previewLoads.filter(
        (load) =>
          canCarryLoad(
            load,
            routeDraft.constraints.vehicleType,
            routeDraft.constraints.cargoType,
          ) && isRouteRelevant(load, startSite, homeSite, maxHours),
      );
    },
    [baseLoads, config.seed, routeDraft],
  );
  const recommendedGoods = [...new Set(recommendedLoads.map((load) => load.goods))].slice(0, 3);
  const selectedLoadingItem = loadingPlan.find(
    (item) => item.load.id === selectedMapLoadId,
  ) ?? null;
  const registerLoad = useCallback((loadId: number, option: string) => {
    setLoadOptions((current) => ({ ...current, [loadId]: option }));
    setRegisteredLoadIds((current) =>
      current.includes(loadId) ? current : [...current, loadId],
    );
  }, []);

  const runOptimization = useCallback(() => {
    if (phase === 'running' || !hasRouteInput) return;
    if (routeChanged) {
      setPendingOptimize(true);
      setAppliedRoute(cloneRoute(routeDraft));
      return;
    }
    optimize();
  }, [phase, hasRouteInput, routeChanged, routeDraft, optimize]);

  useEffect(() => {
    if (!pendingOptimize || phase !== 'idle' || !appliedRoute) return;
    if (JSON.stringify(appliedRoute) !== JSON.stringify(routeDraft)) return;
    setPendingOptimize(false);
    optimize();
  }, [pendingOptimize, phase, appliedRoute, routeDraft, optimize]);

  /*
   * The agent's window into this console. It reads the same state the UI
   * renders and calls the same handlers the buttons call — so anything the
   * agent does is a thing a person could have done by hand, and the screen
   * updates for exactly the same reason.
   */
  useAgentConsole({
    snapshot: (): ConsoleSnapshot => {
      const myTour = displayedRoute ?? showcase ?? null;
      return {
        phase,
        progress,
        solveMs,
        scenario: {
          id: config.id,
          label: config.label,
          loads: config.loads,
          drivers: config.drivers,
          description: config.description,
        },
        scenarioOptions: PRESETS.map((preset) => ({
          id: preset.id,
          label: preset.label,
          description: preset.description,
        })),
        trip: {
          current: routeDraft.current,
          currentLabel: routeDraft.current ? siteLabel(primarySite(routeDraft.current).id) : '',
          returnDepot: routeDraft.returnDepot,
          returnDepotLabel: routeDraft.returnDepot
            ? siteLabel(primarySite(routeDraft.returnDepot).id)
            : '',
          ...routeDraft.constraints,
        },
        tripReady: hasRouteInput,
        tripDirty: routeChanged,
        eligibleLoads: appliedRoute && !routeChanged ? eligibleLoadCount : recommendedLoads.length,
        candidateGoods: recommendedGoods,
        compatibilityNote: compatibilityNote(
          routeDraft.constraints.vehicleType,
          routeDraft.constraints.cargoType,
        ),
        baseStats,
        optStats: phase === 'done' ? stats : null,
        myTour: myTour ? tourSnapshot(myTour) : null,
        alternatives: alternatives
          .filter((tour) => tour.driver.id !== myTour?.driver.id)
          .slice(0, 4)
          .map(tourSnapshot),
        loadingPlan: loadingPlan.map((item) => ({
          loadId: item.load.id,
          ref: item.load.ref,
          goods: item.load.goods,
          tons: item.load.tons,
          destination: item.destination,
          loadOrder: item.loadOrder,
          unloadOrder: item.unloadOrder,
          zone: item.zone,
          deckSide: item.deckSide,
          orientation: item.orientation,
          stacked: item.stacked,
          treatment: item.selectedOption,
          treatmentOptions: loadTreatmentOptions(item.load),
          secureMinutes: item.secureMinutes,
          reason: item.placementReason,
          dimensions: item.dimensions,
        })),
        focusedLoadId: selectedMapLoadId,
        totalLoadedTons: loadingPlan.reduce((sum, item) => sum + item.load.tons, 0),
      };
    },
    setTrip: (patch) => {
      if (patch.current !== undefined) updateLocation('current', patch.current);
      if (patch.returnDepot !== undefined) updateLocation('returnDepot', patch.returnDepot);
      // One field at a time, through the same setter the form uses, so the
      // vehicle/cargo repair rules apply to the agent exactly as they do to a tap.
      if (patch.startHour !== undefined) updateConstraint('startHour', patch.startHour);
      if (patch.deadlineHour !== undefined) updateConstraint('deadlineHour', patch.deadlineHour);
      if (patch.maxDriveHours !== undefined) updateConstraint('maxDriveHours', patch.maxDriveHours);
      if (patch.truckTons !== undefined) updateConstraint('truckTons', patch.truckTons);
      if (patch.vehicleType !== undefined) updateConstraint('vehicleType', patch.vehicleType);
      if (patch.cargoType !== undefined) updateConstraint('cargoType', patch.cargoType);
    },
    run: runOptimization,
    reset,
    setScenario: (id) => {
      const preset = PRESETS.find((option) => option.id === id);
      if (preset) setPresetId(preset.id);
    },
    focusLoad: setSelectedMapLoadId,
    setLoadTreatment: (loadId, treatment) => registerLoad(loadId, treatment),
  });

  const statusTone =
    phase === 'running' ? 'busy' : phase === 'done' ? 'ok' : appliedRoute && !routeChanged ? 'set' : '';
  const statusLabel =
    phase === 'running'
      ? '최적화 실행 중'
      : phase === 'done'
        ? '최적화 완료'
        : appliedRoute && !routeChanged
          ? '내 조건 적용됨'
          : '입력 대기';

  const rememberLocation = (cityId: string) => {
    setRecentLocations((recent) => [cityId, ...recent.filter((id) => id !== cityId)].slice(0, 4));
  };

  const updateLocation = (field: 'current' | 'returnDepot', value: string) => {
    rememberLocation(value);
    setRouteDraft((current) => {
      if (field === 'returnDepot') return { ...current, returnDepot: value };
      // A day is out-and-back until the driver says otherwise. While the garage
      // is still tied to the start, moving the start moves it too — so the
      // default plan is a closed loop and not a one-way run that happens to end
      // wherever the last drop was.
      const tied = !current.returnDepot || current.returnDepot === current.current;
      return { ...current, current: value, ...(tied ? { returnDepot: value } : {}) };
    });
  };

  const updateConstraint = <K extends keyof RouteConstraints>(
    field: K,
    value: RouteConstraints[K],
  ) => {
    setRouteDraft((current) => {
      const next = { ...current.constraints, [field]: value };
      // Cold work is a closed pair: either half implies the other.
      if (field === 'vehicleType' && value === '냉장탑차') next.cargoType = '냉장·냉동';
      if (field === 'cargoType' && value === '냉장·냉동') next.vehicleType = '냉장탑차';
      // Any pair `canCarryLoad` rejects outright — 카고 with 취급주의 or with
      // 냉장·냉동 — matches zero freight, so the solver returns a driver with no
      // legs and the whole stage goes blank with no stated reason. Repair it on
      // the axis the driver did *not* just touch, so their choice always wins.
      if (!isCompatibleSelection(next.vehicleType, next.cargoType)) {
        if (field === 'cargoType') next.vehicleType = '윙바디';
        else next.cargoType = '일반 화물';
      }
      return { ...current, constraints: next };
    });
  };

  const detectLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('이 기기에서는 위치 확인을 지원하지 않습니다.');
      return;
    }
    setLocationStatus('현재 위치 확인 중…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const nearest = nearestLocation(coords.latitude, coords.longitude);
        updateLocation('current', nearest.id);
        setLocationStatus(`${siteLabel(nearest.id)} 인근으로 설정됨`);
      },
      () => setLocationStatus('위치 권한을 허용하면 자동 설정할 수 있습니다.'),
      { enableHighAccuracy: false, timeout: 6000 },
    );
  };

  const toggleTour = (driverId: number) => {
    setSelectedDriverIds((selected) =>
      selected.includes(driverId)
        ? selected.filter((id) => id !== driverId)
        : [...selected, driverId],
    );
  };

  /* ── Resizing ──────────────────────────────────────────────────────── */

  const opsRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [gripMode, setGripMode] = useState<GripMode | null>(null);
  const dragRef = useRef<{
    mode: GripMode;
    x: number;
    y: number;
    width: number;
    height: number;
    from: number;
    maxWidth: number;
    space: { mainWidth: number; stageHeight: number; layout: Layout };
  } | null>(null);

  const resized =
    layout.width !== null ||
    layout.height !== null ||
    PANES.some((pane) => layout[pane] !== DEFAULT_LAYOUT[pane]);

  /** Room the pane handles are negotiating over, measured at drag start. */
  const measureSpace = (host: HTMLElement, current: Layout) => {
    const main = host.querySelector('.ops-main');
    const stage = host.querySelector('.ops-stage');
    return {
      mainWidth: main ? main.getBoundingClientRect().width : host.clientWidth,
      stageHeight: stage ? stage.getBoundingClientRect().height : host.clientHeight,
      layout: current,
    };
  };

  const paneBounds = (pane: Pane, space: { mainWidth: number; stageHeight: number; layout: Layout }) => {
    const spec = PANE_SPECS[pane];
    return { min: spec.min, max: Math.max(spec.min, spec.max(space)) };
  };

  const beginGrip = (mode: GripMode) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = opsRef.current;
    if (!host || event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer already released; the move/up handlers still work without it.
    }
    event.preventDefault();
    dragRef.current = {
      mode,
      x: event.clientX,
      y: event.clientY,
      width: rect.width,
      height: rect.height,
      from: isPane(mode) ? layout[mode] : 0,
      /* The console breaks out of the page wrap, so the viewport — not the
         wrap — is what caps how wide it can be dragged. */
      maxWidth: Math.max(
        host.parentElement?.clientWidth ?? rect.width,
        document.documentElement.clientWidth - 48,
      ),
      space: measureSpace(host, layout),
    };
    setGripMode(mode);
  };

  const moveGrip = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    setLayout((prev) => {
      const next = { ...prev };
      if (isPane(drag.mode)) {
        const spec = PANE_SPECS[drag.mode];
        const { min, max } = paneBounds(drag.mode, drag.space);
        const delta = (spec.axis === 'x' ? dx : dy) * spec.sign;
        next[drag.mode] = Math.round(clamp(drag.from + delta, min, max));
        return next;
      }
      // The console is centre-aligned, so one edge moves both sides.
      const wSign = WIDTH_GRIPS[drag.mode];
      if (wSign) {
        next.width = Math.round(
          clamp(drag.width + dx * wSign * 2, MIN_CONSOLE_WIDTH, drag.maxWidth),
        );
      }
      const hSign = HEIGHT_GRIPS[drag.mode];
      if (hSign) {
        next.height = Math.round(
          clamp(drag.height + dy * hSign, MIN_CONSOLE_HEIGHT, MAX_CONSOLE_HEIGHT),
        );
      }
      return next;
    });
  };

  const endGrip = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setGripMode(null);
  };

  /** Double-click resets only what that handle controls. */
  const resetGrip = (mode: GripMode) => () => {
    setLayout((prev) =>
      isPane(mode)
        ? { ...prev, [mode]: DEFAULT_LAYOUT[mode] }
        : {
            ...prev,
            width: WIDTH_GRIPS[mode] ? DEFAULT_LAYOUT.width : prev.width,
            height: HEIGHT_GRIPS[mode] ? DEFAULT_LAYOUT.height : prev.height,
          },
    );
  };

  /** Arrow keys nudge a focused handle along its own axis; Home resets it. */
  const nudgePane = (pane: Pane) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    const spec = PANE_SPECS[pane];
    const step = event.shiftKey ? 48 : 16;
    const back = spec.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forward = spec.axis === 'x' ? 'ArrowRight' : 'ArrowDown';

    if (event.key === 'Home') {
      event.preventDefault();
      setLayout((prev) => ({ ...prev, [pane]: DEFAULT_LAYOUT[pane] }));
      return;
    }
    if (event.key !== back && event.key !== forward) return;

    event.preventDefault();
    const host = opsRef.current;
    setLayout((prev) => {
      const space = host
        ? measureSpace(host, prev)
        : { mainWidth: MIN_CONSOLE_WIDTH, stageHeight: MIN_CONSOLE_HEIGHT, layout: prev };
      const { min, max } = paneBounds(pane, space);
      const delta = (event.key === back ? -step : step) * spec.sign;
      return { ...prev, [pane]: Math.round(clamp(prev[pane] + delta, min, max)) };
    });
  };

  const gripHandlers = (mode: GripMode) => ({
    onPointerDown: beginGrip(mode),
    onPointerMove: moveGrip,
    onPointerUp: endGrip,
    onPointerCancel: endGrip,
    onDoubleClick: resetGrip(mode),
  });

  /** Shared props for a pane handle: drag, keyboard, and the a11y contract. */
  const paneGrip = (pane: Pane) => {
    const spec = PANE_SPECS[pane];
    return {
      className: `pane-grip ${spec.axis} g-${pane}${gripMode === pane ? ' on' : ''}`,
      role: 'separator' as const,
      'aria-orientation': (spec.axis === 'x' ? 'vertical' : 'horizontal') as
        | 'vertical'
        | 'horizontal',
      'aria-label': spec.label,
      'aria-valuenow': layout[pane],
      'aria-valuemin': spec.min,
      tabIndex: 0,
      title: `${spec.label} · 더블클릭 초기화`,
      onKeyDown: nudgePane(pane),
      ...gripHandlers(pane),
    };
  };

  const opsStyle = {
    '--planner-w': `${layout.planner}px`,
    '--ops-rail': `${layout.rail}px`,
    '--kpi-h': `${layout.kpi}px`,
    '--routes-h': `${layout.routes}px`,
    '--truck-h': `${layout.truck}px`,
    ...(layout.width !== null ? { '--ops-w': `${layout.width}px` } : {}),
    ...(layout.height !== null ? { '--ops-h': `${layout.height}px` } : {}),
  } as CSSProperties;

  return (
    <section
      ref={opsRef}
      className={`ops${layout.height !== null ? ' sized' : ''}${gripMode ? ' dragging' : ''}${
        mapFocus ? ' map-focus' : ''
      }`}
      style={opsStyle}
      aria-label="ZeroMile 운영 콘솔"
    >
      <div className="ops-hud" aria-hidden="true" />

      <header className="ops-chrome">
        <div className="ops-identity">
          <span className="ops-mark">kakao mobility</span>
          <span className="ops-app">ZeroMile 운영 콘솔</span>
        </div>
        <div className="ops-meta">
          <span>
            <small>seed</small>
            <b>{config.seed}</b>
          </span>
          <span>
            <small>fleet</small>
            <b>{config.drivers.toLocaleString('ko-KR')}</b>
          </span>
          <span>
            <small>loads</small>
            <b>{config.loads.toLocaleString('ko-KR')}</b>
          </span>
          <span>
            <small>budget</small>
            <b>{(config.budget / 1000).toFixed(0)}K</b>
          </span>
        </div>
        <span className={`ops-status ${statusTone}`}>
          <i />
          {statusLabel}
        </span>
      </header>

      <div className="ops-toolbar">
        <div className="seg" role="group" aria-label="시뮬레이션 시나리오">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`seg-item ${preset.id === presetId ? 'active' : ''}`}
              aria-pressed={preset.id === presetId}
              onClick={() => setPresetId(preset.id)}
              disabled={phase === 'running'}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="ops-scenario">{config.description}</p>
        {/* The HUD cards are the point of the console and they are also sitting
            on top of the country. One switch clears the stage down to the map
            and the legend, and puts them all back. */}
        <button
          type="button"
          className={`ops-map-focus${mapFocus ? ' on' : ''}`}
          aria-pressed={mapFocus}
          onClick={() => setMapFocus((on) => !on)}
        >
          {mapFocus ? '패널 다시 보기' : '지도 크게 보기'}
        </button>
        {resized && (
          <button type="button" className="ops-layout-reset" onClick={() => setLayout(DEFAULT_LAYOUT)}>
            레이아웃 초기화
          </button>
        )}
      </div>

      <div className="ops-main">
        {/* Full-bleed backdrop: the rails and the HUD cards float on top of it,
            so the peninsula runs edge to edge under the whole console body. */}
        <div className="ops-canvas">
          <KoreaMap
            key={theme}
            tours={tours}
            version={version}
            phase={phase}
            reach={mapReach}
            highlights={mapHighlights}
            highlightColors={Object.fromEntries(
              mapHighlights.map((tour) => [tour.driver.id, routeColor(alternatives, tour)]),
            )}
            activeHighlightId={hoveredDriverId}
            selectedLoadId={selectedMapLoadId}
            onSelectLoad={(load) => {
              const owner = mapHighlights.find((tour) =>
                tour.legs.some((leg) => leg.load.id === load.id),
              );
              setHoveredDriverId(owner?.driver.id ?? null);
              setSelectedMapLoadId(load.id);
            }}
          />
        </div>

        <div {...paneGrip('planner')} />
        <div {...paneGrip('rail')} />

        <aside className="ops-planner" aria-label="운행 조건">
          <div className="rail-tab">
            <span className="rail-step">01</span>
            <div>
              <span className="rail-eyebrow">input</span>
              <h3>운행 조건</h3>
            </div>
          </div>
          <div className="planner-scroll">
          <section className="plan-block">
            <div className="plan-head">
              <div>
                <h4>출발 · 복귀</h4>
                <small>회차가 시작되는 위치와 반드시 돌아올 차고지</small>
              </div>
            </div>
            <LocationField
              label="현재 위치"
              hint={locationStatus || '전국 75개 화물차 거점 검색'}
              value={routeDraft.current}
              recent={recentLocations}
              onChange={(value) => updateLocation('current', value)}
              action={{ label: '현재 위치 자동 설정', onClick: detectLocation }}
            />
            <LocationField
              label="복귀 차고지"
              hint="회차 종료 후 도착할 지점"
              value={routeDraft.returnDepot}
              recent={recentLocations}
              onChange={(value) => updateLocation('returnDepot', value)}
            />
          </section>

          <section className="plan-block">
            <div className="plan-head">
              <div>
                <h4>차량 · 시간 제약</h4>
                <small>제약을 넘는 경로는 제안되지 않습니다</small>
              </div>
              <span className="plan-note">
                {formatHour(routeDraft.constraints.startHour)} 출발
              </span>
            </div>
            <div className="constraint-grid">
              <SelectField
                label="출발 시간"
                value={routeDraft.constraints.startHour}
                onChange={(value) => updateConstraint('startHour', Number(value))}
                options={hourOptions(5, 10)}
              />
              <SelectField
                label="귀가 마감"
                value={routeDraft.constraints.deadlineHour}
                onChange={(value) => updateConstraint('deadlineHour', Number(value))}
                options={hourOptions(16, 24)}
              />
              <SelectField
                label="최대 운행"
                value={routeDraft.constraints.maxDriveHours}
                onChange={(value) => updateConstraint('maxDriveHours', Number(value))}
                options={[8, 10, 11, 12, 13].map((value) => ({ value, label: `${value}시간` }))}
              />
              <SelectField
                label="차량 톤수"
                value={routeDraft.constraints.truckTons}
                onChange={(value) => updateConstraint('truckTons', Number(value))}
                options={[1, 2.5, 3.5, 5, 11].map((value) => ({ value, label: `${value}t` }))}
              />
              <SelectField
                label="차종"
                value={routeDraft.constraints.vehicleType}
                onChange={(value) =>
                  updateConstraint('vehicleType', value as RouteConstraints['vehicleType'])
                }
                options={['카고', '윙바디', '냉장탑차'].map((value) => ({ value, label: value }))}
              />
              <SelectField
                label="화물 조건"
                value={routeDraft.constraints.cargoType}
                onChange={(value) =>
                  updateConstraint('cargoType', value as RouteConstraints['cargoType'])
                }
                options={['일반 화물', '냉장·냉동', '취급주의'].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </div>
            {hasRouteInput && <div className="cargo-recommendation">
              <span>조건 맞춤 화물 추천</span>
              <b>{recommendedLoads.length}건</b>
              <p>
                {recommendedGoods.length > 0
                  ? recommendedGoods.join(' · ')
                  : '현재 차량과 화물 조건을 함께 만족하는 화물이 없습니다.'}
              </p>
              {routeDraft.constraints.vehicleType === '냉장탑차' && (
                <small>냉장탑차 선택 시 냉장·냉동 화물을 우선 추천합니다.</small>
              )}
            </div>}
          </section>

          </div>

          <footer className="planner-foot">
            <p className="plan-auto-copy">
              입력한 차량과 시간 조건에 맞춰 화물판 전체에서 최적의 운송 순서를 자동으로 찾습니다.
            </p>

            {appliedRoute && (
              <div className="plan-actions">
                <button
                  type="button"
                  className="plan-reset"
                  disabled={phase === 'running'}
                  onClick={() => setAppliedRoute(null)}
                >
                  맞춤 조건 해제
                </button>
              </div>
            )}
          </footer>
        </aside>

        <div className="ops-stage">
          {phase === 'idle' ? (
            <div className="ops-kpis-empty">
              <span>RESULTS LOCKED</span>
              <b>출발·복귀 위치를 입력하고 최적화를 실행하세요.</b>
              <small>공차율·순수입·배차 결과는 계산이 시작된 뒤 표시됩니다.</small>
            </div>
          ) : (
          <div className="ops-kpis">
            <div className="kpi lead">
              <span className="kpi-l">공차율 · empty running</span>
              <span className="kpi-row">
                <span className="kpi-v" style={{ color: ratioColour }}>
                  {emptyPct.toFixed(1)}%
                </span>
                {improving && baseStats.emptyRatio * 100 - emptyPct > 0.1 && (
                  <span className="kpi-delta">
                    −{(baseStats.emptyRatio * 100 - emptyPct).toFixed(1)}%p
                  </span>
                )}
              </span>
              <span className="kpi-gauge" aria-hidden="true">
                <i
                  className="kpi-gauge-base"
                  style={{ width: `${Math.min(100, baseStats.emptyRatio * 100)}%` }}
                />
                <i
                  className="kpi-gauge-now"
                  style={{ width: `${Math.min(100, emptyPct)}%`, background: ratioColour }}
                />
              </span>
              <span className="kpi-s">기준선 {(baseStats.emptyRatio * 100).toFixed(1)}%</span>
            </div>

            <div className="kpi-grid">
            <div className="kpi">
              <span className="kpi-l">기사 1인 일 순수입</span>
              <span className="kpi-row">
                <span className="kpi-v">{won(netAvg)}</span>
                {improving && stats.avgNet > baseStats.avgNet && (
                  <span className="kpi-delta">
                    +{Math.round(((stats.avgNet - baseStats.avgNet) / baseStats.avgNet) * 100)}%
                  </span>
                )}
              </span>
              <span className="kpi-s">연료·통행료 차감 후 · {won(perHour)}/시간</span>
            </div>
            <div className="kpi">
              <span className="kpi-l">배차 완료</span>
              <span className="kpi-row">
                <span className="kpi-v">
                  {Math.min(config.loads, Math.round(served)).toLocaleString('ko-KR')}
                </span>
                {improving && Math.round(served) - baseStats.loadsServed > 0 && (
                  <span className="kpi-delta">
                    +{Math.round(served) - baseStats.loadsServed}
                  </span>
                )}
              </span>
              <span className="kpi-s">/ 화물 {config.loads}건</span>
            </div>
            <div className="kpi">
              <span className="kpi-l">회차 성립</span>
              <span className="kpi-row">
                <span className="kpi-v">{Math.round(closed)}</span>
                {improving && Math.round(closed) - baseStats.closedLoops > 0 && (
                  <span className="kpi-delta">
                    +{Math.round(closed) - baseStats.closedLoops}
                  </span>
                )}
              </span>
              <span className="kpi-s">귀가 보장 노선</span>
            </div>
            <div className="kpi">
              <span className="kpi-l">CO₂ 절감</span>
              <span className="kpi-v">{Math.max(0, co2Saved).toFixed(1)}t</span>
              <span className="kpi-s">공차 주행 감소분 / 일</span>
            </div>
            </div>
          </div>
          )}

          <div {...paneGrip('kpi')} />

          <div className="stage-mid">
            <div className="canvas-legend">
              <span>
                <i style={{ background: '#FEE500' }} />
                선택 회차
              </span>
              <span>
                <i style={{ background: 'rgba(150,163,184,0.55)' }} />
                고속도로
              </span>
              <span className="legend-hint">
                ⌘/Ctrl + 스크롤 확대 · 드래그 이동 · 우클릭 회전
              </span>
            </div>

            {/* Parked directly over the peninsula, so the header is a button:
                collapsed it is a single chip and the road underneath is back. */}
            {phase === 'done' && displayedRoute && (
              <div className={`canvas-note${noteOpen ? '' : ' collapsed'}`}>
                <button
                  type="button"
                  className="canvas-note-toggle"
                  aria-expanded={noteOpen}
                  onClick={() => setNoteOpen((open) => !open)}
                >
                  <span>{mapHighlights.length}개 회차 비교 중</span>
                  <i aria-hidden="true">{noteOpen ? '접기' : '펼치기'}</i>
                </button>
                {noteOpen && (
                  <div className="canvas-route-summary">
                    <b>
                      총 {(displayedRoute.loadedKm + displayedRoute.emptyKm).toFixed(0)}km ·{' '}
                      {displayedRoute.legs.length}개 화물 · {displayedRoute.hours.toFixed(1)}시간
                    </b>
                    <ol>
                      <li>출발 · {siteLabel(driverStart(displayedRoute.driver))}</li>
                      {displayedRoute.legs.map((leg, index) => (
                        <li key={leg.load.id}>
                          경유 {index + 1} · {siteLabel(leg.load.toSite)} · {leg.load.toBay}
                        </li>
                      ))}
                      <li>복귀 · {siteLabel(displayedRoute.driver.depot)}</li>
                    </ol>
                  </div>
                )}
              </div>
            )}

            {selectedLoadingItem && (
              <CargoLoadDetail
                key={selectedLoadingItem.load.id}
                item={selectedLoadingItem}
                selectedOption={selectedLoadingItem.selectedOption}
                registered={registeredLoadIds.includes(selectedLoadingItem.load.id)}
                truckTons={routeDraft.constraints.truckTons}
                totalTons={loadingPlan.reduce((sum, item) => sum + item.load.tons, 0)}
                onAdd={(option) => registerLoad(selectedLoadingItem.load.id, option)}
                onClose={() => setSelectedMapLoadId(null)}
              />
            )}
          </div>

          {/* Rendered on every finished solve, including the ones that found
              nothing. Gating the whole panel on `alternatives.length` meant a
              fruitless run erased the route list, the map overlay and the
              banner all at once, leaving a full set of fleet KPIs above an
              empty map and no statement anywhere that the search had failed. */}
          {phase === 'done' && alternatives.length === 0 && (
            <>
            <div {...paneGrip('routes')} />
            <div className="ops-routes">
              <div className="routes-empty">
                <span>NO TOUR FOUND</span>
                <b>이 조건으로는 회차를 만들지 못했습니다.</b>
                {eligibleLoadCount === 0 ? (
                  <small>
                    {routeDraft.constraints.vehicleType} ·{' '}
                    {routeDraft.constraints.cargoType} 조건으로 이 구간에서 실을 수 있는
                    화물이 없습니다. 화물 조건을 바꾸거나 복귀 차고지를 옮겨보세요.
                  </small>
                ) : (
                  <small>
                    실을 수 있는 화물은 {eligibleLoadCount}건 있지만, {locked?.minLegs ?? 1}개 이상 연쇄하면서
                    차고지 {HOME_RADIUS_KM}km 이내로 복귀하는 순서가 없습니다. 운행 시간을 늘리거나
                    복귀 차고지를 옮겨보세요.
                  </small>
                )}
                {eligibleLoadCount === 0 &&
                  routeDraft.constraints.cargoType !== '일반 화물' && (
                    <button
                      type="button"
                      onClick={() => updateConstraint('cargoType', '일반 화물')}
                    >
                      일반 화물로 바꾸기
                    </button>
                  )}
              </div>
            </div>
            </>
          )}

          {phase === 'done' && alternatives.length > 0 && (
            <>
            <div {...paneGrip('routes')} />
            <div className="ops-routes">
              <ResultBanner
                appliedRoute={appliedRoute}
                myTour={tours.find((tour) => tour.driver.id === drivers[0].id) ?? null}
                myBase={baseline[0]}
                stats={stats}
                baseStats={baseStats}
              />
              <div className="routes-head">
                <div>
                  <h4>제안된 회차 {alternatives.length}개</h4>
                  <small>선택하면 지도에 겹쳐 비교합니다 · {selectedTours.length}개 선택됨</small>
                </div>
                <div className="routes-tools">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedDriverIds(alternatives.slice(0, 3).map((tour) => tour.driver.id))
                    }
                  >
                    상위 3개
                  </button>
                  <button type="button" onClick={() => setSelectedDriverIds([])}>
                    전체 해제
                  </button>
                </div>
              </div>

              <div className="routes-strip">
                {alternatives.map((tour, index) => {
                  // Option 1 is the day the solver committed the truck to; the
                  // rest are the runners-up it also proved feasible.
                  const isCustom = index === 0;
                  const selected = selectedDriverIds.includes(tour.driver.id);
                  const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
                  const emptyRatio = tour.emptyKm / Math.max(1, tour.loadedKm + tour.emptyKm);
                  return (
                    <label
                      className="route-opt"
                      key={tour.driver.id}
                      style={
                        selected
                          ? { borderColor: `${color}66`, background: `${color}0f` }
                          : undefined
                      }
                      onMouseEnter={() => setHoveredDriverId(tour.driver.id)}
                      onMouseLeave={() => setHoveredDriverId(null)}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleTour(tour.driver.id)}
                      />
                      <span className="route-opt-top">
                        <span
                          className="route-opt-chip"
                          style={
                            selected
                              ? { background: color, borderColor: color, color: '#151515' }
                              : { borderColor: color, color }
                          }
                        >
                          {index + 1}
                        </span>
                        <span className="route-opt-name" title={tourRouteLabel(tour)}>
                          {tourRouteLabel(tour)}
                        </span>
                      </span>
                      {tour.legs[0] && (
                        <span className="route-opt-site">
                          {siteLabel(tour.legs[0].load.fromSite)} ·{' '}
                          {tour.legs[0].load.fromBay} 상차
                        </span>
                      )}
                      <span className="route-opt-route-meta">
                        {tour.legs.length}개 경유 · {(tour.loadedKm + tour.emptyKm).toFixed(0)}km
                      </span>
                      {isCustom && appliedRoute && (
                        <span className="route-opt-condition">
                          {appliedRoute.constraints.vehicleType} 추천 · {appliedRoute.constraints.cargoType} 적합
                        </span>
                      )}
                      <span className="route-opt-stats">
                        <span>
                          <small>실수령</small>
                          <b>{won(tour.net)}</b>
                        </span>
                        <span>
                          <small>소요</small>
                          <b>{tour.hours.toFixed(1)}h</b>
                        </span>
                        <span>
                          <small>공차율</small>
                          <b>{(emptyRatio * 100).toFixed(0)}%</b>
                        </span>
                        <span>
                          <small>귀가</small>
                          <b>
                            {formatHour(
                              (appliedRoute?.constraints.startHour ?? 6) + tour.hours,
                            )}
                          </b>
                        </span>
                      </span>
                      <button
                        type="button"
                        className={`route-opt-detail${detailDriverId === tour.driver.id ? ' on' : ''}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setDetailDriverId((current) =>
                            current === tour.driver.id ? null : tour.driver.id,
                          );
                        }}
                      >
                        {detailDriverId === tour.driver.id ? '여정 닫기' : '여정 상세'}
                      </button>
                    </label>
                  );
                })}
              </div>

              {(() => {
                const detailTour = alternatives.find(
                  (tour) => tour.driver.id === detailDriverId,
                );
                if (!detailTour) return null;
                return (
                  <TourDetail
                    tour={detailTour}
                    startHour={appliedRoute?.constraints.startHour ?? 6}
                    color={routeColor(alternatives, detailTour)}
                    isCustom={detailTour.driver.id === OPTION_ID_BASE}
                    onClose={() => setDetailDriverId(null)}
                  />
                );
              })()}
            </div>
            </>
          )}

        </div>

        <aside className="ops-telemetry" aria-label="차량 텔레메트리">
          <div className="rail-tab">
            <span className="rail-step">02</span>
            <div>
              <span className="rail-eyebrow">output</span>
              <h3>차량 · 솔버 텔레메트리</h3>
            </div>
          </div>

          <div className="tele-scroll">
            <TruckLoadSimulator
              vehicleType={routeDraft.constraints.vehicleType}
              cargoCondition={routeDraft.constraints.cargoType}
              truckTons={routeDraft.constraints.truckTons}
              tour={appliedRoute && routeChanged ? null : modelTour}
              totalLoadCount={loadingPlan.length}
              phase={phase}
              cityName={ko}
              loadOptions={loadOptions}
              focusLoadId={selectedMapLoadId}
              onFocusLoad={setSelectedMapLoadId}
              onSelectLoadOption={(loadId, option) => {
                setSelectedMapLoadId(loadId);
                setLoadOptions((current) => ({ ...current, [loadId]: option }));
              }}
              viewportGrip={<div {...paneGrip('truck')} />}
            />

            {(phase === 'running' || history.length > 1) && (
              <div className="ops-insights">
                <div className="insight-chart">
                  <div className="insight-head">
                    <span>수렴 그래프 · 실시간</span>
                    <span>
                      {(solveMs / 1000).toFixed(1)}초 · {(progress * 100).toFixed(0)}%
                    </span>
                  </div>
                  <ConvergenceChart
                    history={history}
                    baseEmpty={baseStats.emptyRatio}
                    live={phase === 'running'}
                  />
                  <div className="chart-legend">
                    <span>
                      <i style={{ background: 'var(--empty)' }} />
                      공차율 {(stats.emptyRatio * 100).toFixed(1)}%
                    </span>
                    <span>
                      <i style={{ background: 'var(--green)' }} />
                      평균 순수입 {wonShort(stats.avgNet)}
                    </span>
                    <span>
                      <i className="dashed" />
                      기준선
                    </span>
                  </div>
                </div>

                {phase === 'running' && (
                  <div className="insight-feed">
                    <div className="insight-head">
                      <span>실시간 배차 로그</span>
                      <span className="insight-live">
                        <i />
                        live
                      </span>
                    </div>
                    <div className="feed-list">
                      {feed.map((event) => (
                        <div key={event.id} className={`feed-item ${event.kind}`}>
                          <b>{event.text}</b>
                          {event.sub && <small>{event.sub}</small>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className={`ops-run${phase === 'running' ? ' live' : ''}`}>
        <div className="run-id">
          <span className="run-id-dot" />
          <div>
            <b>Simulated annealing</b>
            <small>
              {phase === 'idle'
                ? '실행 대기 · 화물판 전체 탐색'
                : phase === 'running'
                  ? solveStageLabel(progress)
                  : '수렴 완료 · 회차 확정'}
            </small>
          </div>
        </div>

        <div className="run-progress">
          <div className="run-progress-top">
            <span>
              {phase === 'idle'
                ? `${(config.budget / 1000).toFixed(0)}K moves 대기`
                : `${((optRef.current?.iterations ?? 0) / 1000).toFixed(0)}K / ${(config.budget / 1000).toFixed(0)}K moves · ${(
                    solveMs / 1000
                  ).toFixed(1)}초`}
            </span>
            <span>
              {phase !== 'idle' &&
                `T ${Math.round(annealTemp(progress)).toLocaleString('ko-KR')}`}
            </span>
            <span className="run-pct">{(progress * 100).toFixed(0)}%</span>
          </div>
          <div className="progress">
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        </div>

        {history.length > 1 && (
          <div className="run-spark" aria-hidden="true">
            <ConvergenceChart
              history={history}
              baseEmpty={baseStats.emptyRatio}
              live={phase === 'running'}
            />
            <small>
              공차율 {(baseStats.emptyRatio * 100).toFixed(1)}% →{' '}
              {(stats.emptyRatio * 100).toFixed(1)}%
            </small>
          </div>
        )}

        <div className="run-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={reset}
            disabled={phase === 'idle'}
          >
            초기화
          </button>
          <button
            type="button"
            className="btn btn-primary run-cta"
            onClick={runOptimization}
            disabled={phase === 'running' || !hasRouteInput}
          >
            <Spark />
            {!hasRouteInput
              ? '출발·복귀 입력 필요'
              : phase === 'running' || pendingOptimize
              ? '최적화 중…'
              : phase === 'done'
                ? '다시 실행'
                : '회차 최적화 실행'}
          </button>
        </div>
      </div>

      {/* Window-style resize affordances. Double-click any of them to reset. */}
      <div className="ops-grip n" title="높이 조절" {...gripHandlers('n')} />
      <div className="ops-grip w" title="너비 조절" {...gripHandlers('w')} />
      <div className="ops-grip e" title="너비 조절" {...gripHandlers('e')} />
      <div className="ops-grip s" title="높이 조절" {...gripHandlers('s')} />
      <div className="ops-grip nw" title="크기 조절" {...gripHandlers('nw')} />
      <div className="ops-grip ne" title="크기 조절" {...gripHandlers('ne')} />
      <div className="ops-grip sw" title="크기 조절" {...gripHandlers('sw')} />
      <div className="ops-grip se" title="크기 조절" {...gripHandlers('se')} />
    </section>
  );
}

function CargoLoadDetail({
  item,
  selectedOption,
  registered,
  truckTons,
  totalTons,
  onAdd,
  onClose,
}: {
  item: LoadingPlanItem;
  selectedOption?: string;
  registered: boolean;
  truckTons: number;
  totalTons: number;
  onAdd: (option: string) => void;
  onClose: () => void;
}) {
  const options = loadTreatmentOptions(item.load);
  const [pendingOption, setPendingOption] = useState(selectedOption ?? options[0]);
  const side = item.deckSide === 'center' ? '차축 중앙' : item.deckSide === 'left' ? '좌측 하단' : '우측 하단';
  const alreadyApplied = registered && pendingOption === selectedOption;

  useEffect(() => {
    if (selectedOption) setPendingOption(selectedOption);
  }, [selectedOption]);

  return (
    <aside className="cargo-detail" aria-label={`${item.load.goods} 화물 상세정보`}>
      <div className="cargo-detail-head">
        <div>
          <span>STOP {item.unloadOrder} · LOAD {item.loadOrder}</span>
          <h4>{item.load.goods} · {item.load.tons}t</h4>
        </div>
        <button type="button" onClick={onClose} aria-label="화물 상세 닫기">×</button>
      </div>
      <dl>
        <div><dt>운송 구간</dt><dd>{ko(item.load.from)} → {item.destination}</dd></div>
        <div><dt>목적지 주차·하역</dt><dd>{siteLabel(item.load.toSite)} · {item.load.toBay}</dd></div>
        <div><dt>적재 위치</dt><dd>{item.zone === 'rear' ? '후문' : item.zone === 'front' ? '전방' : '중앙'} · {side}</dd></div>
        <div><dt>상차/하역</dt><dd>상차 {item.loadOrder} · 하역 {item.unloadOrder}</dd></div>
        <div><dt>총 적재중량</dt><dd>{totalTons} / {truckTons}t</dd></div>
        <div><dt>화물 크기</dt><dd>{item.dimensions.lengthM.toFixed(2)} × {item.dimensions.widthM.toFixed(2)} × {item.dimensions.heightM.toFixed(2)}m</dd></div>
      </dl>
      <div className="cargo-option-title">
        <b>적재 방식 선택</b>
        <span>옵션 선택 후 추가해야 모델에 표시됩니다</span>
      </div>
      <div className="cargo-options" role="group" aria-label="화물 적재 방식">
        {options.map((option) => (
          <button
            type="button"
            key={option}
            className={pendingOption === option ? 'selected' : ''}
            aria-pressed={pendingOption === option}
            onClick={() => setPendingOption(option)}
          >
            <i />
            <span>{option}</span>
            <small>{pendingOption === option ? '선택됨' : '선택'}</small>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="cargo-add-action"
        disabled={alreadyApplied}
        onClick={() => onAdd(pendingOption)}
      >
        {alreadyApplied ? '모델에 등록됨' : registered ? '옵션 업데이트' : '모델에 추가'}
      </button>
      <p className="cargo-balance-note">
        중량 순위 {item.weightRank}위 · 고정 예상 {item.secureMinutes}분 · {item.placementReason}
      </p>
    </aside>
  );
}

function LocationField({
  label,
  hint,
  value,
  recent,
  onChange,
  action,
}: {
  label: string;
  hint: string;
  value: string;
  recent: string[];
  onChange: (value: string) => void;
  action?: { label: string; onClick: () => void };
}) {
  const [query, setQuery] = useState(ko(value));
  const [open, setOpen] = useState(false);
  const matches = searchLocations(query);
  const fieldRef = useRef<HTMLLabelElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; flip: boolean }>();

  useEffect(() => setQuery(ko(value)), [value]);

  // The planner rail scrolls and the console clips, so the menu is portalled
  // to the body and pinned to the field on every scroll/resize.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = fieldRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const room = window.innerHeight - rect.bottom;
      setAnchor({
        left: Math.min(rect.left, window.innerWidth - 312),
        top: room < 280 ? rect.top - 6 : rect.bottom + 6,
        width: Math.max(rect.width, 296),
        flip: room < 280,
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const choose = (locationId: string) => {
    onChange(locationId);
    setQuery(ko(locationId));
    setOpen(false);
  };

  return (
    <label
      ref={fieldRef}
      className="field"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span>{label}</span>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        value={query}
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
      />
      <small>{hint}</small>

      {action && (
        <button
          type="button"
          className="field-action"
          title={action.label}
          aria-label={action.label}
          onClick={action.onClick}
        >
          <Crosshair />
        </button>
      )}

      {open && anchor && createPortal(
        <div
          className="field-menu"
          role="listbox"
          style={{
            left: anchor.left,
            top: anchor.top,
            width: anchor.width,
            transform: anchor.flip ? 'translateY(-100%)' : undefined,
          }}
        >
          {!query && recent.length > 0 && (
            <div className="field-menu-group">
              <span>최근 선택</span>
              {recent.map((locationId) => (
                <button
                  key={`recent-${locationId}`}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    choose(locationId);
                  }}
                >
                  <b>{ko(locationId)}</b>
                  <small>{SITE_BY_ID[locationId]?.kind ?? '최근 사용한 지역'}</small>
                </button>
              ))}
            </div>
          )}
          <div className="field-menu-group">
            <span>{query ? '검색 결과' : `전국 물류 거점 ${SITES.length}곳`}</span>
            {matches.map((item) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(item.id);
                }}
              >
                <b>{item.label}</b>
                <small>{item.detail}</small>
              </button>
            ))}
            {matches.length === 0 && <p>도시명이나 물류센터명을 다시 입력해 주세요.</p>}
          </div>
        </div>,
        document.body,
      )}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Crosshair() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1v2.2M8 12.8V15M15 8h-2.2M3.2 8H1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function cloneRoute(route: RouteInput): RouteInput {
  return {
    ...route,
    constraints: { ...route.constraints },
  };
}

function hourOptions(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const value = from + index;
    return { value, label: formatHour(value) };
  });
}

function formatHour(value: number): string {
  const hour = Math.floor(value) % 24;
  const minute = Math.round((value % 1) * 60);
  const suffix = hour < 12 ? '오전' : '오후';
  const display = hour % 12 || 12;
  return `${suffix} ${display}:${String(minute).padStart(2, '0')}`;
}

function searchLocations(rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  const all = SITES.map((location) => ({
    id: location.id,
    label: siteLabel(location.id),
    detail: `${location.kind} · 화물차 주차·상하차 지점`,
    search: `${siteLabel(location.id)} ${location.ko} ${location.kind} ${location.cityId}`.toLowerCase(),
  }));
  if (!query) return all;
  return all.filter((item) => item.search.includes(query));
}

function isRouteRelevant(load: Load, startSite: string, homeSite: string, maxHours: number) {
  const viaKm = km(startSite, load.fromSite) + load.km + km(load.toSite, homeSite);
  const viaHours =
    hrs(startSite, load.fromSite) + load.hours + hrs(load.toSite, homeSite) + HANDLING_HOURS;
  return viaHours <= maxHours && viaKm <= routeCorridorBudgetKm(startSite, homeSite, maxHours);
}

/** Nominal road speed, for sizing a day off the clock rather than off a line. */
const NOMINAL_KMH = 65;

/**
 * How far the whole day is allowed to run.
 *
 * The old form was purely a function of the start→garage line, which is fine
 * for a one-way day and degenerate for a loop: when the garage *is* the start
 * that distance is zero, the budget collapses onto its floor, and the solver
 * gets asked to fit three legs into 380km. An out-and-back day has no corridor
 * to measure, so its budget has to come from the clock instead.
 */
function routeCorridorBudgetKm(startSite: string, homeSite: string, maxHours: number) {
  const directKm = km(startSite, homeSite);
  return Math.max(directKm * 2 + 380, maxHours * NOMINAL_KMH);
}

function bridgeGoods(cargoType: CargoCondition): string {
  if (cargoType === '냉장·냉동') return '냉장식품';
  if (cargoType === '취급주의') return '전자부품';
  return '생활용품';
}

function nearestLocation(latitude: number, longitude: number) {
  return SITES.reduce((nearest, candidate) => {
    const candidateDistance = (candidate.lat - latitude) ** 2 + (candidate.lon - longitude) ** 2;
    const nearestDistance = (nearest.lat - latitude) ** 2 + (nearest.lon - longitude) ** 2;
    return candidateDistance < nearestDistance ? candidate : nearest;
  }, SITES[0]);
}

function routeColor(alternatives: Tour[], tour: Tour): string {
  const index = alternatives.findIndex((candidate) => candidate.driver.id === tour.driver.id);
  return ROUTE_COLORS[(index >= 0 ? index : 0) % ROUTE_COLORS.length];
}

const CITY_KO: Record<string, string> = Object.fromEntries(
  CITIES.map((c) => [c.id, c.ko]),
);

/** City id → Korean name, used across the planner and route labels. */
function ko(id: string): string {
  return SITE_BY_ID[id] ? siteLabel(id) : CITY_KO[id] ?? id;
}

/**
 * A tour flattened into plain JSON for the agent. Docks become the names a
 * driver would say, and nothing is recomputed — every figure is the solver's
 * own, so the agent can only ever repeat what the map is already showing.
 */
function tourSnapshot(tour: Tour): TourSnapshot {
  const totalKm = tour.loadedKm + tour.emptyKm;
  return {
    driverId: tour.driver.id,
    driverName: tour.driver.name,
    depot: ko(tour.driver.depot),
    legs: tour.legs.map((leg, index) => ({
      index: index + 1,
      ref: leg.load.ref,
      from: ko(leg.load.fromSite),
      to: ko(leg.load.toSite),
      fromBay: leg.load.fromBay,
      toBay: leg.load.toBay,
      km: leg.load.km,
      hours: leg.load.hours,
      tons: leg.load.tons,
      goods: leg.load.goods,
      revenueWon: leg.load.revenue,
      deadheadKm: leg.deadheadKm,
    })),
    returnKm: tour.returnKm,
    loadedKm: tour.loadedKm,
    emptyKm: tour.emptyKm,
    emptyRatio: totalKm > 0 ? tour.emptyKm / totalKm : 0,
    hours: tour.hours,
    revenueWon: tour.revenue,
    costWon: tour.cost,
    netWon: tour.net,
  };
}

function tourRouteLabel(tour: Tour): string {
  const current = tour.driver.current ?? tour.driver.home;
  const freightLegs = tour.legs
    .map((leg) => `${ko(leg.load.from)}→${ko(leg.load.to)}`)
    .join(' · ');
  return `현재 ${ko(current)} · ${freightLegs}`;
}

/** The freight chain alone, for the live feed where "현재" is noise. */
function chainLabel(tour: Tour): string {
  return tour.legs.map((leg) => `${ko(leg.load.from)}→${ko(leg.load.to)}`).join(' · ');
}

/* ── Solve insights ─────────────────────────────────────────────────────── */

/**
 * The convergence trace, plotted against wall clock.
 *
 * `p` (work done) was the old x axis, which made the graph a picture of the
 * iteration counter rather than of the solve: a stalled frame was compressed
 * out of existence and the trace advanced in lurches. On `t` it sweeps at the
 * speed the run is actually going. While it's live the axis is the projected
 * total — elapsed divided by the fraction of the budget spent, which is stable
 * because throughput is — so the trace reaches the right edge exactly as the
 * run lands. After that the axis is the measured total.
 */
function ConvergenceChart({
  history,
  baseEmpty,
  live = false,
}: {
  history: SolvePoint[];
  baseEmpty: number;
  live?: boolean;
}) {
  const W = 240;
  const H = 104;
  const PAD = 6;
  if (history.length < 2) return <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" />;

  const last = history[history.length - 1];
  const span = Math.max(1, live ? last.t / Math.max(last.p, 0.02) : last.t);
  const empties = history.map((h) => h.empty);
  const nets = history.map((h) => h.net);
  const eMax = Math.max(baseEmpty, ...empties);
  const eMin = Math.min(...empties);
  const nMax = Math.max(...nets);
  const nMin = Math.min(...nets);

  const x = (p: number) => PAD + p * (W - PAD * 2);
  const y = (value: number, min: number, max: number) => {
    const span = max - min || 1;
    return H - PAD - ((value - min) / span) * (H - PAD * 2);
  };
  const path = (get: (h: SolvePoint) => number, min: number, max: number) =>
    history
      .map(
        (h, i) =>
          `${i === 0 ? 'M' : 'L'}${x(h.t / span).toFixed(1)} ${y(get(h), min, max).toFixed(1)}`,
      )
      .join(' ');

  const baseY = y(baseEmpty, eMin, eMax);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line
        x1={PAD}
        x2={W - PAD}
        y1={baseY}
        y2={baseY}
        stroke="rgba(240,103,79,0.35)"
        strokeDasharray="3 4"
      />
      <path
        d={path((h) => h.net, nMin, nMax)}
        fill="none"
        stroke="rgba(67,211,162,0.8)"
        strokeWidth="1.5"
      />
      <path
        d={path((h) => h.empty, eMin, eMax)}
        fill="none"
        stroke="#f0674f"
        strokeWidth="1.8"
      />
    </svg>
  );
}

/* ── Result banner ──────────────────────────────────────────────────────── */

function ResultBanner({
  appliedRoute,
  myTour,
  myBase,
  stats,
  baseStats,
}: {
  appliedRoute: RouteInput | null;
  myTour: Tour | null;
  myBase: Tour | undefined;
  stats: Stats;
  baseStats: Stats;
}) {
  const mine = Boolean(appliedRoute && myTour && myTour.legs.length >= 3);

  if (mine && myTour) {
    const start = appliedRoute?.constraints.startHour ?? 6;
    const baseNet = myBase && myBase.legs.length > 0 ? myBase.net : baseStats.avgNet;
    const gain = myTour.net - baseNet;
    const emptyRatio = myTour.emptyKm / Math.max(1, myTour.loadedKm + myTour.emptyKm);
    return (
      <div className="result-banner">
        <span className="result-banner-title">
          <Check size={13} />내 차량 회차 확정 · {myTour.legs.length}구간 체인
        </span>
        <div className="result-banner-stats">
          <span>
            <small>실수령</small>
            <b>{won(myTour.net)}</b>
          </span>
          {gain > 0 && (
            <span>
              <small>단건 대비</small>
              <b className="up">+{wonShort(gain)}</b>
            </span>
          )}
          <span>
            <small>공차율</small>
            <b>{(emptyRatio * 100).toFixed(0)}%</b>
          </span>
          <span>
            <small>최적 거리</small>
            <b>{(myTour.loadedKm + myTour.emptyKm).toFixed(0)}km</b>
          </span>
          <span>
            <small>귀가 보장</small>
            <b>{formatHour(start + myTour.hours)}</b>
          </span>
        </div>
      </div>
    );
  }

  const gain = stats.avgNet - baseStats.avgNet;
  return (
    <div className="result-banner">
      <span className="result-banner-title">
        <Check size={13} />
        전체 화물판 최적화 완료
      </span>
      <div className="result-banner-stats">
        <span>
          <small>기사 평균 순수입</small>
          <b>
            {won(stats.avgNet)}
            {gain > 0 && <em className="up"> +{Math.round((gain / baseStats.avgNet) * 100)}%</em>}
          </b>
        </span>
        <span>
          <small>공차율</small>
          <b>
            {(baseStats.emptyRatio * 100).toFixed(1)}% → {(stats.emptyRatio * 100).toFixed(1)}%
          </b>
        </span>
        <span>
          <small>귀가 보장 회차</small>
          <b>{stats.closedLoops}개</b>
        </span>
      </div>
    </div>
  );
}

/* ── Tour itinerary ─────────────────────────────────────────────────────── */

type TimelineItem =
  | {
      type: 'stop';
      kind: 'depot' | 'pickup' | 'drop' | 'home';
      time: number;
      site: string;
      bay?: string;
      load?: Load;
    }
  | { type: 'leg'; km: number; empty: boolean };

/**
 * Replays the same arithmetic as `settle()` so the clock times land exactly on
 * the tour's total hours: approach drive, 0.4h handling at each dock, loaded
 * drive, and the final run home.
 */
function buildTimeline(tour: Tour, startHour: number): TimelineItem[] {
  const items: TimelineItem[] = [];
  let t = startHour;
  let at = driverStart(tour.driver);
  items.push({ type: 'stop', kind: 'depot', time: t, site: at });

  for (const leg of tour.legs) {
    t += hrs(at, leg.load.fromSite);
    items.push({ type: 'leg', km: leg.deadheadKm, empty: true });
    items.push({
      type: 'stop',
      kind: 'pickup',
      time: t,
      site: leg.load.fromSite,
      bay: leg.load.fromBay,
      load: leg.load,
    });
    t += HANDLING_HOURS + leg.load.hours;
    items.push({ type: 'leg', km: leg.load.km, empty: false });
    items.push({
      type: 'stop',
      kind: 'drop',
      time: t,
      site: leg.load.toSite,
      bay: leg.load.toBay,
      load: leg.load,
    });
    t += HANDLING_HOURS;
    at = leg.load.toSite;
  }

  if (tour.legs.length) t += hrs(at, tour.driver.depot);
  items.push({ type: 'leg', km: tour.returnKm, empty: true });
  items.push({ type: 'stop', kind: 'home', time: t, site: tour.driver.depot });
  return items;
}

const STOP_LABELS: Record<string, string> = {
  depot: '출발',
  pickup: '상차',
  drop: '하차',
  home: '귀가',
};

function TourDetail({
  tour,
  startHour,
  color,
  isCustom,
  onClose,
}: {
  tour: Tour;
  startHour: number;
  color: string;
  isCustom: boolean;
  onClose: () => void;
}) {
  const timeline = useMemo(() => buildTimeline(tour, startHour), [tour, startHour]);
  return (
    <div className="tour-detail" style={{ ['--rc' as string]: color }}>
      <div className="td-head">
        <b>
          {isCustom ? '내 차량' : tour.driver.name} · {chainLabel(tour)}
        </b>
        <span>
          총 {Math.round(tour.loadedKm + tour.emptyKm)}km · 공차 {Math.round(tour.emptyKm)}km ·{' '}
          {tour.hours.toFixed(1)}시간 · 실수령 {won(tour.net)}
        </span>
        <button type="button" className="td-close" onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="td-line">
        {timeline.map((item, index) =>
          item.type === 'leg' ? (
            <div key={index} className={`td-leg${item.empty ? '' : ' loaded'}`}>
              <span>
                {item.empty ? '공차' : '적재'} {Math.round(item.km)}km
              </span>
              <i />
            </div>
          ) : (
            <div key={index} className={`td-stop ${item.kind}`}>
              <span className="td-kind">{STOP_LABELS[item.kind]}</span>
              <span className="td-time">{formatHour(item.time)}</span>
              <span className="td-site">{siteLabel(item.site)}</span>
              {item.bay && <span className="td-cargo">{item.bay}</span>}
              {item.kind === 'pickup' && item.load && (
                <span className="td-cargo">
                  {item.load.goods} · {item.load.tons}t · {wonShort(item.load.revenue)}
                </span>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
