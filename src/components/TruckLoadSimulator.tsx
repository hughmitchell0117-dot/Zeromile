import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  buildLoadingPlan,
  compatibilityNote,
  isCompatibleSelection,
  loadTreatmentOptions,
  type CargoCondition,
  type LoadingPlanItem,
  type LoadTreatment,
  type VehicleType,
} from '../lib/loading';
import type { Tour } from '../lib/model';

type Phase = 'idle' | 'running' | 'done';
type Point3 = { x: number; y: number; z: number };
type Poly = {
  pts: Point3[];
  normal: Point3;
  color: string;
  alpha: number;
  stroke?: string;
};
type Prim = { polys: Poly[]; translucent?: boolean };
type View = { yaw: number; pitch: number; zoom: number; target: Point3 };
type Scene = {
  vehicleType: VehicleType;
  cargoCondition: CargoCondition;
  truckTons: number;
  plan: LoadingPlanItem[];
  slotCount: number;
  timeline: number;
  focusLoadId: number | null;
};

const VEHICLES: Record<
  VehicleType,
  { code: string; accent: string; shell: string; description: string }
> = {
  카고: {
    code: 'OPEN DECK',
    accent: '#ff9b54',
    shell: '#647182',
    description: '측면 개방 · 크레인/지게차 상하차',
  },
  윙바디: {
    code: 'WING BODY',
    accent: '#fee500',
    shell: '#d5d9df',
    description: '양측 개방 · 팔레트 다점 하역',
  },
  냉장탑차: {
    code: 'COLD BOX',
    accent: '#67d8ff',
    shell: '#e9f4f6',
    description: '밀폐 단열 · 콜드체인 유지',
  },
};

const CARGO_COLORS = {
  general: '#f0b762',
  bulk: '#a9b0bb',
  cold: '#64d7ff',
  fragile: '#ff7f9f',
} as const;

const PROFILE_LABEL = {
  general: '일반',
  bulk: '중량물',
  cold: '저온',
  fragile: '취급주의',
} as const;

// Camera sits CAMERA units in front of the orbit target and BASE_SPAN world
// units fit across the viewport at zoom 1, so the truck fills the frame.
const CAMERA = 11;
const BASE_SPAN = 9.4;
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 6;
const PITCH_MIN = -0.35;
const PITCH_MAX = 1.15;
const LIGHT = normalize({ x: -0.44, y: 0.8, z: 0.42 });

const DEFAULT_VIEW: View = { yaw: 0.72, pitch: 0.3, zoom: 1, target: { x: 0.35, y: 1.4, z: 0 } };

