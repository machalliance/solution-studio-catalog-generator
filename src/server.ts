import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageGenRoutes, catalogRoutes } from './products/api.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '../')
const DATA_DIR  = join(ROOT, 'data')
const IMAGES    = join(DATA_DIR, 'images')
const UI_HTML   = join(__dirname, 'products/ui.html')

// Ensure backups/exports dirs exist (catalog and images are volume-mounted)
;['backups', 'exports'].forEach(d => {
  const p = join(DATA_DIR, d)
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
})

// ── Auth middleware (optional STUDIO_API_TOKEN) ────────────────────────────────
const TOKEN = process.env.STUDIO_API_TOKEN

function requireAuth(req: Request): Response | null {
  if (!TOKEN) return null
  const auth = req.headers.get('authorization') ?? ''
  if (auth === `Bearer ${TOKEN}`) return null
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── CSRF ───────────────────────────────────────────────────────────────────────
// /api/* is unauthenticated on purpose — it's the local UI's own backend. That makes
// it a CSRF target: c.req.json() parses the body whatever the Content-Type is, so a
// cross-origin form/fetch with text/plain is a "simple" request that skips preflight
// entirely and would otherwise be processed. Every state-changing call therefore has
// to prove it came from this origin. Same-origin browser requests always send Origin
// on writes; non-browser callers (curl, the Greeter adapter) send none at all, and a
// missing header is allowed — only a header naming a *different* origin is rejected.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function requireSameOrigin(c: any): Response | null {
  if (SAFE_METHODS.has(c.req.method)) return null
  const origin = c.req.header('origin')
  if (!origin) return null
  const host = c.req.header('host')
  let originHost: string
  try { originHost = new URL(origin).host } catch { originHost = '' }
  if (host && originHost === host) return null
  return c.json({ error: 'Cross-origin request rejected' }, 403)
}

// ── App ────────────────────────────────────────────────────────────────────────
const app = new Hono()

// Catch anything a route handler throws (bad JSON body, unexpected file I/O error, etc.)
// and return it in the same {error} shape every route already uses, instead of Hono's
// bare non-JSON 500 — which would otherwise break every frontend fetch(...).json() call.
// The message itself stays server-side: an unhandled throw here is by definition not
// one a route wrote for the UI to display, so it's as likely to be a filesystem path
// or an upstream API's internal detail as anything useful. Routes that have something
// meaningful to say still return their own {error} text from their own catch blocks.
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal error' }, 500)
})

// Health
app.get('/health', c => c.json({ ok: true, ts: new Date().toISOString() }))

// Images — serve from data/images/
app.get('/images/:filename', c => {
  const filename = c.req.param('filename')
  if (!filename || filename.includes('..')) return c.text('Not found', 404)
  const p = join(IMAGES, filename)
  if (!existsSync(p)) return c.text('Not found', 404)
  const buf = readFileSync(p)
  const ext = filename.split('.').pop()?.toLowerCase()
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
  return new Response(buf, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' } })
})

// Management API — all tools API routes. No bearer token (the UI has none to send);
// reachability is what protects it: loopback-only publishing in docker-compose.yml
// plus the same-origin check below, which is what stops a page the user happens to
// have open from driving these routes on their behalf.
app.use('/api/*', async (c, next) => {
  const err = requireSameOrigin(c)
  if (err) return err
  await next()
})
app.route('/api', imageGenRoutes)

// Catalog REST API — gated by bearer token for remote consumers
app.use('/catalog/*', async (c, next) => {
  const err = requireAuth(c.req.raw)
  if (err) return err
  await next()
})
app.route('/catalog', catalogRoutes)

// UI
app.get('/', c => {
  if (!existsSync(UI_HTML)) return c.text('ui.html not found', 404)
  const html = readFileSync(UI_HTML, 'utf-8')
  return c.html(html)
})

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3004', 10)
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Product Catalog Generator running → http://localhost:${PORT}`)
})
