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
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
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

/** A successful Anthropic Messages response carrying one text block. */
export function anthropicText(text: string): Response {
  return jsonResponse({ content: [{ type: 'text', text }] })
}

/** Anthropic's error envelope — api.ts surfaces error.message verbatim. */
export function anthropicError(message: string, status = 400): Response {
  return jsonResponse({ error: { message } }, status)
}

/** A successful images/generations (or /edits) response returning inline base64. */
export function openaiImage(pngBytes: Buffer): Response {
  return jsonResponse({ data: [{ b64_json: pngBytes.toString('base64') }] })
}

/** The url-instead-of-b64 variant — api.ts fetches the URL as a second hop. */
export function openaiImageUrl(url: string): Response {
  return jsonResponse({ data: [{ url }] })
}

export function openaiError(message: string, status = 400): Response {
  return jsonResponse({ error: { message } }, status)
}

export function htmlPage(html: string): Response {
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
}
