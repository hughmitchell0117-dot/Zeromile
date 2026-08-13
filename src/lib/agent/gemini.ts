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
import { TOOL_DECLARATIONS, runTool } from './tools';

const PROXY = import.meta.env.VITE_GEMINI_PROXY_URL?.trim();
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY?.trim();

/**
 * Tried in order on the first call; whichever answers is kept for the session.
 * The alias tracks Google's current Flash, the pins are there so a retired
 * alias doesn't take the demo down.
 */
const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

/** A model that keeps calling tools without ever answering is a bug, not a plan. */
const MAX_TOOL_ROUNDS = 8;
/** Turns of history kept. Long enough to hold a conversation, short enough to stay cheap. */
const MAX_HISTORY = 24;

type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

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
};

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
      const { text, calls } = await this.stream(callbacks.onText, signal);

      const parts: Part[] = [];
      if (text) parts.push({ text });
      for (const call of calls) parts.push({ functionCall: call });
      if (parts.length) this.history.push({ role: 'model', parts });

      answer = text || answer;
      if (!calls.length) break;

      const responses: Part[] = [];
      for (const call of calls) {
        const event: ToolEvent = { name: call.name, args: call.args };
        callbacks.onTool?.(event);
        const result = runTool(call.name, call.args);
        callbacks.onToolResult?.({ ...event, result });
        responses.push({ functionResponse: { name: call.name, response: result } });
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

  /** One request/response against the API, with the model fallback on 404. */
  private async stream(
    onText: ((delta: string) => void) | undefined,
    signal?: AbortSignal,
  ): Promise<{ text: string; calls: { name: string; args: Record<string, unknown> }[] }> {
    const attempts = this.modelResolved ? [this.model] : MODELS;
    let lastError: Error | null = null;

    for (const model of attempts) {
      const response = await this.post(model, signal);
      if (response.status === 404 && !this.modelResolved) {
        lastError = new Error(`Model ${model} is unavailable for this key.`);
        continue;
      }
      if (!response.ok) {
        throw new Error(await describeFailure(response));
      }
      this.model = model;
      this.modelResolved = true;
      return await consume(response, onText);
    }
    throw lastError ?? new Error('No Gemini model available for this key.');
  }

  private post(model: string, signal?: AbortSignal): Promise<Response> {
    const body = JSON.stringify({
      contents: this.history,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
async function consume(
  response: Response,
  onText?: (delta: string) => void,
): Promise<{ text: string; calls: { name: string; args: Record<string, unknown> }[] }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Gemini returned an empty response body.');

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const calls: { name: string; args: Record<string, unknown> }[] = [];

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
        if ('text' in part && typeof part.text === 'string') {
          text += part.text;
          onText?.(part.text);
        } else if ('functionCall' in part && part.functionCall) {
          calls.push({
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }
  }
  return { text, calls };
}

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
