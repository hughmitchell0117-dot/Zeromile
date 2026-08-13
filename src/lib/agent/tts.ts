/**
 * The agent's voice: ElevenLabs, with the browser's own synthesiser as a net.
 *
 * `speechSynthesis` was fine as plumbing but wrong for the pitch — the stock
 * Korean voices are flat and robotic, and the whole point of a driver-facing
 * agent is that it sounds like a person on the other end of a call. Rosa Oh is
 * a Seoul-accent conversational voice; the model behind it is multilingual, so
 * the same voice carries the English answers too and the agent does not change
 * identity when the driver switches language.
 *
 * Failures here are never fatal. Any error — no key, quota gone, offline —
 * returns false and the caller falls back to the browser voice, because a demo
 * that talks badly is a great deal better than one that goes silent.
 */

const KEY = import.meta.env.VITE_ELEVENLABS_API_KEY?.trim();
/** Rosa Oh — calm, polished, measured. Overridable without touching code. */
const VOICE_ID = import.meta.env.VITE_ELEVENLABS_VOICE_ID?.trim() || 'sf8Bpb1IU97NI9BHSMRf';

/**
 * Rosa Oh is a Voice Library voice, and ElevenLabs only serves those over the
 * API on a paid plan — a free key gets 402 and nothing else. Rather than let
 * that drop the agent all the way back to the browser's kiosk voice, the first
 * 402 latches onto a premade voice, which every plan can use. Sarah is the
 * nearest premade match in character; the accent is wrong for Korean, so this
 * is a floor, not a substitute. Upgrade the plan and Rosa comes back with no
 * code change.
 */
const FALLBACK_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
let voiceId = VOICE_ID;
let warned = false;

/**
 * Flash is the low-latency multilingual model — roughly a fifth of the credits
 * of v2 and quick enough that the reply starts while the driver is still
 * looking at the screen. Korean is fully supported.
 */
const MODEL_ID = 'eleven_flash_v2_5';

/** Long answers cost credits and nobody listens past a few sentences anyway. */
const MAX_CHARS = 600;

export function elevenConfigured(): boolean {
  return Boolean(KEY);
}

/**
 * One at a time, always. A second `speak()` cuts the first off rather than
 * queueing — the agent talking over itself is the worst possible failure here.
 */
export class Speaker {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private controller: AbortController | null = null;

  /** Resolves true if ElevenLabs spoke it, false if the caller should fall back. */
  async speak(
    text: string,
    handlers: { onStart?: () => void; onEnd?: () => void } = {},
  ): Promise<boolean> {
    if (!KEY) return false;
    const line = text.trim().slice(0, MAX_CHARS);
    if (!line) return false;

    this.stop();
    const controller = new AbortController();
    this.controller = controller;

    try {
      let response = await this.request(line, voiceId, controller.signal);

      // 402 is the paid-voice wall; 401 is a voice this key may not read.
      if ((response.status === 402 || response.status === 401) && voiceId !== FALLBACK_VOICE_ID) {
        if (!warned) {
          warned = true;
          console.warn(
            `[agent] ElevenLabs refused voice ${voiceId} (${response.status}) — it needs a paid plan. Falling back to a premade voice.`,
          );
        }
        voiceId = FALLBACK_VOICE_ID;
        response = await this.request(line, voiceId, controller.signal);
      }

      if (!response.ok) return false;

      const blob = await response.blob();
      if (controller.signal.aborted) return false;

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.objectUrl = url;
      this.audio = audio;

      const done = () => {
        this.release(url);
        handlers.onEnd?.();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.onplaying = () => handlers.onStart?.();

      await audio.play();
      return true;
    } catch {
      // Aborted, blocked by autoplay policy, network down — all the same to us.
      return false;
    }
  }

  private request(text: string, voice: string, signal: AbortSignal): Promise<Response> {
    return fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': KEY as string, 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: {
            // Measured but not monotone: enough stability to stay calm across a
            // read of numbers, enough style to not sound like a kiosk.
            stability: 0.45,
            similarity_boost: 0.8,
            style: 0.15,
            use_speaker_boost: true,
            speed: 1.04,
          },
        }),
      },
    );
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
    }
    if (this.objectUrl) this.release(this.objectUrl);
    this.audio = null;
  }

  private release(url: string) {
    if (this.objectUrl === url) {
      URL.revokeObjectURL(url);
      this.objectUrl = null;
    }
    this.audio = null;
  }
}
