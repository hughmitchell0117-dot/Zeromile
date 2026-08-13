/**
 * The agent: a spotlight panel over the page, driven by voice or typing.
 *
 * It is mounted for the whole session even while hidden, because the wake word
 * has to be heard when the panel is closed — arming the mic in the masthead
 * starts recognition, and "제로마일" is what opens this.
 *
 * The panel deliberately floats rather than docking: the whole point is that
 * the agent is operating the site underneath it, so it stays small, stays
 * translucent, and can be dragged out of the way of whatever it just did.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentSession, agentConfigured, type ToolEvent } from '../lib/agent/gemini';
import { GREETING } from '../lib/agent/prompt';
import { elevenConfigured } from '../lib/agent/tts';
import { speakable, useVoice } from '../lib/agent/voice';

type Message = {
  id: number;
  role: 'user' | 'agent';
  text: string;
  tools: ToolEvent[];
  pending?: boolean;
  error?: boolean;
};

/** What each tool is called when the agent is caught doing it. */
const TOOL_LABELS: Record<string, string> = {
  navigate: '화면 이동',
  set_theme: '테마 변경',
  find_location: '위치 조회',
  list_cities: '운행 도시 확인',
  get_trip_status: '입력 상태 확인',
  set_trip: '조건 입력',
  set_scenario: '시나리오 변경',
  run_optimization: '최적화 실행',
  reset_simulation: '초기화',
  get_result_summary: '결과 요약',
  get_my_tour: '내 회차 조회',
  explain_leg: '구간 분석',
  list_alternatives: '대안 경로 비교',
  compare_to_single_load: '단건 운송과 비교',
  get_economics: '운임 기준 확인',
  get_loading_plan: '적재 계획 조회',
  focus_load: '적재물 강조',
  set_load_treatment: '적재 방식 변경',
};

const SUGGESTIONS = [
  '지금 부산이고 의왕 차고지로 돌아가요',
  '이 회차 하면 얼마 남아요?',
  '단건으로 뛰는 것보다 얼마나 나아요?',
  '짐은 어떤 순서로 실어요?',
];

export function AgentLauncher({
  armed,
  open,
  onToggle,
}: {
  armed: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`zm-agent-key${armed ? ' armed' : ''}${open ? ' open' : ''}`}
      onClick={onToggle}
      aria-label={armed ? '음성 배차 도우미 끄기' : '음성 배차 도우미 켜기'}
      aria-pressed={armed}
      title={armed ? '"제로마일"이라고 부르면 열려요' : '음성 배차 도우미'}
    >
      <MicGlyph />
      <span className="zm-agent-key-label">AGENT</span>
      <i className="zm-agent-key-dot" />
    </button>
  );
}

