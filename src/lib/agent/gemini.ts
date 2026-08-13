/**
 * The Gemini client: streaming, function calling, no SDK.
 *
 * The whole app is a static Vite bundle, so this talks to the REST endpoint
 * directly with `fetch`. Two consequences worth knowing:
 *
 * The key ships inside the bundle. Anyone who opens the deployed site can read
 * it. That is an acceptable trade for a demo on a throwaway, quota-capped key,
 * and it is why `VITE_GEMINI_PROXY_URL` exists — point it at a serverless
 * function that holds the real key and this file needs no other change.
 *
 * And the tool loop lives here rather than in the UI. `send()` runs the whole
 * exchange — model, tool calls, model again — and reports each step through
 * callbacks, so the panel can show the agent working without knowing anything
 * about the protocol.
 */

import { SYSTEM_PROMPT } from './prompt';
import { liveContext } from './context';
import { TOOL_DECLARATIONS, runTool } from './tools';

const PROXY = import.meta.env.VITE_GEMINI_PROXY_URL?.trim();
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY?.trim();

/**
 * Tried in order on the first call; whichever answers is kept for the session.
 * Flash-Lite is the choice on a free key: the free tier's ceiling is requests
 * per minute, not intelligence, and Lite is both quicker to first token and
 * more generously rated. The pins behind it are there so a retired alias
 * doesn't take the demo down mid-pitch.
 */
const MODELS = [
  import.meta.env.VITE_GEMINI_MODEL?.trim(),
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
].filter(Boolean) as string[];

/**
 * The whole rate budget, in one place.
 *
 * A free Gemini key allows a fixed number of requests per rolling minute, and
 * *every* tool round is its own request. A one-minute demo therefore has a
 * budget of roughly one bucket, total — so the throttle below is not a safety
 * net, it is the thing that decides whether the demo survives. Raise this the
 * moment the key is on a paid tier.
 */
const RPM = Number(import.meta.env.VITE_GEMINI_RPM ?? 15);
/** Leave one in hand: a 429 costs more than a short wait. */
const RESERVE = 1;

/**
 * A model that keeps calling tools without ever answering is a bug, not a
 * plan — and at four rounds a single question could eat a third of the minute.
 */
const MAX_TOOL_ROUNDS = 4;
/** Turns of history kept. Long enough to hold a conversation, short enough to stay cheap. */
const MAX_HISTORY = 16;
/** Old tool results are re-sent on every request; past this many they are dropped. */
const KEEP_FULL_RESULTS = 6;

/**
 * `thoughtSignature` is Gemini 3's opaque reasoning token, and it is not
 * optional: a function call has to go back into the history carrying the exact
 * signature it arrived with, or the next turn is rejected. That is why model
 * turns are stored as the raw parts off the wire rather than rebuilt from the
 * name and args — reconstructing them silently drops the signature and the
 * call id that pairs a parallel call with its response.
 */
type FunctionCall = {
  name: string;
  args: Record<string, unknown>;
  id?: string;
};

type Part =
  | { text: string; thoughtSignature?: string }
  | { functionCall: FunctionCall; thoughtSignature?: string }
  | {
      functionResponse: { name: string; response: Record<string, unknown>; id?: string };
    };

type Content = { role: 'user' | 'model'; parts: Part[] };

