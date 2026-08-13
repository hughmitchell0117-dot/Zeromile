/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_GEMINI_PROXY_URL?: string;
  readonly VITE_GEMINI_MODEL?: string;
  readonly VITE_GEMINI_RPM?: string;
  readonly VITE_ELEVENLABS_API_KEY?: string;
  readonly VITE_ELEVENLABS_VOICE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/*
 * The Web Speech API is not in TypeScript's DOM lib — it never made it out of
 * a draft spec, and Chrome still ships it behind the `webkit` prefix. These are
 * the parts `src/lib/agent/voice.ts` actually touches, nothing more.
 */
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
  onstart: ((event: Event) => void) | null;
}

declare const SpeechRecognition: { new (): SpeechRecognition } | undefined;

interface Window {
  SpeechRecognition?: { new (): SpeechRecognition };
  webkitSpeechRecognition?: { new (): SpeechRecognition };
}
