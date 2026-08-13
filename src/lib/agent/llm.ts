/**
 * The model client: GLM 5.2 on NVIDIA NIM, over the OpenAI chat-completions
 * shape, with streaming and tool calling.
 *
 * It talks to `/nim/v1`, not to NVIDIA. The API sends no CORS headers, so the
 * browser cannot reach it directly; the Vite dev proxy adds the Authorization
 * header from a plain (non-VITE_) env var. That means the key is not in the
 * bundle — unlike every earlier version of this file — and swapping the dev
 * proxy for a deployed function is a change of `VITE_LLM_BASE` and nothing
 * else.
 *
 * The one thing worth knowing about this model: it streams its reasoning in a
 * separate `reasoning_content` field, and that must never be shown. It is not
 * the answer, it arrives before the answer, and rendering it produces text
 * that appears and is then replaced — which is exactly the bug this file was
 * written to kill.
 */

import { SYSTEM_PROMPT } from './prompt';
import { liveContext } from './context';
import { TOOL_DECLARATIONS, runTool } from './tools';

const BASE = import.meta.env.VITE_LLM_BASE?.trim() || '/nim/v1';
const MODEL = import.meta.env.VITE_LLM_MODEL?.trim() || 'z-ai/glm-5.2';

/**
 * Measured, not assumed: a free NIM key started returning 429 after five
 * requests inside a minute. So the budget is deliberately tight, and the
 * request-saving work matters here as much as it did on Gemini — the live
 * state block is what keeps a normal exchange inside this.
 */
const RPM = Number(import.meta.env.VITE_LLM_RPM ?? 8);
/** Leave one in hand: a 429 costs more than a short wait. */
const RESERVE = 1;

/** A model that keeps calling tools without ever answering is a bug, not a plan. */
const MAX_TOOL_ROUNDS = 4;
/** Turns of history kept. Long enough to hold a conversation, short enough to stay cheap. */
const MAX_HISTORY = 16;
/** Old tool results are re-sent on every request; past this many they are dropped. */
const KEEP_FULL_RESULTS = 6;

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolEvent = {
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export type SendCallbacks = {
  /** Fired per streamed chunk of the visible answer. Reasoning never appears here. */
  onText?: (delta: string) => void;
  /** Fired the first time the model starts reasoning, so the UI can say so. */
  onThinking?: () => void;
  /** Fired when the model decides to act, before the tool runs. */
  onTool?: (event: ToolEvent) => void;
  /** Fired after that tool returns. */
  onToolResult?: (event: ToolEvent) => void;
  /** Fired when the turn is stalled on a rate limit, so the UI can say so. */
  onWait?: (seconds: number) => void;
};

/** The key lives server-side now, so the browser cannot check it up front. */
export function agentConfigured(): boolean {
  return true;
}

/* ── Request budget ──────────────────────────────────────────────────── */

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

/* ── Session ─────────────────────────────────────────────────────────── */

export class AgentSession {
  private history: Message[] = [];

  clear() {
    this.history = [];
  }

  get turns(): number {
    return this.history.length;
  }

  /**
   * One user turn, start to finish: stream the answer, run whatever tools the
   * model asks for, feed the results back, repeat until it stops calling
   * tools. Resolves with the final visible text.
   */
  async send(message: string, callbacks: SendCallbacks = {}, signal?: AbortSignal): Promise<string> {
    this.history.push({ role: 'user', content: message });

    let answer = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { text, calls } = await this.stream(callbacks, signal);

      this.history.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });

      if (text) answer = text;
      if (!calls.length) break;

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // A malformed argument blob is the model's mistake to recover from,
          // not a reason to end the turn.
          args = {};
        }
        const event: ToolEvent = { name: call.function.name, args };
        callbacks.onTool?.(event);
        const result = runTool(call.function.name, args);
        callbacks.onToolResult?.({ ...event, result });
        this.history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    this.trim();
    return answer;
  }

  private async stream(callbacks: SendCallbacks, signal?: AbortSignal): Promise<StreamOutcome> {
    for (let attempt = 0; ; attempt++) {
      await claimSlot(callbacks.onWait, signal);
      const response = await this.post(signal);

      if (response.ok) return await consume(response, callbacks);

      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        const wait = (attempt + 1) * 6_000;
        callbacks.onWait?.(Math.ceil(wait / 1000));
        requestLog.push(Date.now());
        await sleep(wait, signal);
        continue;
      }
      throw new Error(await describeFailure(response));
    }
  }

  private post(signal?: AbortSignal): Promise<Response> {
    return fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          // Rebuilt every request, so the live state is never stale and never
          // accumulates in the history.
          { role: 'system', content: `${SYSTEM_PROMPT}\n\n${liveContext()}` },
          ...this.compact(),
        ],
        tools: TOOL_DECLARATIONS.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: 'auto',
        temperature: 0.6,
        top_p: 0.95,
        max_tokens: 1200,
        stream: true,
      }),
    });
  }

  /**
   * The history as it goes on the wire. Tool results are the biggest thing in
   * it and the least useful once acted on — the live state block already
   * carries anything still true — so older ones are replaced by a marker.
   */
  private compact(): Message[] {
    const cutoff = this.history.length - KEEP_FULL_RESULTS;
    return this.history.map((message, index) =>
      index < cutoff && message.role === 'tool'
        ? { ...message, content: '{"note":"earlier result — see the live state block"}' }
        : message,
    );
  }

  private trim() {
    if (this.history.length <= MAX_HISTORY) return;
    // Never start the kept window on a tool result: it would reference a call
    // the model can no longer see, and the API rejects that outright.
    let cut = this.history.length - MAX_HISTORY;
    while (cut < this.history.length && this.history[cut].role === 'tool') cut++;
    this.history = this.history.slice(cut);
  }
}