export default function TruckLoadSimulator({
  vehicleType,
  cargoCondition,
  truckTons,
  tour,
  totalLoadCount = 0,
  phase,
  cityName,
  loadOptions = {},
  focusLoadId = null,
  onFocusLoad,
  onSelectLoadOption,
  viewportGrip,
}: {
  vehicleType: VehicleType;
  cargoCondition: CargoCondition;
  truckTons: number;
  tour: Tour | null;
  totalLoadCount?: number;
  phase: Phase;
  cityName: (id: string) => string;
  loadOptions?: Record<number, string>;
  focusLoadId?: number | null;
  onFocusLoad?: (loadId: number) => void;
  onSelectLoadOption?: (loadId: number, option: LoadTreatment) => void;
  /** Drag handle for the 3D view's height, owned by the console's layout state. */
  viewportGrip?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<{ distance: number; mid: { x: number; y: number } } | null>(null);
  const viewRef = useRef<View>(cloneView(DEFAULT_VIEW));
  const goalRef = useRef<View>(cloneView(DEFAULT_VIEW));
  const sizeRef = useRef({ width: 760, height: 430 });
  const dirtyRef = useRef(true);
  const morphRef = useRef(1);
  const morphStartRef = useRef(0);
  const sceneRef = useRef<Scene>({
    vehicleType,
    cargoCondition,
    truckTons,
    plan: [],
    slotCount: 0,
    timeline: 0,
    focusLoadId,
  });

  const [zoomPct, setZoomPct] = useState(100);
  const [scanning, setScanning] = useState(false);
  const [timeline, setTimeline] = useState(0);
  const [playing, setPlaying] = useState(false);

  const plan = useMemo(
    () => (tour ? buildLoadingPlan(tour, cityName, loadOptions) : []),
    [tour, cityName, loadOptions],
  );
  const tourKey = plan.map((item) => item.load.id).join('-');
  const maxTimeline = plan.length * 2;
  const vehicle = VEHICLES[vehicleType];
  const dims = useMemo(() => truckDims(truckTons), [truckTons]);

  const applyZoom = useCallback((next: number) => {
    goalRef.current.zoom = clamp(next, ZOOM_MIN, ZOOM_MAX);
    setZoomPct(Math.round(goalRef.current.zoom * 100));
  }, []);

  const resetView = useCallback(() => {
    goalRef.current = cloneView(DEFAULT_VIEW);
    setZoomPct(100);
  }, []);

  // Scene inputs live in a ref so the render loop never depends on React state.
  useEffect(() => {
    sceneRef.current = {
      vehicleType,
      cargoCondition,
      truckTons,
      plan,
      slotCount: plan.length,
      timeline,
      focusLoadId,
    };
    dirtyRef.current = true;
  });

  useEffect(() => {
    if (reduceMotion()) {
      morphRef.current = 1;
      setScanning(false);
    } else {
      morphRef.current = 0;
      morphStartRef.current = performance.now();
      setScanning(true);
    }
    dirtyRef.current = true;
  }, [vehicleType, cargoCondition, truckTons]);

  useEffect(() => {
    setTimeline(phase === 'done' ? plan.length : 0);
    setPlaying(false);
  }, [tourKey, plan.length, phase]);

  // Selecting a load on the map pushes the camera in on that pallet.
  useEffect(() => {
    if (focusLoadId === null || plan.length === 0) return;
    const item = plan.find((candidate) => candidate.load.id === focusLoadId);
    if (!item) return;
    setPlaying(false);
    setTimeline(plan.length);
    const box = cargoBox(item, plan.length, dims);
    goalRef.current.target = { x: box.center.x, y: box.center.y + 0.1, z: box.center.z };
    goalRef.current.zoom = clamp(2.3, ZOOM_MIN, ZOOM_MAX);
    setZoomPct(230);
  }, [focusLoadId, plan, dims]);

  useEffect(() => {
    if (!playing || maxTimeline === 0) return;
    const timer = window.setInterval(() => {
      setTimeline((current) => {
        if (current >= maxTimeline) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 850);
    return () => window.clearInterval(timer);
  }, [playing, maxTimeline]);

  // Backing store follows the element's CSS box so nothing renders blurry.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(240, Math.round(rect.width));
      const height = Math.max(160, Math.round(rect.height));
      const ratio = Math.min(2.5, window.devicePixelRatio || 1);
      sizeRef.current = { width, height };
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext('2d');
      if (context) context.setTransform(ratio, 0, 0, ratio, 0, 0);
      dirtyRef.current = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // React attaches wheel passively, so zoom needs a native non-passive listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      // Same contract as the map: a bare wheel belongs to the page, or the
      // telemetry rail becomes another place the scroll dies. Ctrl/⌘ zooms the
      // model, and the zoom buttons beside the viewport always work.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const goal = goalRef.current;
      const before = goal.zoom;
      const next = clamp(before * Math.exp(-event.deltaY * 0.0016), ZOOM_MIN, ZOOM_MAX);
      if (next === before) return;
      const rect = canvas.getBoundingClientRect();
      const { width, height } = sizeRef.current;
      panTowardCursor(
        goal,
        event.clientX - rect.left - width * 0.5,
        event.clientY - rect.top - height * 0.58,
        width,
        before,
        next,
      );
      goal.zoom = next;
      setZoomPct(Math.round(next * 100));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // One animation loop: eases the camera, advances the scan, redraws when dirty.
  useEffect(() => {
    let frame = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const view = viewRef.current;
      const goal = goalRef.current;
      let moving = false;
      const ease = (from: number, to: number) => {
        const delta = to - from;
        if (Math.abs(delta) < 0.0004) return to;
        moving = true;
        return from + delta * 0.2;
      };
      view.yaw = ease(view.yaw, goal.yaw);
      view.pitch = ease(view.pitch, goal.pitch);
      view.zoom = ease(view.zoom, goal.zoom);
      view.target = {
        x: ease(view.target.x, goal.target.x),
        y: ease(view.target.y, goal.target.y),
        z: ease(view.target.z, goal.target.z),
      };

      if (morphRef.current < 1) {
        const progress = Math.min(1, (now - morphStartRef.current) / 1100);
        morphRef.current = 1 - Math.pow(1 - progress, 3);
        moving = true;
        if (progress >= 1) {
          morphRef.current = 1;
          setScanning(false);
        }
      }

      if (!moving && !dirtyRef.current) return;
      dirtyRef.current = false;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      const { width, height } = sizeRef.current;
      drawScene(context, width, height, view, morphRef.current, sceneRef.current);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const beginDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gestureRef.current = null;
  };

  const moveDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const pointers = pointersRef.current;
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);
    const goal = goalRef.current;

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const last = gestureRef.current;
      if (last && last.distance > 0) {
        const before = goal.zoom;
        const next = clamp(before * (distance / last.distance), ZOOM_MIN, ZOOM_MAX);
        panView(goal, mid.x - last.mid.x, mid.y - last.mid.y, sizeRef.current.width);
        goal.zoom = next;
        setZoomPct(Math.round(next * 100));
      }
      gestureRef.current = { distance, mid };
      return;
    }

    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    if (event.shiftKey || event.buttons === 4 || event.buttons === 2) {
      panView(goal, dx, dy, sizeRef.current.width);
      return;
    }
    goal.yaw += dx * 0.011;
    goal.pitch = clamp(goal.pitch - dy * 0.008, PITCH_MIN, PITCH_MAX);
  };

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) gestureRef.current = null;
  };

  const nudgeView = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const goal = goalRef.current;
    const step = event.shiftKey ? 0.26 : 0.13;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      goal.yaw += event.key === 'ArrowLeft' ? -step : step;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      goal.pitch = clamp(goal.pitch + (event.key === 'ArrowUp' ? step : -step), PITCH_MIN, PITCH_MAX);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      applyZoom(goal.zoom * 1.28);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      applyZoom(goal.zoom / 1.28);
    } else if (event.key === 'Home' || event.key === '0') {
      event.preventDefault();
      resetView();
    }
  };

  const hasRun = phase === 'done' && plan.length > 0;
  const timelineStatus = describeTimeline(plan, timeline, phase, hasRun);
  const invalidCombination = !isCompatibleSelection(vehicleType, cargoCondition);
  const selectedItem =
    plan.find((item) => item.load.id === focusLoadId) ??
    [...plan].sort((a, b) => a.unloadOrder - b.unloadOrder)[0];

  return (
    <section className="truck-lab" aria-label="3D 적재 시뮬레이터">
      <div className="truck-lab-head">
        <div>
          <span>LOAD DIGITAL TWIN</span>
          <h4>3D 적재 시뮬레이터</h4>
        </div>
        <span className={`truck-scan-state${scanning ? ' scanning' : ''}`}>
          <i />
          {scanning ? '모델 스캔 중' : vehicle.code}
        </span>
      </div>

      <div className="truck-viewport">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`${vehicleType} 3D 모델. 드래그로 회전, 휠로 확대, Shift 드래그로 이동합니다.`}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={resetView}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={nudgeView}
        />
        <div className="truck-view-badges" aria-hidden="true">
          <span>{vehicleType}</span>
          <span>{cargoCondition}</span>
          <span>{truckTons} TON</span>
        </div>
        <div className="truck-zoom-controls" aria-label="3D 모델 확대 축소">
          <button
            type="button"
            aria-label="트럭 확대"
            onClick={() => applyZoom(goalRef.current.zoom * 1.35)}
          >+</button>
          <span>{zoomPct}%</span>
          <button
            type="button"
            aria-label="트럭 축소"
            onClick={() => applyZoom(goalRef.current.zoom / 1.35)}
          >−</button>
        </div>
        <span className="truck-drag-hint">DRAG 360° · ⌘/CTRL SCROLL ZOOM · SHIFT PAN · DBL CLICK RESET</span>
        {scanning && <i className="truck-holo-sweep" />}
        {viewportGrip}
      </div>

      <div className="truck-status-row">
        <div>
          <strong>{timelineStatus.title}</strong>
          <small>{timelineStatus.detail}</small>
        </div>
        <div className="truck-playback">
          <button
            type="button"
            disabled={maxTimeline === 0 || !hasRun}
            onClick={() => {
              if (timeline >= maxTimeline) setTimeline(0);
              setPlaying((current) => !current);
            }}
          >
            {playing ? '일시정지' : timeline >= maxTimeline ? '다시 재생' : '재생'}
          </button>
          <button
            type="button"
            disabled={maxTimeline === 0 || !hasRun}
            onClick={() => {
              setPlaying(false);
              setTimeline(0);
            }}
          >
            초기화
          </button>
        </div>
      </div>

      <div className="truck-timeline" aria-label="적재 시뮬레이션 진행률">
        <span style={{ width: `${maxTimeline ? (timeline / maxTimeline) * 100 : 0}%` }} />
      </div>

      {totalLoadCount > 0 && (
        <div className="truck-sim-gate">
          <div>
            <b>등록 화물 {plan.length}/{totalLoadCount}건</b>
            <span>지도에서 화물을 선택하고 옵션을 확정하면 상자가 추가됩니다.</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setTimeline(0);
              setPlaying(true);
            }}
            disabled={!hasRun}
          >
            상하차 순서 재생
          </button>
        </div>
      )}

      {plan.length > 0 ? (
        <ol className="load-manifest">
          {[...plan]
            .sort((a, b) => a.loadOrder - b.loadOrder)
            .map((item) => {
              return (
              <li key={item.load.id} className={selectedItem?.load.id === item.load.id ? 'selected' : ''}>
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setTimeline(plan.length);
                    onFocusLoad?.(item.load.id);
                    const box = cargoBox(item, plan.length, dims);
                    goalRef.current.target = {
                      x: box.center.x,
                      y: box.center.y + 0.1,
                      z: box.center.z,
                    };
                    applyZoom(2.3);
                  }}
                >
                  <span
                    className="cargo-swatch"
                    style={{ background: CARGO_COLORS[item.profile] }}
                  />
                  <span className="load-order">상차 {item.loadOrder}</span>
                  <span className="load-copy">
                    <b>{item.load.goods}</b>
                    <small>
                      {PROFILE_LABEL[item.profile]} · {item.load.tons}t · {item.dimensions.lengthM.toFixed(2)}×{item.dimensions.widthM.toFixed(2)}×{item.dimensions.heightM.toFixed(2)}m · {item.destination} 하역
                      {` · ${item.selectedOption}`}
                    </small>
                  </span>
                  <span className="unload-order">
                    {item.deckSide === 'center' ? '중앙' : item.deckSide === 'left' ? '좌측' : '우측'} · 하역 {item.unloadOrder}
                  </span>
                </button>
              </li>
              );
            })}
        </ol>
      ) : (
        <p className={`load-empty${invalidCombination ? ' invalid' : ''}`}>
          <b>
            {phase === 'running'
              ? '최적 적재 순서를 계산 중입니다.'
              : totalLoadCount > 0
                ? '지도에서 화물을 선택해 모델에 추가하세요.'
                : '회차 확정 후 화물을 선택할 수 있습니다.'}
          </b>
          <span>
            {totalLoadCount > 0
              ? '적재 옵션을 고른 뒤 추가 버튼을 눌러야 상자가 표시됩니다.'
              : compatibilityNote(vehicleType, cargoCondition)}
          </span>
        </p>
      )}

      {selectedItem && (
        <div className="truck-load-method">
          <div className="truck-load-method-head">
            <span>SELECTED CARGO · 하역 {selectedItem.unloadOrder}</span>
            <b>{selectedItem.load.goods} · {selectedItem.destination}</b>
            <small>{selectedItem.placementReason}</small>
          </div>
          <div className="truck-load-method-options" role="group" aria-label={`${selectedItem.load.goods} 적재 방식`}>
            {loadTreatmentOptions(selectedItem.load).map((option) => (
              <button
                type="button"
                key={option}
                className={selectedItem.selectedOption === option ? 'selected' : ''}
                aria-pressed={selectedItem.selectedOption === option}
                onClick={() => onSelectLoadOption?.(selectedItem.load.id, option)}
                disabled={!onSelectLoadOption}
              >
                <i />
                <span>{option}</span>
              </button>
            ))}
          </div>
          <small className="truck-load-method-note">
            선택한 방식에 따라 상자 방향·높이·고정구·주변 간격이 즉시 재계산됩니다.
          </small>
        </div>
      )}

      <p className="truck-rule">
        <b>적재 원칙</b>
        상자 {plan.length}/{totalLoadCount}개 · 적재 {plan.reduce((sum, item) => sum + item.load.tons, 0)}t · 동일 화물은 한 번만 등록됩니다.
      </p>
    </section>
  );
}

