import type { Load, Tour } from './model';

export type VehicleType = '카고' | '윙바디' | '냉장탑차';
export type CargoCondition = '일반 화물' | '냉장·냉동' | '취급주의';
export type CargoProfile = 'general' | 'bulk' | 'cold' | 'fragile';

export const LOAD_TREATMENTS = [
  '표준 팔레트 고정',
  '미끄럼 방지 매트',
  '2중 래칫 결박',
  '에어쿠션 완충',
  '보냉커버 이중 적용',
  '냉기순환 간격 확보',
] as const;

export type LoadTreatment = (typeof LOAD_TREATMENTS)[number];

export type CargoDimensions = {
  lengthM: number;
  widthM: number;
  heightM: number;
};

export type LoadingPlanItem = {
  load: Load;
  profile: CargoProfile;
  loadOrder: number;
  unloadOrder: number;
  destination: string;
  slot: number;
  deckSide: 'left' | 'right' | 'center';
  zone: 'rear' | 'middle' | 'front';
  weightRank: number;
  selectedOption: string;
  secureMinutes: number;
  placementReason: string;
  dimensions: CargoDimensions;
};

type LoadOptionTraits = {
  center: boolean;
  low: boolean;
  airflow: boolean;
  fastAccess: boolean;
  secureMinutes: number;
};

const COLD_GOODS = new Set(['냉장식품', '농산물', '음료/주류']);
const FRAGILE_GOODS = new Set(['전자부품', '가전제품', '반도체 장비', '가구']);
const BULK_GOODS = new Set(['건축자재', '철강코일', '화학원료', '자동차부품']);

export function cargoProfile(goods: string): CargoProfile {
  if (COLD_GOODS.has(goods)) return 'cold';
  if (FRAGILE_GOODS.has(goods)) return 'fragile';
  if (BULK_GOODS.has(goods)) return 'bulk';
  return 'general';
}

export function canCarryLoad(
  load: Load,
  vehicleType: VehicleType,
  cargoCondition: CargoCondition,
): boolean {
  const profile = cargoProfile(load.goods);
  const matchesCondition =
    cargoCondition === '냉장·냉동'
      ? profile === 'cold'
      : cargoCondition === '취급주의'
        ? profile === 'fragile'
        : profile === 'general' || profile === 'bulk';

  if (!matchesCondition) return false;
  if (profile === 'cold') return vehicleType === '냉장탑차';
  if (profile === 'fragile') return vehicleType !== '카고';
  if (profile === 'bulk') return vehicleType !== '냉장탑차';
  return true;
}

export function buildLoadingPlan(
  tour: Tour,
  cityName: (id: string) => string,
  loadOptions: Record<number, string> = {},
): LoadingPlanItem[] {
  const count = tour.legs.length;
  const weightRank = new Map(
    [...tour.legs]
      .sort((a, b) => b.load.tons - a.load.tons)
      .map((leg, index) => [leg.load.id, index + 1]),
  );
  const side = new Map<number, LoadingPlanItem['deckSide']>();
  let leftTons = 0;
  let rightTons = 0;
  for (const leg of [...tour.legs].sort((a, b) => b.load.tons - a.load.tons)) {
    const traits = loadOptionTraits(loadOptions[leg.load.id] ?? '', cargoProfile(leg.load.goods));
    if (count === 1 || traits.center || traits.airflow) {
      side.set(leg.load.id, 'center');
    } else if (leftTons <= rightTons) {
      side.set(leg.load.id, 'left');
      leftTons += leg.load.tons;
    } else {
      side.set(leg.load.id, 'right');
      rightTons += leg.load.tons;
    }
  }

  return tour.legs.map((leg, index) => {
    const profile = cargoProfile(leg.load.goods);
    const selectedOption = loadOptions[leg.load.id] ?? defaultLoadOption(profile, leg.load.tons);
    const traits = loadOptionTraits(selectedOption, profile);
    const deckSide = side.get(leg.load.id) ?? 'center';
    const zone = index === 0 ? 'rear' : index === count - 1 ? 'front' : 'middle';
    return {
      load: leg.load,
      profile,
      // Destination accessibility is a hard constraint: later drops load first.
      // Options then choose the safest floor/side position inside that sequence.
      loadOrder: count - index,
      unloadOrder: index + 1,
      destination: cityName(leg.load.to),
      slot: index,
      deckSide,
      zone,
      weightRank: weightRank.get(leg.load.id) ?? 1,
      selectedOption,
      secureMinutes: traits.secureMinutes,
      placementReason: placementReason(traits, deckSide, zone, leg.load.tons),
      dimensions: cargoDimensions(leg.load),
    };
  });
}