type StreamOutcome = { text: string; calls: ToolCall[] };

/**
 * Reads the SSE body. Visible text streams out as it lands; `reasoning_content`
 * is counted and discarded; tool calls arrive in fragments and are stitched
 * back together by index.
 */
async function consume(response: Response, callbacks: SendCallbacks): Promise<StreamOutcome> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The model returned an empty response body.');

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let announcedThinking = false;
  const partial: ToolCall[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf('\n');
    while (split !== -1) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      split = buffer.indexOf('\n');

      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.reasoning_content && !announcedThinking) {
        announcedThinking = true;
        callbacks.onThinking?.();
      }
      if (delta.content) {
        text += delta.content;
        callbacks.onText?.(delta.content);
      }
      for (const fragment of delta.tool_calls ?? []) {
        const at = fragment.index ?? 0;
        const slot = (partial[at] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (fragment.id) slot.id = fragment.id;
        if (fragment.function?.name) slot.function.name = fragment.function.name;
        if (fragment.function?.arguments) slot.function.arguments += fragment.function.arguments;
      }
    }
  }

  const calls = partial.filter((call) => call?.function.name);
  // An id is required to pair the result back; synthesise one if the stream
  // never sent it rather than dropping an otherwise good call.
  calls.forEach((call, index) => {
    if (!call.id) call.id = `call_${index}`;
  });
  return { text: text.trim(), calls };
}

type StreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
};

async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    /* the status alone will have to do */
  }
  if (response.status === 401 || response.status === 403) {
    return 'NVIDIA rejected the key. Check NIM_API_KEY in .env.local and restart the dev server.';
  }
  if (response.status === 404 && BASE.startsWith('/')) {
    return 'The /nim proxy is not running. Restart the dev server so vite.config.ts picks it up.';
  }
  if (response.status === 429) {
    return 'Rate limited. Wait a moment and try again.';
  }
  return `Model request failed (${response.status})${detail ? `: ${detail}` : ''}`;
}