function describeTimeline(
  plan: LoadingPlanItem[],
  timeline: number,
  phase: Phase,
  hasRun: boolean,
) {
  if (phase === 'running') {
    return { title: '경로와 적재 제약 동시 계산', detail: '도착 순서가 바뀔 때마다 적재안도 재배열됩니다.' };
  }
  if (plan.length === 0) {
    return { title: '차량 디지털 트윈 준비', detail: '최적화를 실행하면 실제 화물 순서가 모델에 표시됩니다.' };
  }
  if (!hasRun) {
    return {
      title: '최적화 결과 1차 확정',
      detail: `경유지 ${plan.length}곳 · 결과 화물 수만큼 상자를 등록하는 중입니다.`,
    };
  }
  if (timeline === 0) {
    return { title: '후문 기준 역순 적재 준비', detail: `${plan.length}개 목적지 · LIFO 하역 규칙` };
  }
  if (timeline <= plan.length) {
    const item = plan.find((candidate) => candidate.loadOrder === timeline) ?? plan[0];
    return {
      title: `${timeline}/${plan.length} · ${item.load.goods} 적재`,
      detail: `${item.destination} ${item.unloadOrder}차 하역 · 적재함 ${item.unloadOrder === 1 ? '후문' : '안쪽'} 배치`,
    };
  }
  const unloadOrder = timeline - plan.length;
  const item = plan.find((candidate) => candidate.unloadOrder === unloadOrder) ?? plan[0];
  if (unloadOrder >= plan.length) {
    return { title: '전 목적지 하역 완료', detail: '재배치 없이 순서대로 꺼내 공차 회차를 이어갑니다.' };
  }
  return {
    title: `${unloadOrder}차 · ${item.destination} 하역`,
    detail: `${item.load.goods} ${item.load.tons}t · 다음 화물 이동 없음`,
  };
}