export default function Agent({
  armed,
  open,
  onOpen,
  onClose,
}: {
  armed: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** Seconds left on the API's rate limit, when we are stalled on it. */
  const [waiting, setWaiting] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const sessionRef = useRef<AgentSession | null>(null);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const armedRef = useRef(armed);
  armedRef.current = armed;

  if (!sessionRef.current) sessionRef.current = new AgentSession();

  const push = useCallback((message: Omit<Message, 'id'>) => {
    const id = ++idRef.current;
    setMessages((current) => [...current, { ...message, id }]);
    return id;
  }, []);

  const patch = useCallback((id: number, change: Partial<Message>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...change } : message)),
    );
  }, []);

  /* ── Talking to Gemini ─────────────────────────────────────────────── */
  const speakRef = useRef<(text: string) => void>(() => {});

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setDraft('');

      push({ role: 'user', text: trimmed, tools: [] });
      const replyId = push({ role: 'agent', text: '', tools: [], pending: true });

      let streamed = '';
      const tools: ToolEvent[] = [];
      try {
        const answer = await sessionRef.current!.send(trimmed, {
          onText: (delta) => {
            streamed += delta;
            patch(replyId, { text: streamed });
          },
          onTool: (event) => {
            tools.push(event);
            patch(replyId, { tools: [...tools] });
          },
          onToolResult: (event) => {
            const last = tools[tools.length - 1];
            if (last && last.name === event.name) last.result = event.result;
            patch(replyId, { tools: [...tools] });
          },
          onWait: (seconds) => setWaiting(seconds),
        });
        const final = answer || streamed;
        patch(replyId, { text: final, pending: false, tools: [...tools] });
        if (armedRef.current && final) speakRef.current(speakable(final));
      } catch (error) {
        patch(replyId, {
          text: error instanceof Error ? error.message : '연결에 문제가 있었어요. 다시 시도해 주세요.',
          pending: false,
          error: true,
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
        setWaiting(0);
      }
    },
    [patch, push],
  );

  /* ── Voice ─────────────────────────────────────────────────────────── */
  const handleWake = useCallback(
    (command: string) => {
      onOpen();
      if (command) void send(command);
    },
    [onOpen, send],
  );

  const { status, interim, levelRef, speak, stopSpeaking, supported } = useVoice({
    armed,
    open,
    onWake: handleWake,
    onUtterance: (text) => void send(text),
  });
  speakRef.current = speak;

  /* ── Panel behaviour ───────────────────────────────────────────────── */
  const greetedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    // A ref, not messages.length: StrictMode runs this twice on mount, and the
    // state it would be reading has not flushed in between.
    if (greetedRef.current) return;
    greetedRef.current = true;
    push({ role: 'agent', text: GREETING, tools: [] });
    if (armedRef.current) speak(speakable(GREETING));
  }, [open, push, speak]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, interim]);

  // Count the rate-limit wait down rather than showing a frozen number — a
  // stalled demo needs to look like it is going somewhere.
  useEffect(() => {
    if (waiting <= 0) return;
    const timer = setInterval(() => setWaiting((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        stopSpeaking();
        onClose();
      }
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (open) onClose();
        else onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpen, onClose, stopSpeaking]);

  /* ── Dragging ──────────────────────────────────────────────────────── */
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const onGrab = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button, textarea')) return;
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Clamped generously rather than exactly — the panel may hang off an edge,
    // it just may not be dragged somewhere it can't be dragged back from.
    const limitX = window.innerWidth / 2;
    const limitY = window.innerHeight / 2;
    setOffset({
      x: Math.max(-limitX, Math.min(limitX, drag.ox + event.clientX - drag.x)),
      y: Math.max(-120, Math.min(limitY, drag.oy + event.clientY - drag.y)),
    });
  };

  const onRelease = (event: React.PointerEvent) => {
    dragRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  if (!open) return null;

  const configured = agentConfigured();

  return (
    <div className="zm-agent-layer" role="dialog" aria-label="제로마일 배차 도우미">
      <div
        className={`zm-agent${status === 'hearing' ? ' hearing' : ''}${status === 'speaking' ? ' speaking' : ''}`}
        style={{ transform: `translate(calc(-50% + ${offset.x}px), ${offset.y}px)` }}
      >
        <header
          className="zm-agent-bar"
          onPointerDown={onGrab}
          onPointerMove={onDrag}
          onPointerUp={onRelease}
          onPointerCancel={onRelease}
        >
          <VoiceOrb levelRef={levelRef} status={status} />
          <div className="zm-agent-id">
            <b>ZeroMile 배차 도우미</b>
            <span>
              {waiting > 0
                ? `무료 한도 대기 ${waiting}초`
                : status === 'speaking'
                ? '말하는 중'
                : status === 'hearing'
                  ? '듣는 중'
                  : busy
                    ? '처리 중'
                    : armed
                      ? '"제로마일"이라고 부르세요'
                      : '음성 꺼짐 · 입력으로 대화'}
            </span>
          </div>
          <button type="button" className="zm-agent-x" onClick={() => { stopSpeaking(); onClose(); }} aria-label="닫기">
            ✕
          </button>
        </header>

        <div className="zm-agent-scroll" ref={scrollRef}>
          {!configured && (
            <p className="zm-agent-warn">
              GEMINI API 키가 없습니다. <code>.env.local</code>에 <code>VITE_GEMINI_API_KEY</code>를 넣고 개발
              서버를 다시 시작하세요.
            </p>
          )}

          {messages.map((message) => (
            <div key={message.id} className={`zm-agent-msg ${message.role}${message.error ? ' err' : ''}`}>
              {message.tools.length > 0 && (
                <div className="zm-agent-tools">
                  {message.tools.map((tool, index) => (
                    <span
                      key={`${tool.name}-${index}`}
                      className={`zm-agent-tool${tool.result ? ' done' : ''}${
                        tool.result && 'error' in tool.result ? ' failed' : ''
                      }`}
                    >
                      <i />
                      {TOOL_LABELS[tool.name] ?? tool.name}
                    </span>
                  ))}
                </div>
              )}
              {message.text ? (
                <p>{message.text}</p>
              ) : message.pending ? (
                <p className="zm-agent-dots">
                  <i />
                  <i />
                  <i />
                </p>
              ) : null}
            </div>
          ))}

          {interim && <div className="zm-agent-msg user interim"><p>{interim}</p></div>}

          {messages.length <= 1 && !busy && (
            <div className="zm-agent-chips">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => void send(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        <form
          className="zm-agent-input"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={armed ? '말하거나 입력하세요' : '무엇이든 물어보세요'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="보내기">
            ↵
          </button>
        </form>

        <footer className="zm-agent-foot">
          <span>{supported ? 'ESC 닫기 · ⌘K 열기' : '이 브라우저는 음성 인식을 지원하지 않아요'}</span>
          <span className="zm-agent-mark">
            GEMINI{elevenConfigured() ? ' · ELEVENLABS' : ''} · 실시간 배차 연산
          </span>
        </footer>
      </div>
    </div>
  );
}

/**
 * The listening animation. Real microphone amplitude off the analyser, with a
 * slow idle drift underneath so the thing is alive before anyone speaks.
 */
function VoiceOrb({
  levelRef,
  status,
}: {
  levelRef: React.RefObject<number>;
  status: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = 34;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const bars = 5;
    const smoothed = Array.from({ length: bars }, () => 0.1);
    let frame = 0;
    let t = 0;

    const draw = () => {
      t += 0.05;
      const live = statusRef.current === 'hearing' || statusRef.current === 'speaking';
      const level = statusRef.current === 'speaking' ? 0.55 + Math.sin(t * 2.4) * 0.25 : levelRef.current ?? 0;

      ctx.clearRect(0, 0, size, size);
      const accent = getComputedStyle(canvas).getPropertyValue('--yellow').trim() || '#fee500';

      for (let i = 0; i < bars; i++) {
        // Middle bars react hardest, so the cluster reads as one voice.
        const weight = 1 - Math.abs(i - (bars - 1) / 2) / bars;
        const idle = 0.12 + Math.sin(t + i * 0.9) * 0.05;
        const target = live ? Math.max(idle, level * (0.5 + weight)) : idle;
        smoothed[i] += (target - smoothed[i]) * 0.28;

        const h = Math.max(3, Math.min(1, smoothed[i]) * size * 0.8);
        const x = i * 5 + (size - (bars * 5 - 2)) / 2;
        ctx.fillStyle = accent;
        ctx.globalAlpha = live ? 0.95 : 0.45;
        ctx.beginPath();
        ctx.roundRect(x, (size - h) / 2, 3, h, 1.5);
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levelRef]);

  return <canvas className="zm-agent-orb" ref={canvasRef} aria-hidden />;
}

function MicGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <rect x="5.6" y="1.4" width="4.8" height="8" rx="2.4" fill="currentColor" />
      <path
        d="M3.2 7.4a4.8 4.8 0 0 0 9.6 0M8 12.2v2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
