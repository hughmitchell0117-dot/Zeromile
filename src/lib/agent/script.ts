/**
 * The scripted walkthrough.
 *
 * This is a demo reel, not a model. There is no inference behind the panel:
 * the beats below run in order, one per message sent, whatever the message
 * actually says. It exists because a live model on a free key was the least
 * reliable thing on screen — it stalled on rate limits and phrased the pitch
 * differently every take — and a recorded demo needs to hit the same marks
 * every time.
 *
 * Two rules keep it honest anyway, and they matter more than they look:
 *
 * The actions are real. Every beat drives the actual console through the same
 * bus the model used — it fills the real form, starts the real annealer, and
 * highlights real freight in the real loading bay. Nothing is mimed.
 *
 * The numbers are read, never written. No won figure, distance or time is
 * typed into this file. Each line is built from the solved tour at the moment
 * it is spoken, so the voice cannot contradict the screen — if the solver
 * returns something different today, the script says something different.
 */

import { consoleHandle, consoleReady } from './bus';
import { runTool } from './tools';

export type ScriptTool = { name: string; args?: Record<string, unknown> };

type Beat = {
  /** What the agent says. A function is given the live state when it speaks. */
  say: string | (() => string);
  /** Tool chips, run for real, staggered so the panel reads as working. */
  tools?: ScriptTool[];
  /** Pause before the tools start, so a reply never lands instantly. */
  thinkMs?: number;
  /** Hold until the solver finishes before speaking. */
  awaitSolve?: boolean;
  /** The driver's next line, played automatically after this one. */
  followUp?: string;
};

const CURRENT = 'busan-0';
const DEPOT = 'icheon-0';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const snap = () => (consoleReady() ? consoleHandle().snapshot() : null);

/** 184,300 → "18만 4천 원". Spoken, so it has to be said the way a person says it. */
function spokenWon(value: number): string {
  const total = Math.round(value);
  if (Math.abs(total) < 10_000) return `${total.toLocaleString('en-US')}원`;
  const man = Math.floor(total / 10_000);
  const thousands = Math.round((total % 10_000) / 1_000);
  return thousands ? `${man}만 ${thousands}천 원` : `${man}만 원`;
}

/** 14.6 → "14.6%" with one decimal at most, and no trailing ".0". */
const pct = (ratio: number) => `${(Math.round(ratio * 1000) / 10).toString().replace(/\.0$/, '')}%`;

/** 6 + 10.4 → "오후 4시 24분", which is what a driver actually wants to hear. */
function clock(startHour: number, hours: number): string {
  const total = startHour + hours;
  const h = Math.floor(total) % 24;
  const m = Math.round((total % 1) * 60);
  const suffix = h < 12 ? '오전' : '오후';
  const display = h % 12 === 0 ? 12 : h % 12;
  return m ? `${suffix} ${display}시 ${m}분` : `${suffix} ${display}시`;
}

/**
 * The reel. Each entry is one exchange: the driver says anything at all, and
 * this is what happens next.
 */