/* ---------------------------------------------------------------- geometry */

type Dims = ReturnType<typeof truckDims>;

// One source of truth for the chassis so cargo, wheels and body stay aligned.
function truckDims(tons: number) {
  const stretch = clamp(0.86 + tons * 0.034, 0.86, 1.28);
  const deckFront = -1.5;
  const deckLength = 5 * stretch;
  const deckRear = deckFront + deckLength;
  const deckTop = 1.12;
  const halfWidth = 1.16;
  const cabRear = -1.66;
  const cabFront = -3.38;
  const cabRoof = 2.94;
  const wheelRadius = 0.5;
  const tandem = tons >= 8;
  const rearAxle = deckRear - 1.32;
  const axles = tandem ? [-2.52, rearAxle - 1.2, rearAxle] : [-2.52, rearAxle];
  return {
    stretch,
    deckFront,
    deckRear,
    deckLength,
    deckTop,
    halfWidth,
    cabFront,
    cabRear,
    cabRoof,
    wheelRadius,
    axles,
    boxTop: deckTop + 1.94,
  };
}

function cargoBox(item: LoadingPlanItem, count: number, dims: Dims) {
  const usable = dims.deckLength - 0.4;
  const slot = Math.min(1.55, usable / Math.max(1, count));
  const x = dims.deckRear - 0.2 - slot * (item.unloadOrder - 0.5);
  const centered = item.deckSide === 'center';
  const footprintLength =
    item.orientation === 'transverse' ? item.dimensions.widthM : item.dimensions.lengthM;
  const footprintWidth =
    item.orientation === 'transverse' ? item.dimensions.lengthM : item.dimensions.widthM;
  const lengthFactor = clamp(footprintLength / 2.4, 0.5, 0.98);
  const sizeZ = clamp(
    footprintWidth * (centered ? 1.08 : 0.82),
    dims.halfWidth * 0.68,
    centered ? dims.halfWidth * 1.78 : dims.halfWidth * 0.96,
  );
  const z = centered ? 0 : (item.deckSide === 'left' ? -1 : 1) * dims.halfWidth * 0.5;
  const height = clamp(item.dimensions.heightM * (item.stacked ? 1.25 : 0.82), 0.5, 1.82);
  return {
    center: { x, y: dims.deckTop + height / 2, z },
    size: {
      x: slot * (item.stacked ? 0.68 : 0.88) * lengthFactor,
      y: height,
      z: sizeZ * (item.stacked ? 0.86 : 1),
    },
  };
}

function buildCargoTreatment(
  item: LoadingPlanItem,
  box: ReturnType<typeof cargoBox>,
  alpha: number,
): Prim[] {
  const prims: Prim[] = [];
  const push = (center: Point3, size: Point3, color: string, translucent = false) => {
    prims.push({
      polys: boxPolys(center, size, color, alpha, 'rgba(255,255,255,0.25)'),
      translucent,
    });
  };
  const bottom = box.center.y - box.size.y / 2;
  const top = box.center.y + box.size.y / 2;
  const xEdge = box.size.x / 2;
  const zEdge = box.size.z / 2;

  if (item.selectedOption === '표준 팔레트 고정') {
    push(
      { x: box.center.x, y: bottom - 0.07, z: box.center.z },
      { x: box.size.x * 1.08, y: 0.12, z: box.size.z * 1.1 },
      '#ad7742',
    );
    for (const z of [-0.34, 0, 0.34]) {
      push(
        { x: box.center.x, y: bottom - 0.145, z: box.center.z + z * box.size.z },
        { x: box.size.x * 0.94, y: 0.07, z: 0.08 },
        '#6f4729',
      );
    }
  } else if (item.selectedOption === '미끄럼 방지 매트') {
    push(
      { x: box.center.x, y: bottom - 0.035, z: box.center.z },
      { x: box.size.x * 1.14, y: 0.07, z: box.size.z * 1.16 },
      '#182b2d',
    );
    for (const x of [-0.34, 0, 0.34]) {
      push(
        { x: box.center.x + x * box.size.x, y: bottom - 0.073, z: box.center.z },
        { x: 0.035, y: 0.015, z: box.size.z * 1.08 },
        '#48d9c9',
      );
    }
  } else if (item.selectedOption === '가로 팔레트 고정') {
    push(
      { x: box.center.x, y: bottom - 0.07, z: box.center.z },
      { x: box.size.x * 1.08, y: 0.12, z: box.size.z * 1.1 },
      '#b48452',
    );
    for (const x of [-0.28, 0.28]) {
      push(
        { x: box.center.x + x * box.size.x, y: bottom - 0.145, z: box.center.z },
        { x: 0.08, y: 0.07, z: box.size.z * 0.94 },
        '#6f4729',
      );
    }
  } else if (item.selectedOption === '2단 적층 · 래칫 결박') {
    push(
      { x: box.center.x, y: box.center.y, z: box.center.z },
      { x: box.size.x * 1.03, y: 0.055, z: box.size.z * 1.04 },
      '#704a2d',
    );
    for (const x of [-0.24, 0.24]) {
      const strapX = box.center.x + box.size.x * x;
      push({ x: strapX, y: top + 0.025, z: box.center.z }, { x: 0.07, y: 0.05, z: box.size.z * 1.12 }, '#fee500');
      for (const z of [-1, 1]) {
        push(
          { x: strapX, y: box.center.y, z: box.center.z + z * (zEdge + 0.025) },
          { x: 0.07, y: box.size.y, z: 0.05 },
          '#caa900',
        );
      }
    }
  } else if (item.selectedOption === '에어쿠션 완충') {
    for (const x of [-1, 1]) {
      for (const z of [-1, 1]) {
        push(
          { x: box.center.x + x * (xEdge + 0.055), y: box.center.y, z: box.center.z + z * (zEdge + 0.055) },
          { x: 0.13, y: box.size.y * 0.92, z: 0.13 },
          '#ff9ab5',
        );
      }
    }
  } else if (item.selectedOption === '보냉커버 이중 적용') {
    push(
      { x: box.center.x, y: box.center.y + 0.035, z: box.center.z },
      { x: box.size.x * 1.1, y: box.size.y * 1.12, z: box.size.z * 1.12 },
      '#d9f6ff',
      true,
    );
    push(
      { x: box.center.x, y: top + 0.09, z: box.center.z },
      { x: box.size.x * 1.14, y: 0.06, z: box.size.z * 1.16 },
      '#8bdcff',
      true,
    );
  } else if (item.selectedOption === '냉기순환 간격 확보') {
    for (const z of [-0.36, 0, 0.36]) {
      push(
        { x: box.center.x, y: bottom - 0.08, z: box.center.z + z * box.size.z },
        { x: box.size.x * 1.08, y: 0.12, z: 0.08 },
        '#58cfff',
      );
    }
    for (const x of [-0.42, 0.42]) {
      push(
        { x: box.center.x + x * box.size.x, y: box.center.y, z: box.center.z + zEdge + 0.07 },
        { x: 0.08, y: box.size.y * 0.82, z: 0.1 },
        '#a9edff',
      );
    }
  }
  return prims;
}

