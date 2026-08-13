import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/** Fades content up the first time it enters the viewport. */
export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
  className = '',
  style,
}: {
  children: ReactNode;
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'header';
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  const Component = Tag as 'div';
  return (
    <Component
      ref={ref as React.Ref<HTMLDivElement>}
      className={`reveal ${seen ? 'in' : ''} ${className}`}
      style={{ ...style, ['--d' as string]: `${delay}ms` }}
    >
      {children}
    </Component>
  );
}

/** Eases a displayed number toward its target so counters never snap. */
export function useEased(target: number, tau = 0.16) {
  const [value, setValue] = useState(target);
  const raf = useRef(0);
  const current = useRef(target);
  const goal = useRef(target);
  goal.current = target;

  // Animates only while there is distance left to cover, then parks itself —
  // six live counters spinning rAF forever would hold the main thread hostage.
  useEffect(() => {
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = 1 - Math.exp(-dt / tau);
      current.current += (goal.current - current.current) * k;

      const epsilon = Math.max(1e-3, Math.abs(goal.current) * 1e-5);
      const settled = Math.abs(goal.current - current.current) < epsilon;
      if (settled) current.current = goal.current;

      setValue(current.current);
      if (!settled) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, tau]);

  return value;
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="lg" x1="4" y1="2" x2="28" y2="30">
          <stop offset="0%" stopColor="#fff27a" />
          <stop offset="100%" stopColor="#fee500" />
        </linearGradient>
      </defs>
      {/* Three legs closing back on themselves — the loop, as a mark. */}
      <path
        d="M16 4 L27 22 L5 22 Z"
        stroke="url(#lg)"
        strokeWidth="2.4"
        strokeLinejoin="round"
        fill="rgba(254,229,0,0.13)"
      />
      <circle cx="16" cy="4" r="3.1" fill="#fff7b5" />
      <circle cx="27" cy="22" r="2.3" fill="#fee500" />
      <circle cx="5" cy="22" r="2.3" fill="#fee500" />
    </svg>
  );
}

export function Arrow({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8h10m0 0-4-4m4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Check({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.2 4.8 8.5 9.5 3.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Shield({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6 13.2 3.4v4.2c0 3.1-2.1 5.9-5.2 6.8-3.1-.9-5.2-3.7-5.2-6.8V3.4L8 1.6Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M5.9 7.9 7.4 9.4l3-3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Mic({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Spark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5 9.5 6.5 14.5 8 9.5 9.5 8 14.5 6.5 9.5 1.5 8 6.5 6.5 8 1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