const BEATS: Beat[] = [
  {
    thinkMs: 700,
    tools: [
      { name: 'find_location', args: { query: '부산' } },
      { name: 'find_location', args: { query: '이천' } },
      { name: 'set_trip', args: { current: CURRENT, returnDepot: DEPOT, truckTons: 5, vehicleType: '윙바디', cargoType: '일반 화물', startHour: 6, deadlineHour: 20 } },
      { name: 'navigate', args: { section: 'lab' } },
    ],
    say: () => {
      const state = snap();
      const eligible = state?.eligibleLoads ?? 0;
      return `부산신항 3부두에서 출발해서 이천 호법물류단지로 복귀하는 하루로 잡았어요. 5톤 윙바디 기준으로 지금 붙일 수 있는 화물이 ${eligible}건 있습니다. 하루를 통째로 묶어볼까요?`;
    },
    followUp: '네, 묶어주세요',
  },
  {
    thinkMs: 400,
    tools: [{ name: 'run_optimization' }],
    awaitSolve: true,
    say: () => {
      const state = snap();
      const tour = state?.myTour;
      if (!tour) return '경로를 묶었어요. 화면에서 확인해 주세요.';
      return `${tour.legs.length}구간으로 묶었습니다. 공차는 ${pct(tour.emptyRatio)}까지 내려갔고, 오늘 실수령은 ${spokenWon(tour.netWon)}이에요. ${tour.depot} 복귀까지 포함된 금액입니다.`;
    },
    followUp: '단건으로 뛰는 거랑 얼마나 차이나요?',
  },
  {
    thinkMs: 500,
    tools: [{ name: 'compare_to_single_load' }],
    say: () => {
      const result = runTool('compare_to_single_load', {}) as {
        chained?: { netWon: number; legs: number };
        singleLoad?: { netWon: number; route: string };
        differenceWon?: number;
      };
      if (!result?.chained || !result?.singleLoad) {
        return '지금 조건에서는 비교할 단건이 마땅치 않네요.';
      }
      return `가장 운임 좋은 한 건만 잡고 빈 차로 돌아오면 ${spokenWon(result.singleLoad.netWon)}이에요. 같은 하루를 ${result.chained.legs}구간으로 묶으면 ${spokenWon(result.chained.netWon)}, ${spokenWon(result.differenceWon ?? 0)} 더 남습니다. 돌아오는 길을 비워두지 않아서 생기는 차이예요.`;
    },
    followUp: '짐은 어떤 순서로 실어요?',
  },
  {
    thinkMs: 450,
    tools: [{ name: 'get_loading_plan' }],
    say: () => {
      const state = snap();
      const plan = state?.loadingPlan ?? [];
      if (!plan.length) return '적재 계획은 배차가 확정되면 바로 잡아드릴게요.';
      const first = [...plan].sort((a, b) => a.unloadOrder - b.unloadOrder)[0];
      const last = [...plan].sort((a, b) => b.loadOrder - a.loadOrder)[0];
      return `내리는 순서의 역순으로 실어요. ${last.goods} ${last.tons}톤을 가장 안쪽에 넣고, 먼저 내릴 ${first.goods}는 문 쪽 ${first.zone === 'rear' ? '뒤칸' : '가운데'}에 둡니다. 중간에 짐을 헤집을 일이 없어요.`;
    },
    followUp: '몇 시에 집에 도착해요?',
  },
  {
    thinkMs: 400,
    tools: [
      { name: 'focus_load' },
      { name: 'get_economics' },
    ],
    say: () => {
      const state = snap();
      const tour = state?.myTour;
      if (!tour || !state) return '복귀 시각은 배차 확정과 함께 알려드릴게요.';
      return `${clock(state.trip.startHour, tour.hours)}에 차고지 도착이에요. 마지막 하차지에서 차고지까지 ${Math.round(tour.returnKm)}킬로미터고, 60킬로 안에서 끝나는 회차만 제안하니까 오늘은 확실히 집에서 주무십니다.`;
    },
    followUp: '이걸로 할게요',
  },
  {
    thinkMs: 350,
    tools: [{ name: 'navigate', args: { section: 'driver' } }],
    say: () => {
      const tour = snap()?.myTour;
      const legs = tour?.legs.length ?? 3;
      return `${legs}구간 전부 한 번에 잡아둘게요. 운송장은 바로 기사님 화면으로 갑니다. 오늘 하루 안전운전 하세요.`;
    },
  },
];

/**
 * Once the reel is finished it must not break on camera, so anything said
 * afterwards gets one of these instead of an error.
 */
