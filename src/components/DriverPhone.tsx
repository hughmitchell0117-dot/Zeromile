import { useEffect, useState } from 'react';
import { CITIES } from '../lib/geo';
import { SITE_BY_ID, siteLabel, siteShort } from '../lib/sites';
import {
  COST_WON_PER_KM,
  clockFromHours,
  km,
  won,
  type Tour,
} from '../lib/model';
import { Check, Mic, Shield } from './ui';

const KO: Record<string, string> = Object.fromEntries(CITIES.map((c) => [c.id, c.ko]));
const locationLabel = (id: string) => (SITE_BY_ID[id] ? siteLabel(id) : KO[id] ?? id);

/** Drivers start the day at 06:00. */
const DAY_START = 6;

const VOICE_SCRIPT = [
  { me: false, text: '오늘 회차 3건 잡혔습니다. 읽어드릴까요?' },
  { me: true, text: '다음 루프' },
  { me: false, text: '두 번째 회차, 순수입 ₩512,000, 귀가 오후 6시 50분.' },
  { me: true, text: '수락' },
  { me: false, text: '세 구간 모두 예약 완료. 첫 상차지로 안내 시작합니다.' },
];

export default function DriverPhone({ tours }: { tours: Tour[] }) {
  const [tourIndex, setTourIndex] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [spoken, setSpoken] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const tour = tours[tourIndex] ?? null;

  useEffect(() => {
    setTourIndex(0);
    setAccepted(false);
    setSpoken(1);
  }, [tours]);

  if (!tour || tour.legs.length === 0) return <PhoneShell>{<Waiting />}</PhoneShell>;

  const totalKm = tour.loadedKm + tour.emptyKm;
  const loadedShare = Math.round((100 * tour.loadedKm) / totalKm);
  const homeAt = clockFromHours(DAY_START, tour.hours);
  const shipperTotal = tour.legs.reduce((s, l) => s + l.load.shipperPrice, 0);
  const brokerCut = shipperTotal - tour.revenue;

  // What the same three loads pay if you take only the first and drive home
  // empty — the counterfactual the driver lives today.
  const first = tour.legs[0].load;
  const soloNet =
    first.revenue -
    (first.km + tour.legs[0].deadheadKm + km(first.to, tour.driver.home)) *
      COST_WON_PER_KM;

  const nextTour = () => {
    setTourIndex((index) => (index + 1) % tours.length);
    setAccepted(false);
    setSpoken(3);
  };

  const speakSummary = () => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const route = tour.legs
      .map((leg) => `${KO[leg.load.from]}에서 ${KO[leg.load.to]}`)
      .join(', ');
    const utterance = new SpeechSynthesisUtterance(
      `${tour.driver.name}님의 오늘 회차입니다. ${route}. 예상 실수령은 ${Math.round(tour.net / 10000)}만원, 귀가 시각은 ${homeAt}입니다.`,
    );
    utterance.lang = 'ko-KR';
    utterance.rate = 0.92;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setSpoken(3);
  };

  return (
    <PhoneShell>
      <div className="phone-head">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {tour.driver.name} · 현재 {locationLabel(tour.driver.current ?? tour.driver.home)} ·{' '}
              {siteLabel(tour.driver.depot)} 차고지
            </div>
            <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.03em' }}>
              오늘의 회차
            </div>
          </div>
          <span className="tag good">
            <Check /> 귀가 {homeAt}
          </span>
        </div>
      </div>

      <div className="phone-scroll" tabIndex={0} aria-label="회차 상세 스크롤 영역">
        <div className="loop-card">
          <div
            className="row"
            style={{ justifyContent: 'space-between', marginBottom: 4 }}
          >
            <span className="metric-l">{tour.legs.length}개 구간 · 회차 확정</span>
            <span className="metric-sub" style={{ color: 'var(--blue-2)' }}>
              적재율 {loadedShare}%
            </span>
          </div>

          {tour.legs.map((leg, i) => (
            <div className="leg" key={i}>
              <div className="leg-rail">
                <span className="leg-node" />
              </div>
              <div>
                <div className="leg-route">
                  {KO[leg.load.from]} → {KO[leg.load.to]}
                </div>
                <div className="leg-site">
                  {siteShort(leg.load.fromSite)} {leg.load.fromBay}
                  {' → '}
                  {siteShort(leg.load.toSite)} {leg.load.toBay}
                </div>
                <div className="leg-meta">
                  {leg.load.ref} · {Math.round(leg.load.km)}km · {leg.load.tons}t ·{' '}
                  {leg.load.goods}
                  {leg.deadheadKm > 8 && ` · 공차 ${Math.round(leg.deadheadKm)}km`}
                </div>
              </div>
              <div className="leg-won">{won(leg.load.revenue)}</div>
            </div>
          ))}

          <div className="net-row">
            <div>
              <div className="metric-l" style={{ marginBottom: 7 }}>
                연료·통행료 차감 후 실수령
              </div>
              <div className="net-v" style={{ color: 'var(--green)' }}>
                {won(tour.net)}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="metric-sub">운임 {won(tour.revenue)}</div>
              <div className="metric-sub" style={{ color: 'var(--empty)' }}>
                비용 −{won(tour.cost)}
              </div>
            </div>
          </div>
        </div>

        <div className="guarantee">
          <Shield />
          <span>
            <b style={{ color: '#c6f5e4', fontWeight: 600 }}>Loop Guarantee</b> 적용
            — 2·3구간이 취소되면 공차 귀환 운임을 카카오가 지급합니다.
          </span>
        </div>

        <div
          className="card"
          style={{ padding: 14, borderRadius: 16, background: 'rgba(255,255,255,0.03)' }}
        >
          <div className="metric-l" style={{ marginBottom: 9 }}>
            운임 투명성
          </div>
          <Row label="화주 지급액" value={won(shipperTotal)} />
          <Row
            label="중개 수수료"
            value={`−${won(brokerCut)}`}
            tone="var(--empty)"
          />
          <Row label="기사 운임" value={won(tour.revenue)} strong />
          <div className="metric-sub dim" style={{ marginTop: 9, lineHeight: 1.55 }}>
            오늘 이 화물의 원가는 처음부터 표시됩니다.
          </div>
        </div>

        <button className={`voice ${speaking ? 'speaking' : ''}`} onClick={speakSummary}>
          <span style={{ color: 'var(--yellow)' }}>
            <Mic />
          </span>
          <span className="voice-wave" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
            {speaking ? '회차를 읽고 있습니다…' : '회차 음성으로 듣기'}
          </span>
        </button>

        {VOICE_SCRIPT.slice(0, spoken).map((line, i) => (
          <div className={`bubble ${line.me ? 'me' : ''}`} key={i}>
            {line.me ? '“' + line.text + '”' : line.text}
          </div>
        ))}

        <div className="metric-sub dim" style={{ marginTop: 2 }}>
          같은 화물을 단건으로 잡고 공차 귀환하면 {won(soloNet)}.
        </div>
      </div>

      {accepted && (
        <div className="booking-confirmation" role="status" aria-live="polite">
          <Check /> 전 구간 예약 완료 · 첫 상차지 안내를 시작합니다
        </div>
      )}

      <div className="phone-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            setAccepted(true);
            setSpoken(VOICE_SCRIPT.length);
          }}
          disabled={accepted}
        >
          {accepted ? '예약 완료' : '수락'}
        </button>
        <button className="btn btn-ghost" onClick={nextTour} disabled={tours.length < 2}>
          다른 루프
        </button>
      </div>
    </PhoneShell>
  );
}

function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: string;
  strong?: boolean;
}) {
  return (
    <div
      className="row"
      style={{
        justifyContent: 'space-between',
        fontSize: 13,
        padding: '4px 0',
        color: tone ?? (strong ? 'var(--ink)' : 'var(--ink-2)'),
        fontWeight: strong ? 560 : 400,
      }}
    >
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function PhoneShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="phone">
      <div className="phone-screen">
        <div className="phone-notch" />
        <div className="phone-status">
          <span>{clockFromHours(DAY_START, 0).replace('오전 ', '')}</span>
          <span style={{ letterSpacing: 2 }}>▂▄▆ 5G</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Waiting() {
  return (
    <div
      className="phone-scroll"
      style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
    >
      <div className="metric-l">회차 계산 대기 중</div>
      <p className="dim" style={{ fontSize: 13.5, maxWidth: 220 }}>
        위 콘솔에서 <b style={{ color: 'var(--ink-2)' }}>회차 최적화</b>를 실행하면
        기사 화면이 실제 결과로 채워집니다.
      </p>
    </div>
  );
}