function buildTruck(vehicleType: VehicleType, dims: Dims, morph: number): Prim[] {
  const spec = VEHICLES[vehicleType];
  const prims: Prim[] = [];
  const solid = Math.max(0.1, morph);
  const push = (
    center: Point3,
    size: Point3,
    color: string,
    alpha = solid,
    stroke?: string,
  ) => {
    prims.push({ polys: boxPolys(center, size, color, alpha, stroke) });
  };

  const frameFront = dims.cabFront + 0.1;
  const frameRear = dims.deckRear + 0.14;
  const frameLength = frameRear - frameFront;
  const frameCx = (frameFront + frameRear) / 2;

  // Ladder frame.
  for (const railZ of [-0.44, 0.44]) {
    push({ x: frameCx, y: 0.76, z: railZ }, { x: frameLength, y: 0.2, z: 0.14 }, '#2d343c');
  }
  for (let i = 0; i <= 5; i++) {
    const x = frameFront + (frameLength * i) / 5;
    push({ x, y: 0.74, z: 0 }, { x: 0.12, y: 0.12, z: 0.9 }, '#262c33');
  }
  for (const axleX of dims.axles) {
    push({ x: axleX, y: dims.wheelRadius, z: 0 }, { x: 0.24, y: 0.24, z: 2.05 }, '#20262c');
  }

  // Cab-over cab, cut back from the deck so the two never intersect.
  const cabLength = dims.cabRear - dims.cabFront;
  const cabCx = (dims.cabFront + dims.cabRear) / 2;
  push({ x: cabCx, y: (0.88 + dims.cabRoof) / 2, z: 0 }, { x: cabLength, y: dims.cabRoof - 0.88, z: 2.24 }, '#f2c900');
  push({ x: cabCx, y: dims.cabRoof + 0.03, z: 0 }, { x: cabLength - 0.22, y: 0.08, z: 2.06 }, '#ffe14d');
  // Windshield, side glass, grille, bumper, lamps, mirrors, steps.
  push({ x: dims.cabFront + 0.06, y: 2.32, z: 0 }, { x: 0.08, y: 0.92, z: 1.96 }, '#12212e', 0.95 * solid);
  push({ x: cabCx + 0.2, y: 2.24, z: -1.13 }, { x: 0.9, y: 0.66, z: 0.06 }, '#16283a', 0.95 * solid);
  push({ x: cabCx + 0.2, y: 2.24, z: 1.13 }, { x: 0.9, y: 0.66, z: 0.06 }, '#16283a', 0.95 * solid);
  push({ x: dims.cabFront + 0.05, y: 1.44, z: 0 }, { x: 0.1, y: 0.5, z: 1.72 }, '#1d242b');
  push({ x: dims.cabFront - 0.04, y: 1.0, z: 0 }, { x: 0.16, y: 0.26, z: 2.16 }, '#aeb7bf');
  push({ x: dims.cabFront - 0.02, y: 1.02, z: -0.78 }, { x: 0.1, y: 0.16, z: 0.34 }, '#fff3b8');
  push({ x: dims.cabFront - 0.02, y: 1.02, z: 0.78 }, { x: 0.1, y: 0.16, z: 0.34 }, '#fff3b8');
  for (const side of [-1, 1]) {
    push({ x: dims.cabFront + 0.28, y: 2.36, z: side * 1.32 }, { x: 0.06, y: 0.5, z: 0.1 }, '#1b2128');
    push({ x: dims.cabFront + 0.28, y: 2.1, z: side * 1.34 }, { x: 0.05, y: 0.34, z: 0.16 }, '#0f1418');
    push({ x: cabCx + 0.5, y: 0.72, z: side * 1.06 }, { x: 0.5, y: 0.07, z: 0.26 }, '#3a424a');
  }
  // Headboard between cab and deck, fuel tank, air tank.
  push({ x: dims.deckFront + 0.08, y: dims.deckTop + 0.72, z: 0 }, { x: 0.12, y: 1.44, z: 2.2 }, '#8d959d');
  push({ x: dims.deckFront + 0.95, y: 0.72, z: -0.92 }, { x: 1.0, y: 0.44, z: 0.42 }, '#9aa3aa');
  push({ x: dims.deckFront + 0.95, y: 0.72, z: 0.92 }, { x: 0.8, y: 0.34, z: 0.34 }, '#5d666d');

  const deckCx = (dims.deckFront + dims.deckRear) / 2;
  push({ x: deckCx, y: dims.deckTop - 0.09, z: 0 }, { x: dims.deckLength, y: 0.18, z: 2.32 }, '#6b7784');

  if (vehicleType === '카고') {
    // Drop-side gates plus stake pockets.
    for (const side of [-1, 1]) {
      push({ x: deckCx, y: dims.deckTop + 0.3, z: side * 1.14 }, { x: dims.deckLength, y: 0.62, z: 0.1 }, spec.accent);
    }
    push({ x: dims.deckRear + 0.05, y: dims.deckTop + 0.3, z: 0 }, { x: 0.1, y: 0.62, z: 2.28 }, spec.accent);
    for (let i = 1; i < 5; i++) {
      const x = dims.deckFront + (dims.deckLength * i) / 5;
      for (const side of [-1, 1]) {
        push({ x, y: dims.deckTop + 0.34, z: side * 1.19 }, { x: 0.09, y: 0.7, z: 0.09 }, '#59636e');
      }
    }
  } else {
    const boxLength = dims.deckLength + 0.1;
    const boxHeight = dims.boxTop - dims.deckTop;
    const shellAlpha = (vehicleType === '윙바디' ? 0.2 : 0.26) + morph * 0.16;
    // Roof and rails stay solid; the walls are the x-ray shell.
    push({ x: deckCx, y: dims.boxTop + 0.05, z: 0 }, { x: boxLength + 0.06, y: 0.1, z: 2.36 }, spec.accent);
    prims.push({
      polys: boxPolys(
        { x: deckCx, y: dims.deckTop + boxHeight / 2, z: 0 },
        { x: boxLength, y: boxHeight, z: 2.3 },
        spec.shell,
        shellAlpha,
      ),
      translucent: true,
    });
    for (let i = 0; i <= 5; i++) {
      const x = dims.deckFront + (dims.deckLength * i) / 5;
      for (const side of [-1, 1]) {
        push({ x, y: dims.deckTop + boxHeight / 2, z: side * 1.16 }, { x: 0.07, y: boxHeight, z: 0.07 }, '#7c858e', 0.72 * solid);
      }
    }
    if (vehicleType === '윙바디') {
      push({ x: deckCx, y: dims.boxTop - 0.02, z: 0 }, { x: boxLength * 0.72, y: 0.06, z: 0.12 }, spec.accent);
    }
    if (vehicleType === '냉장탑차') {
      push({ x: dims.deckFront - 0.16, y: dims.boxTop - 0.55, z: 0 }, { x: 0.3, y: 0.86, z: 1.34 }, '#dbe9ee');
      push({ x: dims.deckFront - 0.32, y: dims.boxTop - 0.55, z: 0 }, { x: 0.06, y: 0.5, z: 0.8 }, '#4b6e79');
    }
    // Rear doors read as a seam on the tail face.
    push({ x: dims.deckRear + 0.07, y: dims.deckTop + boxHeight / 2, z: 0 }, { x: 0.06, y: boxHeight - 0.1, z: 0.06 }, '#8f989f');
  }

  // Rear bumper and mud flaps.
  push({ x: frameRear + 0.1, y: 0.5, z: 0 }, { x: 0.14, y: 0.16, z: 2.1 }, '#aeb7bf');
  for (const side of [-1, 1]) {
    push({ x: dims.deckRear - 0.1, y: 0.28, z: side * 1.0 }, { x: 0.06, y: 0.44, z: 0.5 }, '#15191d');
  }

  for (const axleX of dims.axles) {
    const front = axleX < -1;
    const offsets = front ? [1] : [0.86, 1.16];
    for (const side of [-1, 1]) {
      for (const offset of offsets) {
        prims.push(wheelPrim({ x: axleX, z: side * offset }, dims.wheelRadius, 0.26, solid));
      }
    }
  }

  return prims;
}

