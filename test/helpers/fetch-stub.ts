import { vi } from 'vitest'

// Every outbound call in api.ts — OpenAI image generation/edit, the Anthropic Messages
// API, and the docs-page fetch behind /exports/schema-from-url — goes through global
// fetch. Stubbing it is what makes the LLM-backed routes testable: the interesting logic
// isn't the network call, it's what the handlers do with the response (pulling a JSON
// array out of prose, filtering hallucinated source fields, whitening and writing the
// image bytes, propagating the upstream error message).

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

type Handler = (call: RecordedCall) => Response | Promise<Response>

export interface FetchStub {
  calls: RecordedCall[]
  on(pattern: RegExp, handler: Handler): FetchStub
  callsTo(pattern: RegExp): RecordedCall[]
  restore(): void
}

export function installFetchStub(): FetchStub {
  const calls: RecordedCall[] = []
  const handlers: { pattern: RegExp; handler: Handler }[] = []

  const impl = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input)
    const rawBody = init?.body
    let body: any = rawBody
    if (typeof rawBody === 'string') { try { body = JSON.parse(rawBody) } catch { /* keep raw */ } }
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      // Lower-cased because header casing is the client's choice, not the app's — the SDK
      // sends `authorization` where the hand-rolled client sent `Authorization`, and no
      // assertion here is meant to be about which one a given client picked.
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body,
    }
    calls.push(call)
    const hit = handlers.find(h => h.pattern.test(url))
    if (!hit) throw new Error(`fetch stub: no handler for ${url}`)
    return hit.handler(call)
  }

  vi.stubGlobal('fetch', vi.fn(impl))

  const stub: FetchStub = {
    calls,
    on(pattern, handler) { handlers.push({ pattern, handler }); return stub },
    callsTo(pattern) { return calls.filter(c => pattern.test(c.url)) },
    restore() { vi.unstubAllGlobals() },
  }
  return stub
}

// ── Response builders ─────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// These envelopes are fuller than the fields api.ts actually reads, because the AI SDK
// validates every provider response against the vendor's documented schema before handing
// it over — a partial envelope fails as "Invalid JSON response" long before the handler
// sees it. Keeping them realistic is the point: a stub the real client would reject isn't
// testing the real path.

/** A successful Anthropic Messages response carrying one text block. */
export function anthropicText(text: string): Response {
  return jsonResponse({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-stub',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** Anthropic's error envelope — api.ts surfaces error.message verbatim. */
export function anthropicError(message: string, status = 400): Response {
  return jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message } }, status)
}

/** A successful images/generations (or /edits) response returning inline base64. */
export function openaiImage(pngBytes: Buffer): Response {
  return jsonResponse({ created: 1, data: [{ b64_json: pngBytes.toString('base64') }] })
}

/** The url-instead-of-b64 variant. */
export function openaiImageUrl(url: string): Response {
  return jsonResponse({ created: 1, data: [{ url }] })
}

export function openaiError(message: string, status = 400): Response {
  return jsonResponse({ error: { message } }, status)
}

/**
 * A Responses API reply (`/v1/responses`) — what a text call to OpenAI *directly* uses.
 * The SDK's OpenAI provider defaults to Responses, not chat completions, so this is the
 * shape that route needs; the aggregators speak chat completions instead (`openaiChat`).
 */
export function openaiResponses(text: string): Response {
  return jsonResponse({
    id: 'resp_stub',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'stub',
    output: [{
      type: 'message',
      id: 'msg_stub',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  })
}

/**
 * A chat-completions response — what the aggregator routes (OpenRouter, and any
 * OpenAI-compatible proxy) answer with, whichever vendor's model is behind them. Text
 * calls on those routes come back in this shape rather than Anthropic's block form.
 */
export function openaiChat(text: string): Response {
  return jsonResponse({
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 1,
    model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

// ── Request readers ───────────────────────────────────────────────────────────
// The SDK sends Anthropic's block form — `system` is an array of text blocks and each
// message's `content` is an array of parts, rather than the bare strings the hand-rolled
// client used to send. Same text either way; these unwrap it so the assertions can stay
// about the prompt content rather than about the envelope carrying it.

function blockText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(b => (typeof b === 'string' ? b : b?.text ?? '')).join('')
  return value?.text ?? ''
}

/** The system prompt sent on a recorded Anthropic call. */
export function sentSystem(call: RecordedCall): string {
  return blockText(call.body?.system)
}

/** The nth user message sent on a recorded Anthropic call (defaults to the first). */
export function sentMessage(call: RecordedCall, index = 0): string {
  return blockText(call.body?.messages?.[index]?.content)
}

export function htmlPage(html: string): Response {
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
}