function defaultLoadOption(profile: CargoProfile, tons: number): string {
  if (profile === 'cold') return '냉기순환 간격 확보';
  if (profile === 'fragile') return '에어쿠션 완충';
  if (profile === 'bulk' || tons >= 4) return '미끄럼 방지 매트';
  return '표준 팔레트 고정';
}

/** Representative bundled footprint used by the digital twin, in metres. */
export function cargoDimensions(load: Load): CargoDimensions {
  const profile = cargoProfile(load.goods);
  const jitter = ((load.id * 37) % 11) / 100;
  const base =
    profile === 'bulk'
      ? { lengthM: 1.35 + load.tons * 0.2, widthM: 1.02, heightM: 0.58 + load.tons * 0.07 }
      : profile === 'cold'
        ? { lengthM: 1.2 + load.tons * 0.18, widthM: 1.08, heightM: 0.92 + load.tons * 0.1 }
        : profile === 'fragile'
          ? { lengthM: 1.1 + load.tons * 0.2, widthM: 0.96, heightM: 1.02 + load.tons * 0.09 }
          : { lengthM: 1.15 + load.tons * 0.19, widthM: 1, heightM: 0.82 + load.tons * 0.1 };
  return {
    lengthM: roundDimension(base.lengthM + jitter),
    widthM: roundDimension(base.widthM + jitter * 0.6),
    heightM: roundDimension(base.heightM + jitter * 0.8),
  };
}

function roundDimension(value: number) {
  return Math.round(value * 100) / 100;
}

function loadOptionTraits(option: string, profile: CargoProfile): LoadOptionTraits {
  return {
    center: option.includes('중앙') || option.includes('무진동'),
    low: option.includes('저상') || option.includes('매트') || profile === 'bulk',
    airflow: option.includes('냉기순환'),
    fastAccess: option.includes('후문') || option.includes('우선'),
    secureMinutes: option.includes('2중')
      ? 18
      : option.includes('완충') || option.includes('보냉') || option.includes('무진동')
        ? 14
        : option.includes('결박') || option.includes('매트')
          ? 11
          : 7,
  };
}

function placementReason(
  traits: LoadOptionTraits,
  side: LoadingPlanItem['deckSide'],
  zone: LoadingPlanItem['zone'],
  tons: number,
): string {
  const position = `${zone === 'rear' ? '후문' : zone === 'front' ? '전방' : '중앙부'} · ${side === 'center' ? '차축 중앙' : side === 'left' ? '좌측' : '우측'}`;
  if (traits.airflow) return `${position}, 냉기 통로를 비워 온도 편차 최소화`;
  if (traits.low || tons >= 4) return `${position}, 중량물을 바닥에 고정해 무게중심 하강`;
  if (traits.fastAccess) return `${position}, 하역 접근성을 우선하되 목적지 역순 유지`;
  return `${position}, 좌우 누적중량과 하역 접근성 동시 최적화`;
}

export function compatibilityNote(
  vehicleType: VehicleType,
  cargoCondition: CargoCondition,
): string {
  if (vehicleType === '카고' && cargoCondition === '냉장·냉동') {
    return '카고는 온도 유지 화물을 배차할 수 없습니다.';
  }
  if (vehicleType === '카고' && cargoCondition === '취급주의') {
    return '취급주의 화물은 밀폐 적재함 차량만 제안됩니다.';
  }
  if (vehicleType === '냉장탑차' && cargoCondition === '일반 화물') {
    return '냉장탑차에는 부피가 큰 개방형 화물을 제외합니다.';
  }
  return `${vehicleType} 적재 기준에 맞는 ${cargoCondition}만 경로에 포함됩니다.`;
}

export function isCompatibleSelection(
  vehicleType: VehicleType,
  cargoCondition: CargoCondition,
): boolean {
  return !(
    vehicleType === '카고' &&
    (cargoCondition === '냉장·냉동' || cargoCondition === '취급주의')
  );
}