const WHEEL_SEGMENTS = 22;

function wheelPrim(at: { x: number; z: number }, radius: number, width: number, alpha: number): Prim {
  const polys: Poly[] = [];
  const outward = at.z >= 0 ? 1 : -1;
  const z0 = at.z - width / 2;
  const z1 = at.z + width / 2;
  const ring = (r: number, z: number) =>
    Array.from({ length: WHEEL_SEGMENTS }, (_, index) => {
      const angle = (Math.PI * 2 * index) / WHEEL_SEGMENTS;
      return { x: at.x + Math.cos(angle) * r, y: radius + Math.sin(angle) * r, z };
    });

  const outerA = ring(radius, z0);
  const outerB = ring(radius, z1);
  for (let index = 0; index < WHEEL_SEGMENTS; index++) {
    const next = (index + 1) % WHEEL_SEGMENTS;
    const angle = (Math.PI * 2 * (index + 0.5)) / WHEEL_SEGMENTS;
    polys.push({
      pts: [outerA[index], outerA[next], outerB[next], outerB[index]],
      normal: { x: Math.cos(angle), y: Math.sin(angle), z: 0 },
      color: index % 2 === 0 ? '#191e23' : '#0f1316',
      alpha,
    });
  }
  for (const [z, sign] of [[z0, -1], [z1, 1]] as const) {
    polys.push({
      pts: ring(radius * 0.99, z),
      normal: { x: 0, y: 0, z: sign },
      color: '#15191d',
      alpha,
    });
  }
  // Rim and hub only on the outward face — the inner face is never seen.
  const face = outward > 0 ? z1 + 0.006 : z0 - 0.006;
  polys.push({
    pts: ring(radius * 0.6, face),
    normal: { x: 0, y: 0, z: outward },
    color: '#9fa9b1',
    alpha,
  });
  polys.push({
    pts: ring(radius * 0.24, face + outward * 0.006),
    normal: { x: 0, y: 0, z: outward },
    color: '#59626a',
    alpha,
  });
  return { polys };
}

/* ----------------------------------------------------------------- drawing */

function drawScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: View,
  morph: number,
  scene: Scene,
) {
  const { vehicleType, truckTons, plan, slotCount, timeline, focusLoadId } = scene;
  const dims = truckDims(truckTons);
  const centerX = width * 0.5;
  const centerY = height * 0.58;
  const focal = (CAMERA * width * view.zoom) / BASE_SPAN;

  // Clear in backing-store coordinates. Clearing through the DPR transform can
  // leave a fringe of old pixels after a fractional resize, which looks like a
  // second truck while the camera is moving.
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.restore();
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.filter = 'none';

  const toCamera = (point: Point3) =>
    rotate(
      { x: point.x - view.target.x, y: point.y - view.target.y, z: point.z - view.target.z },
      view.yaw,
      view.pitch,
    );
  const project = (point: Point3) => {
    const camera = toCamera(point);
    const scale = focal / Math.max(2.4, CAMERA - camera.z);
    return {
      x: centerX + camera.x * scale,
      y: centerY - camera.y * scale,
      depth: camera.z,
      scale,
    };
  };

  drawGrid(context, project, morph, dims, view.zoom);
  drawGroundShadow(context, project, morph, dims);

  const prims = buildTruck(vehicleType, dims, morph);
  const visibleCargo = plan.filter((item) => cargoVisible(item, timeline, slotCount));
  for (const item of visibleCargo) {
    const box = cargoBox(item, slotCount, dims);
    const focused = item.load.id === focusLoadId;
    prims.push({
      polys: boxPolys(
        box.center,
        box.size,
        CARGO_COLORS[item.profile],
        0.95 * Math.max(0.1, morph),
        focused ? '#fee500' : 'rgba(255,255,255,0.28)',
      ),
    });
    prims.push(...buildCargoTreatment(item, box, 0.98 * Math.max(0.1, morph)));
  }

  const wireframe = morph < 0.98;
  const drawPass = (pass: Prim[]) => {
    const queue = pass
      .map((prim) => {
        const faces = prim.polys
          .map((poly) => {
            const camPts = poly.pts.map(toCamera);
            const centroid = average(camPts);
            // Cull the far face for both solid and translucent boxes. Drawing
            // every wall of the x-ray body on top of itself reads as cloned
            // trucks rather than one transparent enclosure.
            const normalCam = rotate(poly.normal, view.yaw, view.pitch);
            const toEye = {
              x: -centroid.x,
              y: -centroid.y,
              z: CAMERA - centroid.z,
            };
            if (dot(normalCam, toEye) <= 0) return null;
            return { poly, depth: centroid.z };
          })
          .filter((face): face is { poly: Poly; depth: number } => face !== null)
          .sort((a, b) => a.depth - b.depth);
        if (faces.length === 0) return null;
        const depth = faces.reduce((sum, face) => sum + face.depth, 0) / faces.length;
        return { faces, depth };
      })
      .filter((entry): entry is { faces: { poly: Poly; depth: number }[]; depth: number } => entry !== null)
      .sort((a, b) => a.depth - b.depth);

    for (const entry of queue) {
      for (const { poly } of entry.faces) {
        if (poly.alpha <= 0.001) continue;
        const points = poly.pts.map(project);
        context.beginPath();
        points.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.closePath();
        context.fillStyle = shade(poly.color, poly.normal, poly.alpha * (0.24 + morph * 0.76));
        context.fill();
        if (wireframe) {
          context.strokeStyle = rgba('#64f4ff', 0.3 + (1 - morph) * 0.55);
          context.lineWidth = 1.2;
          context.stroke();
        } else if (poly.stroke) {
          context.strokeStyle = poly.stroke.startsWith('rgba') ? poly.stroke : rgba(poly.stroke, 0.85);
          context.lineWidth = 1.1;
          context.stroke();
        } else {
          context.strokeStyle = 'rgba(0,0,0,0.34)';
          context.lineWidth = 0.6;
          context.stroke();
        }
      }
    }
  };

  drawPass(prims.filter((prim) => !prim.translucent));
  drawPass(prims.filter((prim) => prim.translucent));
  drawCargoLabels(context, visibleCargo, slotCount, dims, project, morph, focusLoadId);
  context.restore();
}

function cargoVisible(item: LoadingPlanItem, timeline: number, count: number) {
  if (timeline <= count) return item.loadOrder <= timeline;
  return item.unloadOrder > timeline - count;
}

type Projector = (point: Point3) => { x: number; y: number; depth: number; scale: number };

