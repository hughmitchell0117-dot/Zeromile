/**
 * Voice for the agent: a wake word, dictation, spoken replies, and a real
 * microphone level for the animation.
 *
 * This is the Web Speech API, which is a draft spec Chrome ships behind a
 * prefix — so everything here is feature-detected and the panel stays fully
 * usable by keyboard when it is missing. Two behaviours it forces on us:
 * recognition stops itself after a stretch of silence, so it is restarted on
 * `onend` for as long as the mic is armed; and it hears the page's own speech
 * synthesis, so results are dropped while the agent is talking.
 *
 * The level meter is a separate getUserMedia capture feeding an AnalyserNode.
 * It is written into a ref rather than state on purpose — sixty renders a
 * second to move a bar would cost more than the bar is worth.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Said by itself or in front of a command: "제로마일, 지금 부산이에요". */
const WAKE_WORDS = ['제로마일', '제로 마일', 'zeromile', 'zero mile', '지로마일'];

/** How long a pause ends the driver's sentence. */
const UTTERANCE_GAP_MS = 1100;

export type VoiceStatus = 'off' | 'idle' | 'hearing' | 'speaking' | 'blocked';

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function createRecognition(lang: string): SpeechRecognition | null {
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  return recognition;
}

/** Strips the wake word and returns whatever the driver said after it. */
function afterWake(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of WAKE_WORDS) {
    const at = lower.indexOf(word);
    if (at === -1) continue;
    return text.slice(at + word.length).replace(/^[\s,./·!?~-]+/, '').trim();
  }
  return null;
}

export function useVoice({
  armed,
  open,
  lang = 'ko-KR',
  onWake,
  onUtterance,
}: {
  /** The mic toggle in the masthead. */
  armed: boolean;
  /** Whether the agent panel is on screen — decides wake-word vs dictation. */
  open: boolean;
  lang?: string;
  onWake: (command: string) => void;
  onUtterance: (text: string) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus>('off');
  const [interim, setInterim] = useState('');
  const levelRef = useRef(0);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const wantedRef = useRef(false);
  const speakingRef = useRef(false);
  const openRef = useRef(open);
  const pendingRef = useRef('');
  const gapRef = useRef(0);

  // Callbacks change identity every render; the recognition handlers are bound
  // once, so they read through refs instead of being torn down and rebuilt.
  const onWakeRef = useRef(onWake);
  const onUtteranceRef = useRef(onUtterance);
  onWakeRef.current = onWake;
  onUtteranceRef.current = onUtterance;
  openRef.current = open;

  const flush = useCallback(() => {
    const text = pendingRef.current.trim();
    pendingRef.current = '';
    setInterim('');
    if (text) onUtteranceRef.current(text);
  }, []);

  /* ── Recognition ───────────────────────────────────────────────────── */
  useEffect(() => {
    if (!armed) {
      wantedRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setStatus('off');
      setInterim('');
      return;
    }
    if (!speechSupported()) {
      setStatus('blocked');
      return;
    }

    const recognition = createRecognition(lang);
    if (!recognition) {
      setStatus('blocked');
      return;
    }
    recognitionRef.current = recognition;
    wantedRef.current = true;

    recognition.onstart = () => setStatus((s) => (s === 'speaking' ? s : 'idle'));

    recognition.onresult = (event) => {
      // Our own synthesised voice comes back through the microphone; anything
      // heard while the agent is talking is an echo, not the driver.
      if (speakingRef.current) return;

      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const chunk = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += chunk;
        else interimText += chunk;
      }

      if (!openRef.current) {
        // Closed: the only thing worth hearing is the wake word. Check interim
        // text too, so the panel opens the instant it is said.
        const heard = `${finalText} ${interimText}`;
        const command = afterWake(heard);
        if (command !== null) {
          setInterim('');
          onWakeRef.current(command);
        }
        return;
      }

      setStatus('hearing');
      if (interimText) setInterim(interimText);
      if (finalText) {
        // A wake word spoken while the panel is already open is throat-clearing.
        pendingRef.current += ` ${afterWake(finalText) ?? finalText}`;
        setInterim('');
      }

      window.clearTimeout(gapRef.current);
      gapRef.current = window.setTimeout(() => {
        setStatus('idle');
        flush();
      }, UTTERANCE_GAP_MS);
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        wantedRef.current = false;
        setStatus('blocked');
      }
      // 'no-speech' and 'aborted' are routine; onend restarts.
    };

    recognition.onend = () => {
      if (!wantedRef.current) return;
      // Chrome ends the session on its own after silence. Restart on the next
      // tick — restarting synchronously inside onend throws InvalidStateError.
      window.setTimeout(() => {
        if (!wantedRef.current) return;
        try {
          recognition.start();
        } catch {
          /* already running — nothing to do */
        }
      }, 250);
    };

    try {
      recognition.start();
    } catch {
      /* a start while one is already live is harmless */
    }

    return () => {
      wantedRef.current = false;
      window.clearTimeout(gapRef.current);
      recognition.onend = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, [armed, lang, flush]);

  /* ── Microphone level, for the animation ───────────────────────────── */
  useEffect(() => {
    if (!armed || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = granted;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        context.createMediaStreamSource(granted).connect(analyser);

        const buffer = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buffer);
          let sum = 0;
          for (const sample of buffer) {
            const centred = (sample - 128) / 128;
            sum += centred * centred;
          }
          // RMS is small for speech; scale it into something a bar can use.
          const rms = Math.sqrt(sum / buffer.length);
          levelRef.current = Math.min(1, rms * 4.5);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      })
      .catch(() => {
        // Denied or unavailable — the visualiser falls back to its idle drift.
        levelRef.current = 0;
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      levelRef.current = 0;
    };
  }, [armed]);

  /* ── Speaking ──────────────────────────────────────────────────────── */
  const speak = useCallback((text: string) => {
    if (typeof speechSynthesis === 'undefined' || !text.trim()) return;
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const korean = /[ㄱ-힝]/.test(text);
    utterance.lang = korean ? 'ko-KR' : 'en-US';
    utterance.rate = korean ? 1.05 : 1.0;
    utterance.pitch = 1;

    const voice = speechSynthesis
      .getVoices()
      .find((v) => v.lang.replace('_', '-').startsWith(utterance.lang.slice(0, 2)));
    if (voice) utterance.voice = voice;

    utterance.onstart = () => {
      speakingRef.current = true;
      setStatus('speaking');
    };
    const finish = () => {
      speakingRef.current = false;
      setStatus((s) => (s === 'speaking' ? 'idle' : s));
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    speechSynthesis.speak(utterance);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    speakingRef.current = false;
    setStatus((s) => (s === 'speaking' ? 'idle' : s));
  }, []);

  useEffect(() => stopSpeaking, [stopSpeaking]);

  return { status, interim, levelRef, speak, stopSpeaking, supported: speechSupported() };
}

/**
 * Spoken replies should not read out punctuation art or stray markdown. The
 * model is told not to produce any, but a stray asterisk in a demo is worse
 * than a cheap regex.
 */
export function speakable(text: string): string {
  return text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
