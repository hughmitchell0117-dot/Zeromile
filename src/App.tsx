import { useEffect, useMemo, useState } from 'react';
import DemoConsole, {
  type DemoResult,
  type MoveTally,
  type SolvePoint,
} from './components/DemoConsole';
import DriverPhone from './components/DriverPhone';
import KoreaMap from './components/KoreaMap';
import Agent, { AgentLauncher } from './components/Agent';
import { useTheme, type Theme } from './lib/theme';
import { Reveal } from './components/ui';
import { generateDrivers, generateLoads } from './lib/generate';
import { buildBaseline } from './lib/solver';
import {
  won,
  COST_WON_PER_KM,
  FUEL_WON_PER_KM,
  TOLL_WON_PER_KM,
  HOME_RADIUS_KM,
  LEG_HANDLING_HOURS,
  MAX_DUTY_HOURS,
  type Tour,
} from './lib/model';
import { CITIES } from './lib/geo';
import { siteLabel } from './lib/sites';

const SECTIONS = [
  { id: 'reframe', n: '01', label: '작동 방식' },
  { id: 'lab', n: '02', label: '시뮬레이터' },
  { id: 'driver', n: '03', label: '기사 화면' },
  { id: 'moat', n: '04', label: '사업 가치' },
  { id: 'method', n: '05', label: '방법' },
];

/**
 * The page is a printed dispatch sheet: ruled sections, numbered plates, one
 * signal colour. The map, the console and the phone are the live inserts.
 */