function drawGrid(
  context: CanvasRenderingContext2D,
  project: Projector,
  morph: number,
  dims: Dims,
  zoom: number,
) {
  const xMin = dims.cabFront - 1.1;
  const xMax = dims.deckRear + 1.1;
  const zMin = -3.15;
  const zMax = 3.15;
  const step = 0.7;
  const zoomFade = clamp(1 / Math.sqrt(zoom), 0.42, 1);
  const alpha = (0.48 + (1 - morph) * 0.45) * zoomFade;
  context.save();
  context.lineWidth = 1;
  for (let x = xMin; x <= xMax + 0.001; x += step) {
    context.strokeStyle = rgba('#51e9ff', 0.09 * alpha);
    const a = project({ x, y: 0, z: zMin });
    const b = project({ x, y: 0, z: zMax });
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  for (let z = zMin; z <= zMax + 0.001; z += step) {
    context.strokeStyle = rgba('#51e9ff', (Math.abs(z) < 0.36 ? 0.16 : 0.09) * alpha);
    const a = project({ x: xMin, y: 0, z });
    const b = project({ x: xMax, y: 0, z });
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }

  const boundary = [
    { x: xMin, y: 0, z: zMin },
    { x: xMax, y: 0, z: zMin },
    { x: xMax, y: 0, z: zMax },
    { x: xMin, y: 0, z: zMax },
  ].map(project);
  context.beginPath();
  boundary.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.strokeStyle = rgba('#51e9ff', 0.2 * alpha);
  context.lineWidth = 1.2;
  context.stroke();
  context.restore();
}

function drawGroundShadow(
  context: CanvasRenderingContext2D,
  project: Projector,
  morph: number,
  dims: Dims,
) {
  const corners = [
    { x: dims.cabFront - 0.3, y: 0.002, z: -1.35 },
    { x: dims.deckRear + 0.4, y: 0.002, z: -1.35 },
    { x: dims.deckRear + 0.4, y: 0.002, z: 1.35 },
    { x: dims.cabFront - 0.3, y: 0.002, z: 1.35 },
  ].map(project);
  context.save();
  context.beginPath();
  corners.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.filter = 'blur(9px)';
  context.fillStyle = rgba('#000000', 0.42 * morph);
  context.fill();
  context.restore();
}

function drawCargoLabels(
  context: CanvasRenderingContext2D,
  items: LoadingPlanItem[],
  count: number,
  dims: Dims,
  project: Projector,
  morph: number,
  focusLoadId: number | null,
) {
  const labels = items
    .map((item) => {
      const box = cargoBox(item, count, dims);
      const point = project({ x: box.center.x, y: box.center.y + box.size.y / 2 + 0.34, z: box.center.z });
      return { item, point };
    })
    .sort((a, b) => a.point.depth - b.point.depth);

  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const { item, point } of labels) {
    const radius = clamp(point.scale * 0.16, 9, 22);
    const focused = item.load.id === focusLoadId;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = rgba('#070a0d', 0.82 * morph);
    context.fill();
    context.lineWidth = focused ? 2 : 1.2;
    context.strokeStyle = rgba(focused ? '#fee500' : CARGO_COLORS[item.profile], 0.92 * morph);
    context.stroke();
    context.fillStyle = rgba('#ffffff', morph);
    context.font = `600 ${Math.round(radius * 1.1)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    context.fillText(`${item.unloadOrder}`, point.x, point.y + 0.5);
  }
  context.restore();
}

/* ------------------------------------------------------------------- maths */

function boxPolys(
  center: Point3,
  size: Point3,
  color: string,
  alpha: number,
  stroke?: string,
): Poly[] {
  const x0 = center.x - size.x / 2;
  const x1 = center.x + size.x / 2;
  const y0 = center.y - size.y / 2;
  const y1 = center.y + size.y / 2;
  const z0 = center.z - size.z / 2;
  const z1 = center.z + size.z / 2;
  const point = (x: number, y: number, z: number) => ({ x, y, z });
  return [
    { pts: [point(x0, y0, z1), point(x1, y0, z1), point(x1, y1, z1), point(x0, y1, z1)], normal: { x: 0, y: 0, z: 1 }, color, alpha, stroke },
    { pts: [point(x1, y0, z0), point(x0, y0, z0), point(x0, y1, z0), point(x1, y1, z0)], normal: { x: 0, y: 0, z: -1 }, color, alpha, stroke },
    { pts: [point(x1, y0, z1), point(x1, y0, z0), point(x1, y1, z0), point(x1, y1, z1)], normal: { x: 1, y: 0, z: 0 }, color, alpha, stroke },
    { pts: [point(x0, y0, z0), point(x0, y0, z1), point(x0, y1, z1), point(x0, y1, z0)], normal: { x: -1, y: 0, z: 0 }, color, alpha, stroke },
    { pts: [point(x0, y1, z1), point(x1, y1, z1), point(x1, y1, z0), point(x0, y1, z0)], normal: { x: 0, y: 1, z: 0 }, color, alpha, stroke },
    { pts: [point(x0, y0, z0), point(x1, y0, z0), point(x1, y0, z1), point(x0, y0, z1)], normal: { x: 0, y: -1, z: 0 }, color, alpha, stroke },
  ];
}

function rotate(point: Point3, yaw: number, pitch: number): Point3 {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const x = point.x * cosYaw - point.z * sinYaw;
  const z = point.x * sinYaw + point.z * cosYaw;
  return {
    x,
    y: point.y * cosPitch + z * sinPitch,
    z: -point.y * sinPitch + z * cosPitch,
  };
}

// Camera basis in world space, used to pan the orbit target with the cursor.
function unrotate(point: Point3, yaw: number, pitch: number): Point3 {
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const y = point.y * cosPitch - point.z * sinPitch;
  const z = point.y * sinPitch + point.z * cosPitch;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  return { x: point.x * cosYaw + z * sinYaw, y, z: -point.x * sinYaw + z * cosYaw };
}

function panView(view: View, dx: number, dy: number, width: number) {
  const perPixel = BASE_SPAN / (width * view.zoom);
  const right = unrotate({ x: 1, y: 0, z: 0 }, view.yaw, view.pitch);
  const up = unrotate({ x: 0, y: 1, z: 0 }, view.yaw, view.pitch);
  view.target = clampTarget({
    x: view.target.x - right.x * dx * perPixel + up.x * dy * perPixel,
    y: view.target.y - right.y * dx * perPixel + up.y * dy * perPixel,
    z: view.target.z - right.z * dx * perPixel + up.z * dy * perPixel,
  });
}

function panTowardCursor(
  view: View,
  offsetX: number,
  offsetY: number,
  width: number,
  before: number,
  after: number,
) {
  const perPixel = BASE_SPAN / (width * before);
  const shift = 1 - before / after;
  const right = unrotate({ x: 1, y: 0, z: 0 }, view.yaw, view.pitch);
  const up = unrotate({ x: 0, y: 1, z: 0 }, view.yaw, view.pitch);
  view.target = clampTarget({
    x: view.target.x + (right.x * offsetX - up.x * offsetY) * perPixel * shift,
    y: view.target.y + (right.y * offsetX - up.y * offsetY) * perPixel * shift,
    z: view.target.z + (right.z * offsetX - up.z * offsetY) * perPixel * shift,
  });
}

function clampTarget(point: Point3): Point3 {
  return {
    x: clamp(point.x, -6, 7),
    y: clamp(point.y, -0.5, 4.5),
    z: clamp(point.z, -4, 4),
  };
}

function average(points: Point3[]): Point3 {
  const sum = points.reduce(
    (total, point) => ({ x: total.x + point.x, y: total.y + point.y, z: total.z + point.z }),
    { x: 0, y: 0, z: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length };
}

function dot(a: Point3, b: Point3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(point: Point3): Point3 {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  return { x: point.x / length, y: point.y / length, z: point.z / length };
}

// Lambert shading off the world-space normal, so faces relight as you orbit.
function shade(color: string, normal: Point3, alpha: number) {
  const lambert = 0.34 + 0.62 * Math.max(0, dot(normal, LIGHT)) + 0.1 * Math.max(0, normal.y);
  const [r, g, b] = hexToRgb(color);
  return `rgba(${Math.round(Math.min(255, r * lambert))}, ${Math.round(Math.min(255, g * lambert))}, ${Math.round(Math.min(255, b * lambert))}, ${alpha})`;
}

function rgba(color: string, alpha: number) {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cloneView(view: View): View {
  return { ...view, target: { ...view.target } };
}

function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