const ENCORE: Beat[] = [
  {
    thinkMs: 350,
    say: () => {
      const tour = snap()?.myTour;
      return tour
        ? `오늘 회차는 이미 잡혀 있어요. ${tour.legs.length}구간에 실수령 ${spokenWon(tour.netWon)}입니다.`
        : '오늘 회차는 이미 잡혀 있어요.';
    },
  },
  {
    thinkMs: 350,
    tools: [{ name: 'navigate', args: { section: 'lab' } }],
    say: '다시 보여드릴게요. 화면에 오늘 묶인 경로가 그대로 있습니다.',
  },
];

export type ToolEvent = {
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export type ScriptCallbacks = {
  onText?: (delta: string) => void;
  onThinking?: () => void;
  onTool?: (event: ToolEvent) => void;
  onToolResult?: (event: ToolEvent) => void;
  /** Never fires here — kept so the panel can stay provider-agnostic. */
  onWait?: (seconds: number) => void;
};

/**
 * Same shape as the model client it replaces, so the panel does not care which
 * one it is holding.
 */
export class ScriptedSession {
  private index = 0;
  /** The driver's next line, played automatically. Null ends the exchange. */
  followUp: string | null = null;

  clear() {
    this.index = 0;
    this.followUp = null;
  }

  get turns(): number {
    return this.index;
  }

  async send(_message: string, callbacks: ScriptCallbacks = {}): Promise<string> {
    const beat =
      this.index < BEATS.length
        ? BEATS[this.index]
        : ENCORE[(this.index - BEATS.length) % ENCORE.length];
    this.index++;

    callbacks.onThinking?.();
    await sleep(beat.thinkMs ?? 500);

    for (const tool of beat.tools ?? []) {
      const args = tool.args ?? {};
      callbacks.onTool?.({ name: tool.name, args });
      // A beat's worth of latency per call: fast enough to feel live, slow
      // enough that the chips read one at a time on camera.
      await sleep(260 + Math.round(Math.random() * 220));
      const result = runTool(tool.name, resolveArgs(tool.name, args));
      callbacks.onToolResult?.({ name: tool.name, args, result });
      // React has to commit the form before the solver reads it — calling run
      // in the same tick would hand the annealer the previous, empty trip.
      if (tool.name === 'set_trip') await sleep(420);
    }

    if (beat.awaitSolve) await waitForSolve();

    const line = typeof beat.say === 'function' ? beat.say() : beat.say;
    await type(line, callbacks.onText);

    this.followUp = beat.followUp ?? null;
    return line;
  }
}

/** Late-bound arguments — things that are only knowable once a tour exists. */
function resolveArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== 'focus_load' || 'loadId' in args) return args;
  // Highlight the piece that comes off first; it is the one being talked about.
  const plan = snap()?.loadingPlan ?? [];
  const first = [...plan].sort((a, b) => a.unloadOrder - b.unloadOrder)[0];
  return first ? { loadId: first.loadId } : args;
}

/**
 * The annealer paces itself to a few seconds, so wait for it rather than guess
 * at a duration. But bail fast if it never started — a run the console refused
 * would otherwise leave the panel silent for the whole timeout, which is the
 * worst thing that could happen mid-recording. Three seconds of no movement
 * means it is not coming, and the line that follows copes with that.
 */
async function waitForSolve(timeoutMs = 25_000) {
  const startedAt = Date.now();
  let sawRunning = false;
  while (Date.now() - startedAt < timeoutMs) {
    const phase = snap()?.phase;
    if (phase === 'done') return;
    if (phase === 'running') sawRunning = true;
    else if (!sawRunning && Date.now() - startedAt > 3_000) return;
    await sleep(180);
  }
}

/**
 * Typed out rather than pasted in. The jitter is the point — an even cadence
 * reads as a progress bar, an uneven one reads as speech.
 */
async function type(text: string, onText?: (delta: string) => void) {
  if (!onText) return;
  for (const character of text) {
    onText(character);
    const pause = /[.!?…]/.test(character) ? 150 : /[,·]/.test(character) ? 90 : 18;
    await sleep(pause + Math.random() * 26);
  }
}