export default function App() {
  const [result, setResult] = useState<DemoResult | null>(null);
  const [active, setActive] = useState('lab');
  const { theme, toggle: toggleTheme } = useTheme();

  /*
   * The agent has two switches, not one. `agentArmed` is the microphone: once
   * it is on, recognition runs for the whole session and the wake word can
   * open the panel from anywhere. `agentOpen` is just whether the panel is on
   * screen. Clicking the masthead key arms the mic *and* opens the panel;
   * closing the panel leaves the mic armed, so "제로마일" still works.
   */
  const [agentArmed, setAgentArmed] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '-30% 0px -56% 0px', threshold: [0, 0.2, 0.5] },
    );
    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  // A quiet network under the hero plate — same generator, fewer trucks.
  const ambient = useMemo(() => {
    const loads = generateLoads(120, 5150);
    const drivers = generateDrivers(70, 991);
    return buildBaseline(drivers, loads, 8080);
  }, []);

  return (
    <>
      <Masthead
        active={active}
        theme={theme}
        onToggleTheme={toggleTheme}
        agentArmed={agentArmed}
        agentOpen={agentOpen}
        onToggleAgent={() => {
          if (agentArmed && agentOpen) {
            setAgentArmed(false);
            setAgentOpen(false);
            return;
          }
          setAgentArmed(true);
          setAgentOpen(true);
        }}
      />

      <Agent
        armed={agentArmed}
        open={agentOpen}
        onOpen={() => setAgentOpen(true)}
        onClose={() => setAgentOpen(false)}
      />

      {/* ── 00 · Hero ─────────────────────────────────────────────────── */}
      <header className="zm-hero" id="top">
        <div className="zm-shell">
          <div className="zm-hero-top">
            <span>ZeroMile 배차 엔진</span>
            <span>대한민국 · 30개 도시 · 75개 물류거점</span>
            <span>Rev. 002 — 회차 우선</span>
          </div>

          <div className="zm-hero-grid">
            <div>
              <Reveal>
                <h1 className="zm-h1 ko">
                  공차율로 인한
                  <br />
                  모든 손실을
                  <br />
                  <em>0으로.</em>
                </h1>
              </Reveal>

              <Reveal delay={140}>
                <p className="zm-hero-lede ko">
                  끊어진 편도 화물을 복귀까지 이어지는 하나의 회차로 연결합니다.
                  공차 이동에서 새던 연료비·통행료·기사님의 시간을 수익 운행으로
                  전환하고, 출발 전에 복귀 시각과 실수령액을 확정합니다.
                </p>
              </Reveal>

              <Reveal delay={220}>
                <div className="zm-hero-cta">
                  <a className="zm-btn zm-btn-fill" href="#lab">
                    라이브 시뮬레이션 실행
                  </a>
                  <a className="zm-btn" href="#reframe">
                    작동 방식 →
                  </a>
                </div>
              </Reveal>

              <Reveal delay={300} className="no-blur">
                <DayContrast />
              </Reveal>
            </div>

            <Reveal delay={120} className="no-blur">
              <figure className="zm-plate" style={{ margin: 0 }}>
                <figcaption className="zm-plate-cap">
                  <span>PLATE 00 — 전국 회차 흐름</span>
                  <span className="zm-live">
                    <i />
                    LIVE
                  </span>
                </figcaption>
                <div className="zm-hero-map">
                  <KoreaMap key={theme} tours={ambient} ambient />
                </div>
                <div className="zm-plate-foot">
                  OSRM 실거리 라우팅 · 합성 수요 120건 / 트럭 70대 · 브라우저 로컬 연산
                </div>
              </figure>
            </Reveal>
          </div>

          <div className="zm-figures">
            <Figure k="38.1 → 14.4%" l="합성 기준일 공차율" signal />
            <Figure k="+80%" l="기사 1인 일 순수입" />
            <Figure k="2–4 구간" l="한 번에 예약되는 회차" />
            <Figure k="60km" l="차고지 복귀 반경 보장" />
          </div>
        </div>
      </header>

      <Marquee />

      <main>
        {/* ── 01 · Problem ────────────────────────────────────────────── */}
        <section id="problem" className="zm-section">
          <div className="zm-shell">
            <Reveal>
              <div className="zm-head">
                <span className="zm-head-n">01</span>
                <div>
                  <span className="zm-kicker">The problem</span>
                  <h2 className="ko">세 가지 비효율이 운송 수익을 낮춥니다.</h2>
                  <p className="ko">
                    기존 화물 운송은{' '}
                    <strong>공차 운행, 복잡한 주선 구조, 선착순 배차</strong>가 동시에
                    발생하며 운송 효율과 기사 수익성을 떨어뜨립니다.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="zm-body zm-rows">
              {PROBLEMS.map((p, i) => (
                <Reveal key={p.title} delay={i * 70}>
                  <div className="zm-row">
                    <span className="zm-row-n">{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <h3 className="zm-row-t ko">{p.title}</h3>
                      <span className={`zm-row-k ${p.neutral ? 'mute' : ''}`}>{p.k}</span>
                    </div>
                    <p className="zm-row-d ko">{p.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal>
              <div className="zm-chain">
                {LAYERS.map((l) => (
                  <div key={l.name}>
                    <b className="ko">{l.name}</b>
                    <span className={l.cut ? '' : 'none'}>{l.cut ? `−${l.cut}` : '—'}</span>
                  </div>
                ))}
              </div>
              <p className="zm-note ko">
                각 단계는 정보를 조금씩 가립니다. 기사가 마지막에 보는 것은 가격
                하나뿐이고, 그 가격이 기름값과 통행료를 빼고 실제로 남는 돈인지 판단할
                근거는 화면에 없습니다.
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── 02 · Reframe ────────────────────────────────────────────── */}
        <section id="reframe" className="zm-section">
          <div className="zm-shell">
            <Reveal>
              <div className="zm-head">
                <span className="zm-head-n">01</span>
                <div>
                  <span className="zm-kicker">The reframe</span>
                  <h2 className="ko">
                    화물을 매칭하지 않습니다. <em>하루</em>를 매칭합니다.
                  </h2>
                  <p className="ko">
                    목적 함수가 다릅니다. “이 화물을 채운다”가 아니라 “이 기사의 하루
                    시간당 순수입을, 차고지로 돌아온다는 제약 아래에서 최대화한다”입니다.
                    그리고 수락하는 순간 회차의 모든 구간을 동시에 예약합니다.
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div className="zm-body zm-compare">
                <article>
                  <div className="zm-split">
                    <h3 className="ko">오늘 · 단건 배차</h3>
                    <span className="zm-badge bad">공차 50%</span>
                  </div>
                  <TripDiagram />
                  <ul className="zm-list ko">
                    <li>이천 → 부산 ₩400,000 — 좋아 보입니다.</li>
                    <li>내려놓고 나면 차고지에서 350km 떨어져 있습니다.</li>
                    <li>부산 주차장에서 전화를 돌리거나, 빈 차로 올라옵니다.</li>
                    <li>귀환 구간의 기름값·통행료는 전부 기사 부담입니다.</li>
                  </ul>
                </article>

                <article>
                  <div className="zm-split">
                    <h3 className="ko">ZeroMile · 연쇄 배차</h3>
                    <span className="zm-badge good">공차 9%</span>
                  </div>
                  <TourDiagram />
                  <ul className="zm-list ko">
                    <li>이천 → 부산 → 대구 → 이천, 3구간을 한 번에.</li>
                    <li>수락 시점에 세 건 모두 예약이 잠깁니다.</li>
                    <li>차고지 복귀 시각이 처음부터 계산되어 표시됩니다.</li>
                    <li>화면에 뜨는 숫자는 연료·통행료를 뺀 실수령액입니다.</li>
                  </ul>
                </article>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 03 · Lab ────────────────────────────────────────────────── */}
        <section id="lab" className="zm-section">
          <div className="zm-shell">
            <Reveal>
              <div className="zm-head">
                <span className="zm-head-n">02</span>
                <div>
                  <span className="zm-kicker">Live operations lab</span>
                  <h2 className="ko">실제 운송 최적화를 직접 실행해보세요.</h2>
                  <p className="ko">
                    왼쪽에서 운행 조건을 설정하고 실행하면,{' '}
                    <strong>최적 경로와 주요 운송 지표가 실시간으로 계산됩니다.</strong>
                  </p>
                  <div className="zm-chips">
                    {LAB_CHIPS.map((chip) => (
                      <span key={chip.k}>
                        <b>{chip.k}</b>
                        {chip.v}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>

            <Reveal delay={60} className="no-blur">
              <div className="zm-body zm-lab-plate">
                <DemoConsole onResult={setResult} />
              </div>
            </Reveal>

            {result?.optStats && (
              <Reveal>
                <div className="zm-ledger">
                  <LedgerRow
                    label="공차율"
                    from={`${(result.baseStats.emptyRatio * 100).toFixed(1)}%`}
                    to={`${(result.optStats.emptyRatio * 100).toFixed(1)}%`}
                  />
                  <LedgerRow
                    label="기사 일 순수입"
                    from={won(result.baseStats.avgNet)}
                    to={won(result.optStats.avgNet)}
                  />
                  <LedgerRow
                    label="배차 완료"
                    from={`${result.baseStats.loadsServed}건`}
                    to={`${result.optStats.loadsServed}건`}
                  />
                  <LedgerRow
                    label="회차 성립"
                    from={`${result.baseStats.closedLoops}대`}
                    to={`${result.optStats.closedLoops}대`}
                  />
                </div>
                {result.showcase && <WhyItWorked tour={result.showcase} result={result} />}
              </Reveal>
            )}

            <Reveal>
              <Methodology result={result} />
            </Reveal>
          </div>
        </section>

        {/* ── 04 · Driver ─────────────────────────────────────────────── */}
        <section id="driver" className="zm-section">
          <div className="zm-shell">
            <Reveal>
              <div className="zm-head">
                <span className="zm-head-n">03</span>
                <div>
                  <span className="zm-kicker">Driver app</span>
                  <h2 className="ko">하루 운송을 한눈에.</h2>
                  <p className="ko">
                    여러 화물을 하나씩 찾을 필요 없이,{' '}
                    <strong>
                      오늘의 운송 구간부터 예상 수익과 복귀 시간까지 하나의 화면에서 확인할
                      수 있습니다.
                    </strong>{' '}
                    ZeroMile이 최적화한 운송 계획을 확인하고 바로 운행을 시작하세요.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="zm-body zm-driver">
              <Reveal>
                <DriverPhone tours={result?.alternatives ?? []} />
              </Reveal>

              <Reveal delay={80}>
                <div className="zm-checks">
                  {DRIVER_POINTS.map((p, i) => (
                    <div key={p.t}>
                      <i>{String(i + 1).padStart(2, '0')}</i>
                      <div>
                        <b className="ko">{p.t}</b>
                        <p className="ko">{p.d}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {!result && (
                  <p className="zm-note ko">
                    ↑ 위 시뮬레이터를 실행하면 이 화면이 솔버의 실제 출력으로 채워집니다.
                  </p>
                )}
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── 05 · Moat ───────────────────────────────────────────────── */}
        <section id="moat" className="zm-section">
          <div className="zm-shell">
            <Reveal>
              <div className="zm-head">
                <span className="zm-head-n">04</span>
                <div>
                  <span className="zm-kicker">The moat</span>
                  <h2 className="ko">
                    이건 스타트업이 만들 수 없습니다. <em>입력값</em>을 이미 갖고
                    계십니다.
                  </h2>
                  <p className="ko">
                    연쇄 배차는 1구간이 시작되기 전에 3구간의 도착 시각을 약속해야
                    성립합니다. 그 약속은 도로 속도 그래프의 정확도만큼만 강합니다.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="zm-body zm-rows">
              {MOAT.map((m, i) => (
                <Reveal key={m.t} delay={i * 70}>
                  <div className="zm-row">
                    <span className="zm-row-n">{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <h3 className="zm-row-t ko">{m.t}</h3>
                      <span className="zm-row-k">{m.tag}</span>
                    </div>
                    <p className="zm-row-d ko">{m.d}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── 06 · Guarantee ──────────────────────────────────────────── */}
        <section id="guarantee" className="zm-section">
          <div className="zm-shell">
            <Reveal>
              <div className="zm-head">
                <span className="zm-head-n">06</span>
                <div>
                  <span className="zm-kicker">Business model</span>
                  <h2>
                    Loop <em>Guarantee</em>
                  </h2>
                </div>
              </div>
            </Reveal>

            <div className="zm-body zm-two">
              <Reveal>
                <div>
                  <p className="zm-quote ko">
                    회차가 끊기면 공차 귀환 운임을 저희가 지급합니다.
                  </p>
                  <p className="zm-note ko">
                    연쇄에는 신뢰 문제가 있습니다. 2구간이 취소되면 기사는 차고지에서
                    300km 떨어진 곳에 남습니다 — 애초에 믿지 않은 것보다 나쁩니다.
                    그래서 약속을 상품으로 만듭니다. 이 보증은 예측이 정확할 때만 감당
                    가능하고, 그게 정확히 요점입니다.
                  </p>
                </div>
              </Reveal>

              <Reveal delay={80}>
                <div className="zm-rows" style={{ borderTop: '2px solid var(--ink)' }}>
                  {REVENUE.map((r) => (
                    <div
                      key={r.t}
                      className="zm-row"
                      style={{ gridTemplateColumns: 'minmax(0,1fr)' }}
                    >
                      <div className="zm-split">
                        <h3 className="zm-row-t ko" style={{ fontSize: 19 }}>
                          {r.t}
                        </h3>
                        <span className="zm-badge">{r.tag}</span>
                      </div>
                      <p className="zm-row-d ko">{r.d}</p>
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── 07 · Method ─────────────────────────────────────────────── */}
        <section id="method" className="zm-section">
          <div className="zm-shell">
            <Reveal>
              <div className="zm-head">
                <span className="zm-head-n">05</span>
                <div>
                  <span className="zm-kicker">Method &amp; confidence</span>
                  <h2 className="ko">
                    숫자의 근거를 <em>숨기지</em> 않습니다.
                  </h2>
                  <p className="ko">
                    개선 폭은 방향을 검증하는 합성 결과입니다. 실제 운영 전에는 내비
                    ETA, 실거래 운임, 시간창과 차종 제약으로 다시 보정해야 합니다.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="zm-body zm-rows">
              {METHOD_ITEMS.map((item, i) => (
                <Reveal key={item.title} delay={i * 70}>
                  <div className="zm-row">
                    <span className="zm-row-n">{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <h3 className="zm-row-t ko">{item.title}</h3>
                      <span className="zm-row-k">{item.status}</span>
                    </div>
                    <p className="zm-row-d ko">{item.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="zm-footer">
        <div className="zm-shell zm-footer-inner">
          <a className="zm-wordmark" href="#top">
            <img className="zm-wordmark-logo" src="/zeromile-mark.png" alt="" />
            ZeroMile
          </a>
          <span className="zm-mono ko">
            제품 콘셉트 프로토타입 · 모든 수치는 시뮬레이션 결과입니다
          </span>
        </div>
      </footer>
    </>
  );
}

/* ── Shell pieces ───────────────────────────────────────────────────── */

function Masthead({
  active,
  theme,
  onToggleTheme,
  agentArmed,
  agentOpen,
  onToggleAgent,
}: {
  active: string;
  theme: Theme;
  onToggleTheme: () => void;
  agentArmed: boolean;
  agentOpen: boolean;
  onToggleAgent: () => void;
}) {
  return (
    <nav className="zm-mast">
      <div className="zm-mast-inner">
        <a className="zm-wordmark" href="#top">
          <img className="zm-wordmark-logo" src="/zeromile-mark.png" alt="" />
          ZeroMile
        </a>

        <div className="zm-nav">
          {SECTIONS.map((s) => (
            <a key={s.id} className={active === s.id ? 'on' : ''} href={`#${s.id}`}>
              {s.n} {s.label}
            </a>
          ))}
        </div>

        <div className="zm-mast-actions">
          <AgentLauncher armed={agentArmed} open={agentOpen} onToggle={onToggleAgent} />
          <button
            className="zm-swatch"
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? '페이퍼 모드' : '카본 모드'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <a className="zm-btn zm-btn-sm zm-btn-fill" href="#lab">
            직접 실행
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ── The day, drawn twice ─────────────────────────────────────────────────
 *
 * Two charts of the same thing: one driver's cumulative take-home across one
 * working day, in thousands of won. Costs accrue continuously (fuel, tolls);
 * money lands in a step at each delivery. That shape is the whole argument —
 * single-load dispatch pays once and then bleeds for six hours on the empty
 * run home, while a chained tour pays three times and ends at the depot.
 *
 * Figures are the same synthetic base day the hero strip quotes: ₩186k → ₩335k
 * take-home, +80%. Hours are decimal (13.5 = 13:30).
 * -------------------------------------------------------------------- */

type DayPoint = [hour: number, cumulativeThousandWon: number];

const DAY_SINGLE: DayPoint[] = [
  [6, 0],
  [8, -52],
  [11, -108],
  [13, 280],
  [15, 238],
  [17, 210],
  [19, 186],
];

const DAY_CHAINED: DayPoint[] = [
  [6, 0],
  [8, -44],
  [11, 214],
  [12, 176],
  [14, 302],
  [16, 262],
  [19, 335],
];

const DAY_X0 = 6;
const DAY_X1 = 19;
const DAY_LO = -150;
const DAY_HI = 370;

const PLOT_W = 268;
const PLOT_H = 84;
const PLOT_BOTTOM = 96;

const px = (h: number) => 9 + ((h - DAY_X0) / (DAY_X1 - DAY_X0)) * PLOT_W;
const py = (v: number) =>
  PLOT_BOTTOM - ((v - DAY_LO) / (DAY_HI - DAY_LO)) * PLOT_H;

/**
 * Catmull-Rom through the samples, converted to cubic béziers. The day is a
 * step function really, but a rounded line is the one that reads as a *curve
 * of a life* rather than a spreadsheet plot. Tension stays low so the spikes
 * don't overshoot into money that was never earned.
 */
function smooth(pts: DayPoint[]): string {
  const p = pts.map(([h, v]) => [px(h), py(v)] as const);
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p[i + 1];
    const k = 0.16;
    const c1x = p1[0] + (p2[0] - p0[0]) * k;
    const c1y = p1[1] + (p2[1] - p0[1]) * k;
    const c2x = p2[0] - (p3[0] - p1[0]) * k;
    const c2y = p2[1] - (p3[1] - p1[1]) * k;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** The same curve, dropped to the floor and closed — the fill under the line. */
const area = (pts: DayPoint[]) =>
  `${smooth(pts)}L${px(pts[pts.length - 1][0]).toFixed(1)},${PLOT_BOTTOM + 8}L${px(pts[0][0]).toFixed(1)},${PLOT_BOTTOM + 8}Z`;

function DayContrast() {
  return (
    <div className="zm-contrast">
      <DayChart
        id="single"
        tag="오늘 · 단건"
        bad
        pts={DAY_SINGLE}
        net="₩186,000"
        foot="한 번 벌고, 여섯 시간 빈 차로 까먹습니다"
      />
      <DayChart
        id="chained"
        tag="ZeroMile · 연쇄"
        pts={DAY_CHAINED}
        ghost={DAY_SINGLE}
        net="₩335,000"
        foot="세 번 벌고, 차고지에서 끝납니다"
      />
    </div>
  );
}

function DayChart({
  id,
  tag,
  pts,
  ghost,
  net,
  foot,
  bad,
}: {
  id: string;
  tag: string;
  pts: DayPoint[];
  ghost?: DayPoint[];
  net: string;
  foot: string;
  bad?: boolean;
}) {
  const peak = Math.max(...pts.map(([, v]) => v));
  const end = pts[pts.length - 1];
  // The bleed: everything after the last delivery, hanging under the peak.
  const bleed = pts.filter(([h]) => h >= pts.find(([, v]) => v === peak)![0]);
  const bleedPath = `${smooth(bleed)}L${px(end[0]).toFixed(1)},${py(peak).toFixed(1)}Z`;

  return (
    <figure className={`zm-chart${bad ? ' bad' : ' good'}`}>
      <figcaption>{tag}</figcaption>

      <svg viewBox="0 0 286 112" role="img" aria-label={`${tag} — 하루 누적 실수령액 ${net}`}>
        <defs>
          <linearGradient id={`zm-g-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop className="zm-g-top" offset="0%" />
            <stop className="zm-g-bot" offset="100%" />
          </linearGradient>
          <clipPath id={`zm-c-${id}`}>
            <rect x="0" y="0" width="286" height={PLOT_BOTTOM + 8} />
          </clipPath>
        </defs>

        {/* zero rule — below it the driver is paying to work */}
        <line className="zm-chart-zero" x1={9} y1={py(0)} x2={277} y2={py(0)} />

        <g clipPath={`url(#zm-c-${id})`}>
          <path className="zm-chart-area" d={area(pts)} fill={`url(#zm-g-${id})`} />
        </g>

        {bad && <path className="zm-chart-bleed" d={bleedPath} />}
        {ghost && <path className="zm-chart-ghost" d={smooth(ghost)} />}

        <path className="zm-chart-line" d={smooth(pts)} pathLength={1} />

        {pts.map(([h, v], i) =>
          i > 0 && v > pts[i - 1][1] + 120 ? (
            <circle key={h} className="zm-chart-dot" cx={px(h)} cy={py(v)} r={2.6} />
          ) : null,
        )}

        <circle className="zm-chart-end" cx={px(end[0])} cy={py(end[1])} r={3.4} />

        {bad ? (
          <text className="zm-chart-note" x={px(19)} y={py(peak) - 6}>
            빈 차 350km · ₩0
          </text>
        ) : (
          <text className="zm-chart-note good" x={px(19)} y={py(end[1]) - 8}>
            +₩149,000
          </text>
        )}

        <text className="zm-chart-ax" x={9} y={109}>
          06:00
        </text>
        <text className="zm-chart-ax end" x={277} y={109}>
          19:00
        </text>
      </svg>

      <div className="zm-chart-net">
        <b>{net}</b>
        <span className="ko">{foot}</span>
      </div>
    </figure>
  );
}

function Figure({ k, l, signal }: { k: string; l: string; signal?: boolean }) {
  return (
    <div className="zm-fig">
      <b className={signal ? 'sig' : ''}>{k}</b>
      <span className="ko">{l}</span>
    </div>
  );
}

function Marquee() {
  const line = [
    '공차율 −23.7%p',
    '회차 전 구간 동시 예약',
    '차고지 60km 복귀 보장',
    'LOOP GUARANTEE',
    '기사 순수입 +80%',
    '실거리 OSRM 라우팅',
  ];
  return (
    <div className="zm-marquee" aria-hidden="true">
      <div className="zm-marquee-track">
        {[0, 1].map((copy) => (
          <div className="zm-marquee-run" key={copy}>
            {line.map((t) => (
              <span key={t}>
                <b>◆</b> {t}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function LedgerRow({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <div className="zm-ledger-row">
      <span className="ko">{label}</span>
      <span className="zm-ledger-from">{from}</span>
      <span className="zm-ledger-arrow">→</span>
      <span className="zm-ledger-to">{to}</span>
    </div>
  );
}

const CITY_NAME: Record<string, string> = Object.fromEntries(
  CITIES.map((c) => [c.id, c.ko]),
);

/** Explains the solver's pick instead of only printing its output. */
function WhyItWorked({ tour, result }: { tour: Tour; result: DemoResult }) {
  const first = tour.legs[0];
  const second = tour.legs[1];
  const last = tour.legs[tour.legs.length - 1];
  const pointDrop = result.optStats
    ? (result.baseStats.emptyRatio - result.optStats.emptyRatio) * 100
    : 0;

  return (
    <div className="zm-why">
      <div>
        <span>01 · 연결</span>
        <b className="ko">
          {CITY_NAME[first.load.from]} → {CITY_NAME[first.load.to]}
        </b>
        <p className="ko">
          {second
            ? `${CITY_NAME[second.load.from]}에서 출발하는 다음 화물을 이어 공차 접근을 줄였습니다.`
            : '가장 수익성 높은 첫 구간을 선택했습니다.'}
        </p>
      </div>
      <div>
        <span>02 · 복귀</span>
        <b className="ko">
          {siteLabel(last.load.toSite)} → {siteLabel(tour.driver.depot)} 차고지
        </b>
        <p className="ko">마지막 하차지를 차고지 반경 안에 두고 귀가 시각을 계산했습니다.</p>
      </div>
      <div>
        <span>03 · 효과</span>
        <b className="ko">
          공차율 −{pointDrop.toFixed(1)}%p · {won(tour.net)}
        </b>
        <p className="ko">
          {result.config.label} 기준, 연료와 통행료를 차감한 대표 회차 결과입니다.
        </p>
      </div>
    </div>
  );
}

/* ── Methodology dashboard ──────────────────────────────────────────────
 *
 * Seven panels behind the `시뮬레이션 방법론` disclosure, every one of them
 * drawn from the run the visitor just watched: the same tours the map is
 * showing, the same per-frame trace the progress bar was reading, the same
 * move counters the annealer kept. Before a solve there is nothing honest to
 * plot, so the section says so and states the method in words instead.
 * -------------------------------------------------------------------- */

const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Eases a figure up from zero once its panel is open. */
function useCountUp(target: number, run: boolean, ms = 1100) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!run) {
      setValue(0);
      return;
    }
    if (REDUCED_MOTION) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, ms]);

  return value;
}

/** Drivers start their day at the yard at 06:00. */
const DAY_START_HOUR = 6;
const HEAT_BUCKETS = [6, 8, 10, 12, 14, 16, 18, 20];
const HEAT_ROWS = ['1구간', '2구간', '3구간', '4구간', '5구간+'];
/** Deadhead approach has km but no clock, so pace it at motorway average. */
const APPROACH_KMH = 72;

const MOVE_LABELS: { key: keyof MoveTally; ko: string }[] = [
  { key: 'insert', ko: '빈 자리에 화물 삽입' },
  { key: 'relocate', ko: '다른 기사에게 이관' },
  { key: 'swap', ko: '두 구간 맞교환' },
  { key: 'remove', ko: '수익 안 나는 구간 제거' },
  { key: 'reorder', ko: '방문 순서 재배열' },
];

type MethodData = {
  emptyBase: number;
  emptyOpt: number;
  netBase: number;
  netOpt: number;
  history: SolvePoint[];
  legMix: { label: string; count: number; pct: number }[];
  peakLabel: string;
  avgHours: number;
  avgReturnKm: number;
  perKm: { gross: number; fuel: number; toll: number; net: number };
  moves: { key: string; ko: string; proposed: number; accepted: number; rate: number }[];
  topProposed: number;
  heat: number[][];
  heatMax: number;
  workingTours: number;
  loadsServed: number;
  solveMs: number;
};

/** Everything the panels draw, derived once from the finished run. */
function deriveMethod(result: DemoResult | null): MethodData | null {
  if (!result?.optStats || result.tours.length === 0) return null;

  const working = result.tours.filter((tour) => tour.legs.length > 0);
  if (working.length === 0) return null;

  // Leg-count mix, capped at a 5+ bucket.
  const buckets = [0, 0, 0, 0, 0];
  for (const tour of working) buckets[Math.min(tour.legs.length, 5) - 1]++;
  const legMix = buckets.map((count, i) => ({
    label: i === 4 ? '5+' : String(i + 1),
    count,
    pct: (count / working.length) * 100,
  }));
  const peak = legMix.reduce((a, b) => (b.count > a.count ? b : a));

  // Per-km ledger. Cost is fuel + toll on every km the truck turns, loaded or
  // not — the empty km are what the chaining is trying to delete.
  const revenue = working.reduce((sum, t) => sum + t.revenue, 0);
  const km = working.reduce((sum, t) => sum + t.loadedKm + t.emptyKm, 0);
  const gross = km > 0 ? revenue / km : 0;
  const perKm = {
    gross,
    fuel: FUEL_WON_PER_KM,
    toll: TOLL_WON_PER_KM,
    net: gross - COST_WON_PER_KM,
  };

  const avgHours = working.reduce((sum, t) => sum + t.hours, 0) / working.length;
  const closed = working.filter((t) => t.returnKm <= HOME_RADIUS_KM);
  const avgReturnKm = closed.length
    ? closed.reduce((sum, t) => sum + t.returnKm, 0) / closed.length
    : 0;

  // When each leg actually rolls, walked forward from the 06:00 yard start.
  const heat = HEAT_ROWS.map(() => HEAT_BUCKETS.map(() => 0));
  for (const tour of working) {
    let clock = DAY_START_HOUR;
    tour.legs.forEach((leg, i) => {
      clock += leg.deadheadKm / APPROACH_KMH;
      const row = Math.min(i, HEAT_ROWS.length - 1);
      let col = HEAT_BUCKETS.findIndex((h) => clock < h + 2);
      if (col < 0) col = HEAT_BUCKETS.length - 1;
      if (clock >= HEAT_BUCKETS[0]) heat[row][col]++;
      clock += leg.load.hours + LEG_HANDLING_HOURS;
    });
  }
  const heatMax = Math.max(1, ...heat.flat());

  const moves = result.moves
    ? MOVE_LABELS.map(({ key, ko }) => {
        const tally = result.moves![key];
        return {
          key,
          ko,
          proposed: tally.proposed,
          accepted: tally.accepted,
          rate: tally.proposed > 0 ? tally.accepted / tally.proposed : 0,
        };
      }).sort((a, b) => b.proposed - a.proposed)
    : [];

  return {
    emptyBase: result.baseStats.emptyRatio,
    emptyOpt: result.optStats.emptyRatio,
    netBase: result.baseStats.avgNet,
    netOpt: result.optStats.avgNet,
    history: result.history,
    legMix,
    peakLabel: peak.label,
    avgHours,
    avgReturnKm,
    perKm,
    moves,
    topProposed: moves.length ? moves[0].proposed : 0,
    heat,
    heatMax,
    workingTours: working.length,
    loadsServed: result.optStats.loadsServed,
    solveMs: result.solveMs,
  };
}

function Methodology({ result }: { result: DemoResult | null }) {
  const [live, setLive] = useState(false);
  const data = useMemo(() => deriveMethod(result), [result]);

  return (
    <details
      className="methodology-summary"
      style={{ marginTop: 30 }}
      onToggle={(e) => setLive((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span>
          <b>시뮬레이션 방법론</b>
          <small>
            {data
              ? `방금 실행한 회차 ${data.workingTours.toLocaleString()}건에서 직접 뽑은 지표`
              : '기준선·제약·비용 범위를 확인하세요'}
          </small>
        </span>
        <span className="summary-action">펼쳐보기</span>
      </summary>

      {data ? (
        <div className={`mth${live ? ' is-live' : ''}`}>
          <EmptyRatioPanel data={data} live={live} />
          <ConvergencePanel data={data} live={live} />
          <LegMixPanel data={data} />
          <ConstraintPanel data={data} live={live} />
          <LedgerPanel data={data} live={live} />
          <OperatorPanel data={data} />
          <HeatPanel data={data} />
        </div>
      ) : (
        <div className="mth-idle">
          <p className="mth-idle-lede">
            아래 지표는 시뮬레이션이 끝난 뒤 <b>그 실행의 결과에서 직접</b> 계산됩니다.
            위에서 최적화를 한 번 실행하면 이 자리가 실측 그래프로 채워집니다.
          </p>
          <div className="mth-idle-grid">
            <div>
              <b>기준선</b>
              <p>목적지를 고려하지 않고 단건 운임이 높은 화물을 먼저 잡는 선착순 게시판 모델</p>
            </div>
            <div>
              <b>최적화</b>
              <p>insert·remove·relocate·swap·reorder를 평가하는 simulated annealing</p>
            </div>
            <div>
              <b>제약</b>
              <p>
                운행 {MAX_DUTY_HOURS}시간, 차고지 {HOME_RADIUS_KM}km 이내 복귀. 구간 수 상한은 없고
                시계가 상한입니다
              </p>
            </div>
            <div>
              <b>포함 비용</b>
              <p>
                경유 {FUEL_WON_PER_KM}원/km와 통행료 {TOLL_WON_PER_KM}원/km. 보험·정비·할부와 대기비는
                제외
              </p>
            </div>
          </div>
        </div>
      )}
    </details>
  );
}

/* 01 · 공차율 */
function EmptyRatioPanel({ data, live }: { data: MethodData; live: boolean }) {
  const basePct = data.emptyBase * 100;
  const optPct = data.emptyOpt * 100;
  const drop = useCountUp(basePct - optPct, live, 1500);
  const base = useCountUp(basePct, live);
  const opt = useCountUp(optPct, live, 1300);

  return (
    <section className="mth-card mth-c5">
      <header>
        <span className="mth-n">01</span>
        <b>공차율</b>
        <small>기준선 대비 · 실측</small>
      </header>

      <div className="mth-hero">
        <em>−{drop.toFixed(1)}</em>
        <span>
          %p
          <small>빈 차로 달린 거리의 비중</small>
        </span>
      </div>

      <div className="mth-vs">
        <div>
          <label>
            <span>선착순 게시판</span>
            <b>{base.toFixed(1)}%</b>
          </label>
          <div className="mth-track">
            <i className="is-empty" style={{ '--to': `${basePct}%` } as React.CSSProperties} />
          </div>
        </div>
        <div>
          <label>
            <span>ZeroMile 회차</span>
            <b>{opt.toFixed(1)}%</b>
          </label>
          <div className="mth-track">
            <i
              className="is-signal"
              style={{ '--to': `${optPct}%`, '--delay': '0.16s' } as React.CSSProperties}
            />
          </div>
        </div>
      </div>

      <p className="mth-note">
        같은 화물 풀과 같은 도로 데이터를 두 번 풉니다. 기준선은 목적지를 보지 않고 단건 운임이 높은
        화물부터 잡는 모델입니다.
      </p>
    </section>
  );
}

/* 02 · 수렴 곡선 — the real per-frame trace */
const CURVE_W = 680;
const CURVE_H = 240;
const PAD_L = 44;
const PAD_R = 46;
const PAD_T = 18;
const PAD_B = 30;

function tracePath(points: SolvePoint[], value: (p: SolvePoint) => number): string {
  const values = points.map(value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return points
    .map((point, i) => {
      const x = PAD_L + point.p * (CURVE_W - PAD_L - PAD_R);
      const y = CURVE_H - PAD_B - ((values[i] - lo) / span) * (CURVE_H - PAD_T - PAD_B);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function ConvergencePanel({ data, live }: { data: MethodData; live: boolean }) {
  const trace = data.history.length > 1 ? data.history : null;
  const netPath = trace ? tracePath(trace, (p) => p.net) : '';
  const emptyPath = trace ? tracePath(trace, (p) => p.empty) : '';
  const gain = useCountUp(((data.netOpt - data.netBase) / Math.max(1, data.netBase)) * 100, live, 1600);

  return (
    <section className="mth-card mth-c7">
      <header>
        <span className="mth-n">02</span>
        <b>담금질 수렴</b>
        <small>
          {data.history.length.toLocaleString()} 프레임 · {(data.solveMs / 1000).toFixed(1)}초
        </small>
      </header>

      <div className="mth-hero mth-hero-sm">
        <em>+{gain.toFixed(0)}</em>
        <span>
          %
          <small>기사 1인 일 순수입</small>
        </span>
      </div>

      {trace ? (
        <svg className="mth-curve" viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} aria-hidden="true">
          {[0, 0.5, 1].map((g) => (
            <line
              key={g}
              x1={PAD_L}
              x2={CURVE_W - PAD_R}
              y1={PAD_T + g * (CURVE_H - PAD_T - PAD_B)}
              y2={PAD_T + g * (CURVE_H - PAD_T - PAD_B)}
              stroke="var(--line)"
              strokeWidth="1"
            />
          ))}
          <path
            className="mth-line mth-line-empty"
            d={emptyPath}
            pathLength={1}
            fill="none"
            stroke="var(--empty)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            className="mth-line mth-line-net"
            d={netPath}
            pathLength={1}
            fill="none"
            stroke="var(--ink)"
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
          <text x={PAD_L} y={CURVE_H - 8} className="mth-ax">
            0
          </text>
          <text x={CURVE_W - PAD_R} y={CURVE_H - 8} className="mth-ax" textAnchor="end">
            {(data.solveMs / 1000).toFixed(1)}s
          </text>
        </svg>
      ) : null}

      <div className="mth-legend">
        <span className="lg-ink">
          순수입 <b>{won(Math.round(data.netOpt))}</b>
        </span>
        <span className="lg-empty">
          공차율 <b>{(data.emptyOpt * 100).toFixed(1)}%</b>
        </span>
      </div>

      <p className="mth-note">
        매 프레임 실제로 기록된 값입니다. 온도가 높은 초반에는 손해 보는 교환도 받아들여 지역 최적을
        빠져나오고, 온도가 식으면서 개선되는 수만 남습니다.
      </p>
    </section>
  );
}

/* 03 · 회차 길이 */
function LegMixPanel({ data }: { data: MethodData }) {
  const tallest = Math.max(...data.legMix.map((d) => d.pct), 1);

  return (
    <section className="mth-card mth-c4">
      <header>
        <span className="mth-n">03</span>
        <b>회차 길이</b>
        <small>구간 수 분포</small>
      </header>

      <div className="mth-cols">
        {data.legMix.map((d, i) => (
          <div key={d.label}>
            <em>{d.pct.toFixed(0)}%</em>
            <i
              className={d.label === data.peakLabel ? 'is-peak' : undefined}
              style={
                {
                  '--to': `${Math.max(2, (d.pct / tallest) * 100)}%`,
                  '--delay': `${0.07 * i}s`,
                } as React.CSSProperties
              }
            />
            <span>{d.label}</span>
          </div>
        ))}
      </div>

      <p className="mth-note">
        {data.workingTours.toLocaleString()}대가 화물을 잡았고 {data.loadsServed.toLocaleString()}건을
        실었습니다. 구간 수에 상한은 없습니다 — 상·하차 {LEG_HANDLING_HOURS.toFixed(1)}시간과 주행
        시간이 {MAX_DUTY_HOURS}시간을 채우는 지점이 상한입니다.
      </p>
    </section>
  );
}

/* 04 · 제약 */
function ConstraintPanel({ data, live }: { data: MethodData; live: boolean }) {
  return (
    <section className="mth-card mth-c4">
      <header>
        <span className="mth-n">04</span>
        <b>제약</b>
        <small>시계와 반경</small>
      </header>

      <div className="mth-dials">
        <Dial
          live={live}
          value={data.avgHours}
          max={MAX_DUTY_HOURS}
          unit="h"
          ko="평균 운행"
          digits={1}
        />
        <Dial
          live={live}
          value={data.avgReturnKm}
          max={HOME_RADIUS_KM}
          unit="km"
          ko="차고지 복귀"
          digits={0}
          delay={0.18}
        />
      </div>

      <p className="mth-note">
        운행 {MAX_DUTY_HOURS}시간, 마지막 하차지는 차고지 {HOME_RADIUS_KM}km 이내. 두 조건을 어기는
        해는 점수를 매기기 전에 폐기됩니다.
      </p>
    </section>
  );
}

function Dial({
  live,
  value,
  max,
  unit,
  ko,
  digits,
  delay = 0,
}: {
  live: boolean;
  value: number;
  max: number;
  unit: string;
  ko: string;
  digits: number;
  delay?: number;
}) {
  const shown = useCountUp(value, live, 1250);
  const r = 36;
  const ring = 2 * Math.PI * r;
  const used = ring * Math.min(1, value / max);

  return (
    <figure className="mth-dial">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--line)" strokeWidth="10" />
        <circle
          className="mth-sweep"
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="var(--signal)"
          strokeWidth="10"
          transform="rotate(-90 50 50)"
          style={
            {
              '--dash': `${used} ${ring}`,
              '--ring': `${ring}`,
              '--delay': `${delay}s`,
            } as React.CSSProperties
          }
        />
      </svg>
      <figcaption>
        <b>
          {shown.toFixed(digits)}
          <span>
            /{max}
            {unit}
          </span>
        </b>
        <small>{ko}</small>
      </figcaption>
    </figure>
  );
}

/* 05 · km당 손익 */
function LedgerPanel({ data, live }: { data: MethodData; live: boolean }) {
  const net = useCountUp(data.perKm.net, live, 1500);
  const scale = Math.max(data.perKm.gross, 1);
  const rows = [
    { label: '운임', won: data.perKm.gross, kind: 'in' },
    { label: '경유', won: -data.perKm.fuel, kind: 'out' },
    { label: '통행료', won: -data.perKm.toll, kind: 'out' },
    { label: '순이익', won: data.perKm.net, kind: 'net' },
  ] as const;

  return (
    <section className="mth-card mth-c4">
      <header>
        <span className="mth-n">05</span>
        <b>km당 손익</b>
        <small>원 / 실주행 km</small>
      </header>

      <div className="mth-fall">
        {rows.map((row, i) => (
          <div key={row.label} className={`fall-${row.kind}`}>
            <label>{row.label}</label>
            <div className="mth-track">
              <i
                style={
                  {
                    '--to': `${(Math.abs(row.won) / scale) * 100}%`,
                    '--delay': `${0.09 * i}s`,
                  } as React.CSSProperties
                }
              />
            </div>
            <b>
              {row.won < 0 ? '−' : ''}
              {Math.round(Math.abs(row.kind === 'net' ? net : row.won)).toLocaleString()}
            </b>
          </div>
        ))}
      </div>

      <p className="mth-note">
        운임은 이번 실행의 총매출을 실제 주행거리로 나눈 값입니다. 경유와 통행료만 차감하고
        보험·정비·할부와 대기비는 넣지 않았습니다 — 넣으면 기준선이 더 나빠지므로 빼는 쪽이
        보수적입니다.
      </p>
    </section>
  );
}

/* 06 · 이웃 연산 */
function OperatorPanel({ data }: { data: MethodData }) {
  if (data.moves.length === 0) return null;
  const total = data.moves.reduce((sum, m) => sum + m.proposed, 0);

  return (
    <section className="mth-card mth-c5">
      <header>
        <span className="mth-n">06</span>
        <b>이웃 연산</b>
        <small>{(total / 1_000_000).toFixed(1)}M 회 시도</small>
      </header>

      <div className="mth-ops">
        {data.moves.map((op, i) => (
          <div key={op.key}>
            <label>
              <code>{op.key}</code>
              <span>{op.ko}</span>
            </label>
            <div className="mth-track">
              <i
                style={
                  {
                    '--to': `${(op.proposed / Math.max(1, data.topProposed)) * 100}%`,
                    '--delay': `${0.06 * i}s`,
                  } as React.CSSProperties
                }
              />
              <u
                style={
                  {
                    '--to': `${(op.accepted / Math.max(1, data.topProposed)) * 100}%`,
                    '--delay': `${0.06 * i + 0.25}s`,
                  } as React.CSSProperties
                }
              />
            </div>
            <b>{(op.rate * 100).toFixed(1)}%</b>
          </div>
        ))}
      </div>

      <div className="mth-legend">
        <span className="lg-mute">시도</span>
        <span className="lg-ink">채택</span>
      </div>

      <p className="mth-note">
        매 반복마다 하나를 뽑아 회차를 흔들고, 점수가 오르면 즉시 · 내려가면 그때의 온도만큼의
        확률로 받아들입니다. 오른쪽 수치는 채택률입니다.
      </p>
    </section>
  );
}

/* 07 · 구간별 출발 시각 */
function HeatPanel({ data }: { data: MethodData }) {
  const level = (v: number) => (v === 0 ? 0 : Math.max(1, Math.round((v / data.heatMax) * 6)));

  return (
    <section className="mth-card mth-c7">
      <header>
        <span className="mth-n">07</span>
        <b>하루가 채워지는 모양</b>
        <small>구간 순서 × 출발 시각</small>
      </header>

      <div className="mth-heat">
        <div className="heat-grid">
          {data.heat.map((row, r) => (
            <div className="heat-row" key={HEAT_ROWS[r]}>
              <span className="heat-label">{HEAT_ROWS[r]}</span>
              {row.map((v, c) => (
                <i
                  key={c}
                  data-v={level(v)}
                  style={{ '--delay': `${(r + c) * 0.03}s` } as React.CSSProperties}
                  title={`${HEAT_BUCKETS[c]}시 · ${v}건`}
                />
              ))}
            </div>
          ))}
          <div className="heat-row heat-axis">
            <span className="heat-label" />
            {HEAT_BUCKETS.map((h) => (
              <em key={h}>{h}</em>
            ))}
          </div>
        </div>
        <div className="heat-key">
          <span>적음</span>
          {[0, 1, 2, 3, 4, 5, 6].map((v) => (
            <i key={v} data-v={v} />
          ))}
          <span>많음</span>
        </div>
      </div>

      <p className="mth-note">
        각 회차의 n번째 구간이 실제로 출발하는 시각입니다 (06:00 차고지 출발 기준, 접근 공차는 시속
        {APPROACH_KMH}km로 환산). 오른쪽 아래가 채워질수록 하루가 끝까지 이어붙었다는 뜻입니다.
      </p>
    </section>
  );
}

/* ── Diagrams ───────────────────────────────────────────────────────── */

function TripDiagram() {
  return (
    <svg
      className="diagram diagram-trip"
      viewBox="0 0 300 150"
      style={{ width: '100%', height: 'auto' }}
      aria-hidden="true"
    >
      <path
        className="dg-draw"
        d="M46 112 L254 62"
        stroke="var(--ink)"
        strokeWidth="2"
        fill="none"
      />
      <path
        className="dg-march"
        d="M254 62 L46 112"
        stroke="var(--empty)"
        strokeWidth="1.6"
        strokeDasharray="5 6"
        fill="none"
      />
      <rect x="41" y="107" width="10" height="10" fill="var(--ink)" />
      <rect x="249" y="57" width="10" height="10" fill="var(--empty)" />
      <text x="26" y="136" fill="var(--ink-3)" fontSize="11" fontFamily="var(--mono)">
        이천 (차고지)
      </text>
      <text x="228" y="46" fill="var(--ink-3)" fontSize="11" fontFamily="var(--mono)">
        부산
      </text>
      <text x="112" y="98" fill="var(--empty)" fontSize="10.5" fontFamily="var(--mono)">
        공차 350km · ₩0
      </text>
    </svg>
  );
}

function TourDiagram() {
  const loop = 'M46 112 L254 62 L152 126 Z';
  return (
    <svg
      className="diagram diagram-tour"
      viewBox="0 0 300 150"
      style={{ width: '100%', height: 'auto' }}
      aria-hidden="true"
    >
      <defs>
        <path id="tour-loop-motion" d={loop} />
      </defs>
      <path
        className="dg-loop"
        d={loop}
        stroke="var(--ink)"
        strokeWidth="2"
        strokeLinejoin="round"
        fill="var(--yellow-dim)"
      />
      <circle className="dg-bead" r="3.4" fill="var(--signal)">
        <animateMotion dur="7.5s" repeatCount="indefinite" calcMode="linear">
          <mpath href="#tour-loop-motion" />
        </animateMotion>
      </circle>
      <rect x="41" y="107" width="10" height="10" fill="var(--signal)" />
      <rect x="249" y="57" width="9" height="9" fill="var(--ink)" />
      <rect x="147" y="121" width="9" height="9" fill="var(--ink)" />
      <text x="26" y="136" fill="var(--ink-3)" fontSize="11" fontFamily="var(--mono)">
        이천 (차고지)
      </text>
      <text x="228" y="46" fill="var(--ink-3)" fontSize="11" fontFamily="var(--mono)">
        부산
      </text>
      <text x="138" y="147" fill="var(--ink-3)" fontSize="11" fontFamily="var(--mono)">
        대구
      </text>
    </svg>
  );
}

/* ── Copy ───────────────────────────────────────────────────────────── */

const LAB_CHIPS = [
  { k: 'DATA', v: '합성 수요' },
  { k: 'SEED', v: '재현 가능' },
  { k: 'COMPUTE', v: '브라우저 로컬' },
  { k: 'LIVE', v: '실시간 실행' },
];

const PROBLEMS = [
  {
    k: '30–40%',
    title: '공차 운행',
    body: (
      <>
        화물을 배송한 뒤 적절한 복귀 화물을 찾지 못하면 빈 차로 이동하게 됩니다. 복귀
        구간의 <strong>연료비와 운행 시간은 비용이 되지만 추가 수익은 발생하지 않습니다.</strong>
      </>
    ),
  },
  {
    k: '3–4단계',
    title: '복잡한 주선 구조',
    body: (
      <>
        화주부터 기사까지 여러 주선 단계를 거치며 수수료가 발생합니다. 기사는{' '}
        <strong>
          실제 운임과 비용 구조를 정확히 파악하기 어려워 수익성을 판단하기 어렵습니다.
        </strong>
      </>
    ),
    neutral: true,
  },
  {
    k: '실시간 경쟁',
    title: '선착순 중심 배차',
    body: (
      <>
        기존 화물 플랫폼은 화물을 개별적으로 확인하고 빠르게 선택해야 하는 방식이
        많습니다. 운전 중 반복적인 확인이 필요하고,{' '}
        <strong>하루 전체 운송 경로와 수익을 계획하기 어렵습니다.</strong>
      </>
    ),
    neutral: true,
  },
];

const LAYERS = [
  { name: '화주', cut: '' },
  { name: '주선업체', cut: '12%' },
  { name: '재주선', cut: '9%' },
  { name: '기사', cut: '' },
];

const DRIVER_POINTS = [
  {
    t: '실수령액이 가장 큰 글씨',
    d: '운임이 아니라 연료·통행료를 뺀 금액입니다. 주선 단계가 지워버린 투명성을 화면 맨 앞에 되돌려 놓습니다.',
  },
  {
    t: '수락 = 전 구간 동시 예약',
    d: '2구간을 나중에 찾겠다는 약속이 아닙니다. 누르는 순간 전 구간이 잠깁니다.',
  },
  {
    t: '음성 우선',
    d: '“다음 루프”, “수락”. 기사는 운전 중입니다. 손이 자유롭지 않다는 전제에서 출발한 인터페이스입니다.',
  },
  {
    t: '복귀 시각이 약속',
    d: '“오후 7시 40분 귀가”는 부가 정보가 아니라 상품 사양입니다.',
  },
];

const MOAT = [
  {
    tag: 'Navi + 플릿 데이터',
    t: '실시간 + 과거 속도 그래프',
    d: '3구간을 약속하려면 1구간이 출발하기 전에 도착 시각을 알아야 합니다. 이 해상도의 도로 속도 데이터를 국내에서 보유한 곳은 손에 꼽습니다.',
  },
  {
    tag: '예측 → 상품',
    t: '정확도가 곧 보증 가격',
    d: '예측이 좋을수록 Loop Guarantee의 원가가 내려갑니다. 경쟁사가 같은 보증을 팔면 적자입니다. 데이터 우위가 손익계산서로 번역되는 지점입니다.',
  },
  {
    tag: '네트워크',
    t: '연쇄는 밀도를 먹고 자랍니다',
    d: '연결할 화물이 많을수록 좋은 회차가 나오고, 좋은 회차가 기사를 끌어오고, 기사가 많아지면 화주가 옵니다. 단건 매칭에는 없는 되먹임입니다.',
  },
];

const REVENUE = [
  {
    t: '매칭 수수료',
    tag: 'take rate',
    d: '단건보다 훨씬 큰 거래량 위에서 걷습니다. 회차는 기사 한 명당 하루 1건이 아니라 2~4건을 성사시킵니다.',
  },
  {
    t: '보증 프리미엄',
    tag: 'priced risk',
    d: '보증은 옵션입니다. 예측 신뢰도에 따라 가격이 매겨지고, 신뢰도가 낮은 조합은 애초에 제안하지 않습니다.',
  },
  {
    t: '화주 정시성',
    tag: 'shipper side',
    d: '예약된 연쇄는 화주에게도 확정 슬롯입니다. 스팟 시장의 불확실성을 줄여주는 대가를 받을 수 있습니다.',
  },
];

const METHOD_ITEMS = [
  {
    status: '현재 구현',
    title: '재현 가능한 합성 수요',
    body: '한국 30개 도시 좌표와 물동량 가중치, 고정 seed를 사용합니다. 같은 시나리오는 같은 입력에서 다시 실행됩니다.',
  },
  {
    status: '보정 필요',
    title: 'ETA와 운임',
    body: 'ETA는 거리별 고정 속도, 운임은 보정된 추정치입니다. 실제 배포 전 내비 속도 그래프와 실거래 운임으로 대체합니다.',
  },
  {
    status: '다음 단계',
    title: '현장 제약 확장',
    body: '상하차 시간창, 차종 적합성, 통행 규제, 보험·정비·대기비를 목적함수와 제약에 추가해야 합니다.',
  },
];
