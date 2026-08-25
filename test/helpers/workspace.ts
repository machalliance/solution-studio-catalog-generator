import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

// Both src modules read their data paths once, at module scope, off APP_ROOT /
// CONFIG_PATH / SITES_PATH. So a workspace has to be created — and the env set —
// *before* the module under test is imported for the first time. Every test file
// therefore starts with `const ws = createWorkspace()` at top level, then awaits its
// dynamic import(). vitest's per-file fork keeps the two from colliding.

export interface Workspace {
  root: string
  catalog: string
  images: string
  backups: string
  exports: string
  configPath: string
  sitesPath: string
}

export function createWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'catgen-test-'))
  const ws: Workspace = {
    root,
    catalog:    join(root, 'data/catalog'),
    images:     join(root, 'data/images'),
    backups:    join(root, 'data/backups'),
    exports:    join(root, 'data/exports'),
    configPath: join(root, 'config.json'),
    sitesPath:  join(root, 'sites.json'),
  }
  for (const d of [ws.catalog, ws.images, ws.backups, ws.exports]) mkdirSync(d, { recursive: true })

  process.env.APP_ROOT    = root
  process.env.CONFIG_PATH = ws.configPath
  process.env.SITES_PATH  = ws.sitesPath
  // Let everything hang off APP_ROOT so the backup tar (which is APP_ROOT-relative by
  // design) and the route handlers agree on where the catalog is.
  delete process.env.CATALOG_PATH
  delete process.env.IMAGES_PATH
  // No key => the LLM helpers throw before reaching fetch. Tests that exercise those
  // routes set a dummy key themselves alongside a stubbed fetch (see stubFetch).
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.STUDIO_API_TOKEN
  process.env.SKIP_LISTEN = '1'

  return ws
}

export function destroyWorkspace(ws: Workspace) {
  rmSync(ws.root, { recursive: true, force: true })
}

// ── Fixture authoring ─────────────────────────────────────────────────────────

export interface SeedSite {
  id: string
  label?: string
  categories: string[]
  basePrompt?: string
}

export function writeSites(ws: Workspace, sites: SeedSite[]) {
  writeFileSync(ws.sitesPath, JSON.stringify(
    sites.map(s => ({
      id: s.id,
      label: s.label ?? s.id,
      categories: s.categories,
      basePrompt: s.basePrompt ?? 'a photo of {item}',
    })),
    null, 2,
  ))
}

export function readSites(ws: Workspace): any[] {
  return JSON.parse(readFileSync(ws.sitesPath, 'utf-8'))
}

/**
 * Seeds config.json — the provider route and model IDs are read from it on every call, so
 * this is how a test picks which route the model calls take. Written whole, not merged:
 * config.json outlives the per-test reset, and a leftover key from an earlier test picking
 * a different route is exactly the kind of cross-test bleed that's hard to see later.
 */
export function writeConfig(ws: Workspace, config: Record<string, any>) {
  writeFileSync(ws.configPath, JSON.stringify(config, null, 2))
}

export function clearConfig(ws: Workspace) {
  rmSync(ws.configPath, { force: true })
}

let itemSeq = 0

// A complete catalog item — every field enrich()/the export mapper expects — with
// only the interesting bits per-test overridable.
export function item(overrides: Record<string, any> = {}): Record<string, any> {
  const n = ++itemSeq
  return {
    objectID: `thing-${String(n).padStart(3, '0')}`,
    name: `Thing ${n}`,
    brand: 'Acme',
    price: 42,
    currency: 'USD',
    category: 'thing',
    style: 'smart-casual',
    fit: 'unisex',
    colourFamily: 'neutral',
    colourHex: '#888888',
    tags: ['slim', 'premium'],
    images: [],
    url: '/products/thing',
    inStock: true,
    description: 'A thing.',
    ...overrides,
  }
}

function fixture(hits: Record<string, any>[]) {
  return {
    hits, nbHits: hits.length, page: 0, nbPages: 1,
    hitsPerPage: 20, processingTimeMS: 1, query: '',
  }
}

// Writes a fixture at an explicit filename — tests that care about the legacy-vs-
// site-prefixed naming rule need to control the filename directly, not go through
// fixtureFilename().
export function writeFixtureFile(ws: Workspace, filename: string, hits: Record<string, any>[]) {
  writeFileSync(join(ws.catalog, filename), JSON.stringify(fixture(hits), null, 2))
}

export function readFixtureFile(ws: Workspace, filename: string): any {
  return JSON.parse(readFileSync(join(ws.catalog, filename), 'utf-8'))
}

export function catalogFiles(ws: Workspace): string[] {
  return existsSync(ws.catalog) ? readdirSync(ws.catalog).sort() : []
}

export function writeManifest(ws: Workspace, objectIDs: string[]) {
  writeFileSync(join(ws.images, 'generated.json'), JSON.stringify(objectIDs, null, 2))
}

export function readManifest(ws: Workspace): string[] {
  const p = join(ws.images, 'generated.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []
}

// ── Images ────────────────────────────────────────────────────────────────────

// A solid-colour PNG, used wherever a route only needs *some* real image bytes on
// disk (tweak accept/discard, zip bundling, the /images/:filename route).
export async function pngBuffer(
  width = 8, height = 8, rgb: [number, number, number] = [255, 255, 255],
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  }).png().toBuffer()
}

export async function writeImage(ws: Workspace, filename: string, buf?: Buffer) {
  writeFileSync(join(ws.images, filename), buf ?? await pngBuffer())
}

export function imageExists(ws: Workspace, filename: string): boolean {
  return existsSync(join(ws.images, filename))
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

// Hono's app.request() drives a route in-process — no port, no server. It builds the
// Request straight from a URL, which means no Host header is set; a real HTTP/1.1 client
// always sends one, and server.ts's same-origin check needs Host and Origin to compare.
// So both are set here, matching, and the middleware tests override them deliberately.
const SAME_ORIGIN = { Host: 'localhost', Origin: 'http://localhost' }

export function json(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...SAME_ORIGIN,
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify(body),
  }
}

export function noBody(method: string, init: RequestInit = {}): RequestInit {
  return {
    method,
    ...init,
    headers: { ...SAME_ORIGIN, ...(init.headers as Record<string, string> | undefined) },
  }
}

/** A GET with the same-origin headers set — for routes behind the CSRF middleware. */
function get(init: RequestInit = {}): RequestInit {
  return noBody('GET', init)
}
