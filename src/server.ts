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

// ── App ────────────────────────────────────────────────────────────────────────
const app = new Hono()

// Catch anything a route handler throws (bad JSON body, unexpected file I/O error, etc.)
// and return it in the same {error} shape every route already uses, instead of Hono's
// bare non-JSON 500 — which would otherwise break every frontend fetch(...).json() call.
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message || 'Internal error' }, 500)
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

// Management API — all tools API routes (auth not required for internal use)
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