export type ToolEvent = {
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export type SendCallbacks = {
  /** Fired per streamed chunk of the visible answer. */
  onText?: (delta: string) => void;
  /** Fired when the model decides to act, before the tool runs. */
  onTool?: (event: ToolEvent) => void;
  /** Fired after that tool returns. */
  onToolResult?: (event: ToolEvent) => void;
  /** Fired when the turn is stalled on the rate limit, so the UI can say so. */
  onWait?: (seconds: number) => void;
};

/**
 * A rolling-window request budget shared by every call in the tab.
 *
 * Not a fixed delay between requests — the limit is N per minute, so a burst
 * of four is fine and only the fifth-past-N has to wait. That matters here:
 * the expensive moment is the opening exchange, where three or four requests
 * land back to back, and spacing them evenly would make the agent feel slow
 * for no gain.
 */
const requestLog: number[] = [];

function budgetWaitMs(): number {
  const now = Date.now();
  while (requestLog.length && now - requestLog[0] >= 60_000) requestLog.shift();
  if (requestLog.length < Math.max(1, RPM - RESERVE)) return 0;
  return 60_000 - (now - requestLog[0]) + 50;
}

async function claimSlot(onWait?: (seconds: number) => void, signal?: AbortSignal) {
  for (;;) {
    const wait = budgetWaitMs();
    if (wait <= 0) break;
    onWait?.(Math.ceil(wait / 1000));
    await sleep(wait, signal);
  }
  requestLog.push(Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Google puts the retry delay in the error body; honour it over guessing. */
function retryDelayMs(detail: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(detail);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

export function agentConfigured(): boolean {
  return Boolean(PROXY || API_KEY);
}

export class AgentSession {
  private history: Content[] = [];
  private model = MODELS[0];
  private modelResolved = Boolean(PROXY);

  /** Drop the conversation but keep the resolved model. */
  clear() {
    this.history = [];
  }

  get turns(): number {
    return this.history.length;
  }

  /**
   * One user turn, start to finish: stream the answer, run whatever tools the
   * model asks for, feed the results back, repeat until it stops calling tools.
   * Resolves with the final visible text.
   */
  async send(message: string, callbacks: SendCallbacks = {}, signal?: AbortSignal): Promise<string> {
    if (!agentConfigured()) {
      throw new Error('Gemini API key is missing. Put VITE_GEMINI_API_KEY in .env.local and restart the dev server.');
    }

    this.history.push({ role: 'user', parts: [{ text: message }] });

    let answer = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { text, calls, parts } = await this.stream(callbacks, signal);

      // Verbatim — signatures and call ids included.
      if (parts.length) this.history.push({ role: 'model', parts });

      answer = text || answer;
      if (!calls.length) break;

      const responses: Part[] = [];
      for (const call of calls) {
        const event: ToolEvent = { name: call.name, args: call.args };
        callbacks.onTool?.(event);
        const result = runTool(call.name, call.args);
        callbacks.onToolResult?.({ ...event, result });
        responses.push({
          functionResponse: {
            name: call.name,
            response: result,
            // Pairs this result with its call when several ran in one turn.
            ...(call.id ? { id: call.id } : {}),
          },
        });
      }
      // Function results go back as a user-role turn — that is the shape the
      // v1beta REST endpoint expects, the same one the official SDKs build.
      this.history.push({ role: 'user', parts: responses });

      if (round === MAX_TOOL_ROUNDS - 1) {
        answer = answer || '요청을 끝까지 처리하지 못했어요. 다시 한 번 말씀해 주시겠어요?';
      }
    }

    this.trim();
    return answer;
  }

  /**
   * One request/response against the API: budget first, then the model
   * fallback on 404, then a bounded retry if the limit is hit anyway.
   */
  private async stream(
    callbacks: SendCallbacks,
    signal?: AbortSignal,
  ): Promise<StreamOutcome> {
    for (let attempt = 0; ; attempt++) {
      await claimSlot(callbacks.onWait, signal);

      const models = this.modelResolved ? [this.model] : MODELS;
      let response: Response | null = null;
      let lastError: Error | null = null;

      for (const model of models) {
        const candidate = await this.post(model, signal);
        if (candidate.status === 404 && !this.modelResolved) {
          lastError = new Error(`Model ${model} is unavailable for this key.`);
          continue;
        }
        this.model = model;
        this.modelResolved = true;
        response = candidate;
        break;
      }
      if (!response) throw lastError ?? new Error('No Gemini model available for this key.');

      if (response.ok) return await consume(response, callbacks.onText);

      // 429 is survivable twice; past that the minute is genuinely spent and
      // saying so is better than stalling behind a spinner.
      if (response.status === 429 && attempt < 2) {
        const detail = await response.text();
        const wait = retryDelayMs(detail) ?? (attempt + 1) * 8_000;
        callbacks.onWait?.(Math.ceil(wait / 1000));
        // Treat the window as spent so the next claim waits rather than racing.
        requestLog.push(Date.now());
        await sleep(wait, signal);
        continue;
      }
      throw new Error(await describeFailure(response));
    }
  }

  private post(model: string, signal?: AbortSignal): Promise<Response> {
    const body = JSON.stringify({
      contents: this.compact(),
      // The live state rides in the system instruction, not the history: it is
      // rebuilt every request, so it is never stale and never accumulates.
      systemInstruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\n${liveContext()}` }] },
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.4, topP: 0.95, maxOutputTokens: 1024 },
      safetySettings: [],
    });

    if (PROXY) {
      return fetch(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
    }
    return fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY as string },
        body,
        signal,
      },
    );
  }

  /**
   * The history as it goes on the wire. Tool results are by far the biggest
   * thing in it and the least useful once acted on — the live state block
   * already carries anything still true — so older ones are replaced by a
   * marker rather than re-uploaded every turn.
   */
  private compact(): Content[] {
    const cutoff = this.history.length - KEEP_FULL_RESULTS;
    return this.history.map((content, index) => {
      if (index >= cutoff || !hasFunctionResponse(content)) return content;
      return {
        ...content,
        parts: content.parts.map((part) =>
          'functionResponse' in part
            ? {
                functionResponse: {
                  name: part.functionResponse.name,
                  response: { note: 'earlier result — see the live state block for current values' },
                },
              }
            : part,
        ),
      };
    });
  }

  private trim() {
    if (this.history.length <= MAX_HISTORY) return;
    // Never start the kept window on a function response — it would reference a
    // call the model can no longer see.
    let cut = this.history.length - MAX_HISTORY;
    while (cut < this.history.length && hasFunctionResponse(this.history[cut])) cut++;
    this.history = this.history.slice(cut);
  }
}

function hasFunctionResponse(content: Content): boolean {
  return content.parts.some((part) => 'functionResponse' in part);
}

/** Reads the SSE body, emitting text as it lands and collecting tool calls. */
async function consume(response: Response, onText?: (delta: string) => void): Promise<StreamOutcome> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Gemini returned an empty response body.');

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const calls: FunctionCall[] = [];
  const parts: Part[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame may span chunks.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');

      const payload = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!payload || payload === '[DONE]') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      for (const part of partsOf(parsed)) {
        parts.push(part);
        if ('text' in part && typeof part.text === 'string') {
          text += part.text;
          onText?.(part.text);
        } else if ('functionCall' in part && part.functionCall) {
          calls.push({
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            id: part.functionCall.id,
          });
        }
      }
    }
  }
  return { text, calls, parts };
}

type StreamOutcome = {
  text: string;
  calls: FunctionCall[];
  /** Exactly what the model sent, for replaying into the history. */
  parts: Part[];
};

type StreamChunk = {
  candidates?: { content?: { parts?: Part[] } }[];
  promptFeedback?: { blockReason?: string };
};

function partsOf(chunk: unknown): Part[] {
  const typed = chunk as StreamChunk;
  if (typed?.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request (${typed.promptFeedback.blockReason}).`);
  }
  return typed?.candidates?.[0]?.content?.parts ?? [];
}

async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body?.error?.message ?? '';
  } catch {
    /* non-JSON error body — the status alone will have to do */
  }
  if (response.status === 400 && /API key/i.test(detail)) {
    return 'Gemini rejected the API key. Check VITE_GEMINI_API_KEY in .env.local.';
  }
  if (response.status === 429) {
    return 'Gemini is rate-limiting this key. Wait a moment and try again.';
  }
  return `Gemini request failed (${response.status})${detail ? `: ${detail}` : ''}`;
}
