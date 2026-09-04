import { Hono } from 'hono'
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, statSync, unlinkSync, renameSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lookup } from 'node:dns/promises'
import archiver from 'archiver'
import sharp from 'sharp'
import { generateText, generateImage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGateway } from '@ai-sdk/gateway'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
// APP_ROOT is the directory every default data path hangs off, and the base the backup
// tarball is created relative to (so entries stay recorded as "data/catalog/..." — the
// paths existing snapshots already use and /backups/:filename/restore extracts back to).
// It's overridable purely so a test run can point the whole module at a temp directory;
// nothing in normal operation sets it.
const ROOT     = process.env.APP_ROOT      || join(__dirname, '../../')
const CATALOG  = process.env.CATALOG_PATH  || join(ROOT, 'data/catalog')
const IMAGES   = process.env.IMAGES_PATH   || join(ROOT, 'data/images')
const CONFIG   = process.env.CONFIG_PATH   || join(__dirname, 'config.json')
const SITES    = process.env.SITES_PATH    || join(__dirname, 'sites.json')
const MANIFEST = join(IMAGES, 'generated.json')
const BACKUPS  = join(ROOT, 'data/backups')
const EXPORTS  = join(ROOT, 'data/exports')

// Seed values only — used the first time sites.json doesn't exist yet. After that,
// sites (aka "skins") and their categories live entirely in sites.json so new
// verticals can be added at runtime without a code change.
const SEED_CLOTHING_CATS = ['jacket', 'top', 'pants', 'shoes', 'belt', 'socks', 'dress', 'scarf']
const SEED_HOME_CATS     = ['vanity', 'faucet', 'mirror', 'lighting', 'tile', 'hardware']
const GENERIC_BASE_PROMPT = 'create a product image for a retail website, must have white background, the product only, no text, no person or hands, the product displayed straight-on and perfectly centered against a plain white surface, fully visible, 1:1 aspect ratio / a square. the product is: {item}'

interface SiteDef {
  id: string
  label: string
  categories: string[]
  basePrompt: string
}

function loadSites(): SiteDef[] {
  try { return JSON.parse(readFileSync(SITES, 'utf-8')) }
  catch {
    const cfg = loadConfig()
    return [
      { id: 'clothing', label: 'Clothing', categories: [...SEED_CLOTHING_CATS], basePrompt: cfg.basePromptClothing },
      { id: 'home', label: 'Home', categories: [...SEED_HOME_CATS], basePrompt: cfg.basePromptHome },
    ]
  }
}

function saveSites(sites: SiteDef[]) {
  writeFileSync(SITES, JSON.stringify(sites, null, 2))
}

function getSiteBasePrompt(siteId: string): string {
  return loadSites().find(s => s.id === siteId)?.basePrompt ?? ''
}

// Category names are unique per-site, not globally — two sites can each have their own
// "pants" with independent data. As long as a name is owned by 0 or 1 sites it keeps the
// legacy flat filename (algolia-<category>.json, unchanged since before site-scoping
// existed, so the shared catalog directory needs no migration for the common case). Only
// once 2+ sites genuinely share a name does it move to algolia-<site>-<category>.json —
// see the /sites/:siteId/categories route for the one-time migration this triggers.
function sitesSharingCategory(category: string, sites: SiteDef[]): SiteDef[] {
  return sites.filter(s => s.categories.includes(category))
}

function fixtureFilename(siteId: string, category: string, sites?: SiteDef[]): string {
  const sharers = sitesSharingCategory(category, sites ?? loadSites())
  return sharers.length > 1 ? `algolia-${siteId}-${category}.json` : `algolia-${category}.json`
}

// Mirrors the forward migration in the add-category route, in reverse: whenever removing a
// category or a whole site can drop a name from 2+ sharers down to exactly 1, the remaining
// owner's fixture must move back from the site-prefixed filename to the legacy plain one —
// otherwise fixtureFilename() (recomputed fresh from current sharer count on every call)
// starts pointing at a plain filename that doesn't exist, orphaning that owner's data.
function demigrateIfNoLongerColliding(category: string, sitesAfter: SiteDef[]) {
  const sharers = sitesSharingCategory(category, sitesAfter)
  if (sharers.length !== 1) return
  const owner = sharers[0]
  const prefixed = join(CATALOG, `algolia-${owner.id}-${category}.json`)
  const plain = join(CATALOG, `algolia-${category}.json`)
  if (existsSync(prefixed) && !existsSync(plain)) renameSync(prefixed, plain)
}

// Next objectID for a category name: <cat>-<n>, one past the highest existing suffix
// found across every fixture that could hold this name — every site that shares it, so
// objectID stays globally unique even when the data itself lives in separate per-site files.
function nextObjectID(category: string): string {
  const sites = loadSites()
  const sharers = sitesSharingCategory(category, sites)
  const siteIds = sharers.length
    ? sharers.map(s => s.id)
    : [sites[sites.length - 1]?.id ?? 'home']
  let maxNum = 0
  for (const siteId of siteIds) {
    for (const h of loadFixture(siteId, category)?.hits ?? []) {
      const n = parseInt((h.objectID as string).split('-')[1] ?? '0', 10)
      if (!isNaN(n)) maxNum = Math.max(maxNum, n)
    }
  }
  return `${category}-${String(maxNum + 1).padStart(3, '0')}`
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// Accepts either an array of tags or a comma-separated string
function parseTagList(val: unknown): string[] {
  if (Array.isArray(val)) return val
  return String(val ?? '').split(',').map(t => t.trim()).filter(Boolean)
}

// The `style` field (distinct from descriptive tags) is deliberately just these two values
// for now — anything else collapses to the 'smart-casual' default rather than being
// rejected, since this is set from several places (manual UI, AI batch generation) that
// shouldn't 400 the whole request over a stray value.
const VALID_STYLES = new Set(['casual', 'smart-casual'])
function normalizeStyle(val: unknown): string {
  return VALID_STYLES.has(String(val)) ? String(val) : 'smart-casual'
}

// Every (site, category) pair that could have a fixture — every site's registered
// categories, plus any on-disk fixture not accounted for by a site (hand-added files),
// attributed to the fallback site the same way unregistered categories always have been.
function getAllCatRefs(): { site: string; category: string }[] {
  const sites = loadSites()
  const refs = sites.flatMap(s => s.categories.map(category => ({ site: s.id, category })))
  const accountedFiles = new Set(refs.map(r => fixtureFilename(r.site, r.category, sites)))
  const fromDisk = existsSync(CATALOG)
    ? readdirSync(CATALOG)
        .filter(f => f.startsWith('algolia-') && f.endsWith('.json') && !accountedFiles.has(f))
    : []
  const fallbackSite = sites[sites.length - 1]?.id ?? 'home'
  for (const f of fromDisk) {
    refs.push({ site: fallbackSite, category: f.replace(/^algolia-/, '').replace(/\.json$/, '') })
  }
  return refs
}

function getAllCats(): string[] {
  return [...new Set(getAllCatRefs().map(r => r.category))]
}


const DEFAULTS = {
  basePromptClothing: 'create an image for a clothing shopping website PDP page for the following product, must have white background, the product only, no text, no person, the product is laying flat on a white surface and it perfectly aligned and fully visible, 1:1 aspect ratio / a square. the product is: {item}',
  basePromptHome: 'create a product image for a home improvement retail website, must have white background, the product only, no text, no person or hands, the product displayed straight-on and perfectly centered against a plain white surface, fully visible, 1:1 aspect ratio / a square. the product is: {item}',
  // Which route the model calls take (see PROVIDER_ROUTES) and which models to ask for.
  // All three model IDs are "<provider>/<name>" — the form the aggregators already use, and
  // the form the direct route splits on. Endpoints and keys are NOT here; see resolveRoute().
  provider: 'direct',
  textModel: 'anthropic/claude-opus-5',
  textModelFast: 'anthropic/claude-haiku-4-5',
  imageModel: 'openai/gpt-image-1',
  landingDemoMode: false,
}

const SKIP_TAGS = new Set([
  'smart-casual', 'premium', 'versatile', 'elevated', 'statement', 'classic', 'clean',
  'elegant', 'minimal', 'minimalist', 'modern', 'relaxed-smart', 'danish', 'denim',
])

const IMAGE_SKIP_TAGS = new Set([
  'smart-casual', 'business-casual', 'casual', 'weekend', 'evening', 'summer',
  'layering', 'layerable', 'versatile', 'elevated', 'premium', 'statement',
  'relaxed-smart', 'earthy', 'neutral', 'warm', 'cool', 'airy', 'crisp', 'rich',
  'flattering', 'lightweight', 'delicate', 'feminine', 'coastal', 'artisan',
])

const CLOTHING_FORM = new Set([
  'skinny', 'slim', 'super-skinny', 'straight', 'regular', 'relaxed', 'tapered',
  'wide-leg', 'bootcut', 'flared', 'cropped', 'oversized', 'boxy', 'fitted',
  'loose', 'baggy', 'longline', 'barrel-leg', 'cigarette', 'flowy', 'tailored',
  'unstructured', 'structured', 'jogger', 'balloon', 'parachute', 'hammer',
  'slim-straight', 'slim-taper', 'straight-leg', 'relaxed-straight', 'roomy',
  'high-rise', 'low-rise', 'mid-rise', 'pleated', 'flat-front',
  'midi', 'maxi', 'mini', 'wrap', 'slip', 'shirt-dress', 'cami', 'tank',
  'sleeveless', 'crewneck', 'mock-neck', 'button-down', 'polo', 'wrap-top',
  'overshirt', 'harrington', 'bomber', 'field-jacket', 'sport-coat', 'utility',
  'chelsea', 'ballet', 'derby', 'loafer', 'penny-loafer', 'oxford', 'mule',
  'sandal', 'slingback', 'ankle-boot', 'boot',
  'block-heel', 'kitten-heel', 'pointed-toe', 'cap-toe', 'flat', 'heeled',
  'ankle-strap', 'strappy',
])

const HOME_FORM = new Set([
  'floating', 'freestanding', 'wall-mount', 'recessed', 'flush-mount', 'vessel',
  'undermount', 'drop-in', 'widespread', 'single-hole',
  'shaker', 'beadboard', 'farmhouse', 'modern', 'minimalist', 'minimal',
  'classic', 'vintage-inspired', 'cottage', 'open-shelf', 'two-door',
  'round', 'rectangular', 'arch', 'porthole', 'frameless', 'medicine-cabinet',
  'hexagon', 'subway', 'mosaic', 'geometric', 'large-format', 'plank', 'zellige',
  'sconce', 'vanity-bar', 'pendant',
  'high-arc', 'waterfall', 'cross-handle',
  'matte-black', 'brushed-nickel', 'brushed-brass', 'chrome', 'antique-brass',
  'matte', 'gloss', 'honed',
  'towel-bar', 'towel-hook', 'robe-hook', 'cabinet-pull', 'bin-pull',
])

// ── Data helpers ──────────────────────────────────────────────────────────────

function loadManifest(): Set<string> {
  try { return new Set(JSON.parse(readFileSync(MANIFEST, 'utf-8'))) }
  catch { return new Set() }
}

function addToManifest(objectID: string) {
  const set = loadManifest()
  set.add(objectID)
  if (!existsSync(IMAGES)) mkdirSync(IMAGES, { recursive: true })
  writeFileSync(MANIFEST, JSON.stringify([...set], null, 2))
}

function loadConfig() {
  let stored: Record<string, any> = {}
  try { stored = JSON.parse(readFileSync(CONFIG, 'utf-8')) } catch { /* first run / unreadable → defaults */ }
  // Pre-provider config.json files carry a bare `model` holding an unqualified OpenAI image
  // model ("gpt-image-1"). Read it forward into the qualified `imageModel` so an existing
  // install keeps generating with the model its owner picked, instead of silently snapping
  // back to the default. Migrated in memory only — the old key is dropped on the next write.
  if (stored.model && !stored.imageModel) {
    stored.imageModel = String(stored.model).includes('/') ? stored.model : `openai/${stored.model}`
  }
  delete stored.model
  return { ...DEFAULTS, ...stored }
}

function saveConfig(patch: Record<string, string>) {
  const next = { ...loadConfig(), ...patch }
  writeFileSync(CONFIG, JSON.stringify(next, null, 2))
  return next
}

// Parses a price value. Returns 0 if absent, the parsed number if valid, or null if the
// caller sent something non-numeric — callers should 400 on null rather than silently
// storing NaN (which JSON.stringify would then serialize as null, corrupting the item).
function parsePrice(val: unknown): number | null {
  if (val === undefined || val === null || val === '') return 0
  const n = typeof val === 'number' ? val : parseFloat(String(val))
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Fields every fixture item is expected to have; [key: string] tolerates
// category-specific extras (e.g. "finish") without fighting real catalog variation.
interface CatalogItem {
  objectID: string
  name: string
  brand: string
  price: number
  currency: string
  category: string
  style: string
  fit: string
  colourFamily: string
  colourHex: string
  tags: string[]
  images: string[]
  url: string
  inStock: boolean
  description: string
  imagePrompt?: string  // absent on freshly-created items — enrich() synthesizes one via autoPrompt()
  [key: string]: any
}

interface CatalogFixture {
  hits: CatalogItem[]
  nbHits: number
  page: number
  nbPages: number
  hitsPerPage: number
  processingTimeMS: number
  query: string
}

function emptyFixture(): CatalogFixture {
  return { hits: [], nbHits: 0, page: 0, nbPages: 1, hitsPerPage: 20, processingTimeMS: 1, query: '' }
}

function autoPrompt(item: CatalogItem): string {
  const tags = (item.tags ?? []).filter((t: string) => !SKIP_TAGS.has(t)).slice(0, 3)
  let desc = item.name
  if (item.fit === 'mens') desc += ' for men'
  else if (item.fit === 'womens') desc += ' for women'
  if (tags.length) desc += `, ${tags.join(', ')}`
  return desc
}

function loadFixture(siteId: string, category: string): CatalogFixture | null {
  const f = join(CATALOG, fixtureFilename(siteId, category))
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf-8')) }
  catch { return null } // a corrupted fixture shouldn't take down every route that reads the catalog
}

function saveFixture(siteId: string, category: string, data: any) {
  if (!existsSync(CATALOG)) mkdirSync(CATALOG, { recursive: true })
  writeFileSync(join(CATALOG, fixtureFilename(siteId, category)), JSON.stringify(data, null, 2))
}

interface EnrichedItem extends CatalogItem {
  hasCustomPrompt: boolean
  hasImage: boolean
  isAIGenerated: boolean
  isExternalImage: boolean
  imageUrl: string
}

// images[0] is the single source of truth for an item's image — whatever's stored there is
// what's shown, full stop, no disk existence-checking or URL-scheme guessing. /generate and
// /items/batch's pending-image rename both write the real "/images/<objectID>.jpg" the
// moment a file actually exists. An item can still end up with images[0] pointing somewhere
// that doesn't match that convention (hand-edited fixture data, e.g.) — isAIGenerated
// requires the value to still match our own naming convention AND be in the manifest, so
// those cases correctly stop claiming "generated" even if an old local file still exists.
function enrich(item: CatalogItem, manifest: Set<string>): EnrichedItem {
  const firstImage = Array.isArray(item.images) ? item.images[0] : item.images
  const hasImage = typeof firstImage === 'string' && firstImage.length > 0
  const ownFilename = `${item.objectID}.jpg`
  const matchesOwnFile = hasImage && (firstImage === ownFilename || firstImage!.endsWith(`/${ownFilename}`))
  return {
    ...item,
    hasCustomPrompt: !!item.imagePrompt,
    imagePrompt:     item.imagePrompt ?? autoPrompt(item),
    hasImage,
    isAIGenerated:   matchesOwnFile && manifest.has(item.objectID),
    isExternalImage: hasImage && !matchesOwnFile,
    imageUrl:        hasImage ? firstImage! : '',
  }
}

function getAllItems() {
  const manifest = loadManifest()
  return getAllCatRefs().flatMap(({ site, category }) => {
    const data = loadFixture(site, category)
    if (!data) return []
    return [{ skin: site, category, items: (data.hits as any[]).map(i => enrich(i, manifest)) }]
  })
}

function findItem(objectID: string) {
  for (const { site, category } of getAllCatRefs()) {
    const data = loadFixture(site, category)
    if (!data) continue
    const item = (data.hits as any[]).find(h => h.objectID === objectID)
    if (item) return { site, cat: category, data, item }
  }
  return null
}

// Finds an item, applies `mutator` to it in place, and persists the change.
// Returns the mutated item, or null if objectID doesn't exist — callers 404 on null.
function updateItem(objectID: string, mutator: (item: any) => void): any | null {
  const found = findItem(objectID)
  if (!found) return null
  const idx = (found.data.hits as any[]).findIndex((h: any) => h.objectID === objectID)
  mutator(found.data.hits[idx])
  saveFixture(found.site, found.cat, found.data)
  return found.data.hits[idx]
}

// ── AI providers ──────────────────────────────────────────────────────────────
// Every model call in this file goes through the Vercel AI SDK, and every one of them
// resolves its model the same way: config.json says *which* model ("<provider>/<name>")
// and *which route* to reach it by; the environment says *where* that route lives and
// with what credentials. Nothing below ever hardcodes a hostname.
//
// The split is deliberate and is a security boundary, not a style choice. /api/config is
// unauthenticated by design (see the auth notes in server.ts), so anything reachable
// through it is settable by anyone who can reach the port. A model ID is inert. A base URL
// is not — pointing it at an attacker-controlled host would hand them the API key on the
// next call. So route *names* are config (validated against PROVIDER_ROUTES below, which
// is a closed set), while the URL each name resolves to and the keys are env-only.
//
// Adding a route means adding an entry here and nothing else: the settings endpoint, the
// validator, and the UI's dropdown are all generic over this object.
const PROVIDER_ROUTES = {
  // Straight at the vendors. The only route that splits the "<provider>/<name>" model ID —
  // the vendor APIs want the bare name — and so the only one whose prefix must be a vendor
  // this project knows how to construct.
  direct: {
    label: 'Direct (OpenAI + Anthropic)',
    keyVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  gateway: {
    label: 'Vercel AI Gateway',
    keyVars: ['AI_GATEWAY_API_KEY'],
  },
  openrouter: {
    label: 'OpenRouter',
    keyVars: ['OPENROUTER_API_KEY'],
  },
  // Anything speaking the OpenAI wire format — a self-hosted proxy, LiteLLM, an internal
  // gateway. LLM_BASE_URL is required because there is no sensible default to fall back to.
  compatible: {
    label: 'OpenAI-compatible endpoint',
    keyVars: ['LLM_API_KEY'],
  },
} as const

type ProviderRoute = keyof typeof PROVIDER_ROUTES

const PROVIDER_ROUTE_KEYS = Object.keys(PROVIDER_ROUTES) as ProviderRoute[]

function isProviderRoute(v: unknown): v is ProviderRoute {
  return typeof v === 'string' && (PROVIDER_ROUTE_KEYS as string[]).includes(v)
}

// A model ID is "<provider>/<name>" everywhere — "anthropic/claude-opus-5",
// "openai/gpt-image-1". The aggregators take that string verbatim; the direct route
// splits it. Enforced on write (POST /api/config) so a malformed ID is rejected at the
// point someone sets it rather than surfacing later as an opaque 404 from a vendor.
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i

function splitModelId(id: string): { vendor: string; name: string } {
  const slash = id.indexOf('/')
  if (slash < 1) throw new Error(`Model ID must be "<provider>/<name>" — got "${id}"`)
  return { vendor: id.slice(0, slash).toLowerCase(), name: id.slice(slash + 1) }
}

function requireKey(name: string): string {
  const key = process.env[name]
  if (!key) throw new Error(`${name} not set`)
  return key
}

// Providers are rebuilt whenever the resolved (route, model vendor) pair changes rather
// than being constructed once at module scope, because the route lives in config.json and
// is editable at runtime from Settings — a module-scope provider would keep serving the
// route that was current when the process started. Construction is cheap (no I/O, no
// connection); the SDK reads global fetch per call, which is also what lets the test
// suite's fetch stub intercept these.
function providerFor(route: ProviderRoute, vendor: string) {
  switch (route) {
    case 'direct':
      if (vendor === 'openai') {
        return createOpenAI({ apiKey: requireKey('OPENAI_API_KEY'), baseURL: process.env.OPENAI_BASE_URL })
      }
      if (vendor === 'anthropic') {
        return createAnthropic({ apiKey: requireKey('ANTHROPIC_API_KEY'), baseURL: process.env.ANTHROPIC_BASE_URL })
      }
      throw new Error(
        `The "direct" route only knows openai/* and anthropic/* models — got "${vendor}/…". ` +
        `Use the gateway, openrouter, or compatible route to reach other vendors.`,
      )
    case 'gateway':
      return createGateway({ apiKey: requireKey('AI_GATEWAY_API_KEY'), baseURL: process.env.AI_GATEWAY_BASE_URL })
    case 'openrouter':
      return createOpenRouter({ apiKey: requireKey('OPENROUTER_API_KEY'), baseURL: process.env.OPENROUTER_BASE_URL })
    case 'compatible': {
      const baseURL = process.env.LLM_BASE_URL
      if (!baseURL) throw new Error('LLM_BASE_URL not set — required by the "compatible" provider route')
      return createOpenAICompatible({ name: 'compatible', baseURL, apiKey: process.env.LLM_API_KEY })
    }
  }
}

// Resolves a config model ID to something generateText/generateImage can take. The direct
// route addresses the vendor's own model name; every aggregator wants the qualified ID.
function resolveModel(route: ProviderRoute, modelId: string, kind: 'language' | 'image') {
  const { vendor, name } = splitModelId(modelId)
  const provider: any = providerFor(route, vendor)
  const wireId = route === 'direct' ? name : modelId
  try {
    const model = kind === 'image' ? provider.imageModel?.(wireId) : provider.languageModel(wireId)
    if (!model) throw new Error(`The "${route}" route has no ${kind} model support`)
    return model
  } catch (err: any) {
    // The SDK's own miss here is "No such imageModel: <name>", which reads as a typo in
    // the model name when the real problem is usually the vendor: Anthropic publishes no
    // image models at all, so anthropic/* can carry every text call in this app and no
    // image call. This app is otherwise runnable against a single provider, and that is
    // the one combination where one isn't enough — so name the vendor and the way out.
    if (err?.name === 'AI_NoSuchModelError' || /No such \w+Model/.test(String(err?.message))) {
      throw new Error(
        `"${vendor}" has no ${kind} model "${name}" on the "${route}" route. ` +
        (kind === 'image' && vendor === 'anthropic'
          ? 'Anthropic does not offer image models — set the image model to an openai/* one, ' +
            'or use the gateway, openrouter, or compatible route.'
          : 'Check the model ID.'),
      )
    }
    throw err
  }
}

function activeRoute(): ProviderRoute {
  const route = loadConfig().provider
  if (!isProviderRoute(route)) throw new Error(`Unknown provider route "${route}"`)
  return route
}

// The SDK wraps upstream failures in its own error classes; the UI has always shown the
// provider's own message ("billing hard limit reached", "overloaded", "invalid model") and
// that is the only part worth reading, so dig it back out.
//
// Two layers to get through. A retryable status (429, 5xx) is retried transparently and
// the failures are then wrapped in a RetryError whose own message is "Failed after 3
// attempts. Last error: …" — useful in a log, noise in the UI — so unwrap to the last real
// error first. Then pull the provider's message out of that error's raw response body.
function providerErrorMessage(err: any): string {
  const cause = err?.lastError ?? err?.errors?.[err.errors.length - 1] ?? err
  const body = cause?.responseBody ?? cause?.data
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      const msg = parsed?.error?.message ?? parsed?.message
      if (msg) return String(msg)
    } catch { /* not JSON — fall through to the error's own message */ }
  }
  const nested = cause?.data?.error?.message ?? cause?.error?.message
  return String(nested ?? cause?.message ?? err?.message ?? 'Model call failed')
}

async function withProviderError<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (err: any) { throw new Error(providerErrorMessage(err)) }
}

// Generates a fresh image from a text prompt. Returns base64 — the caller whitens the
// background and writes the bytes, exactly as before this went through the SDK.
async function callImageModel(prompt: string, modelId: string): Promise<string> {
  const route = activeRoute()
  const { vendor, name } = splitModelId(modelId)
  // `quality` is OpenAI-specific and its accepted values differ per model: dall-e-3 takes
  // "standard", gpt-image-* take "medium", dall-e-2 takes none at all. Sent as a provider
  // option so a non-OpenAI model never receives it.
  const quality = name === 'dall-e-3' ? 'standard' : name.startsWith('dall-e') ? undefined : 'medium'
  const providerOptions = vendor === 'openai' && quality ? { openai: { quality } } : undefined
  const res = await withProviderError(() => generateImage({
    model: resolveModel(route, modelId, 'image'),
    prompt,
    n: 1,
    size: '1024x1024',
    providerOptions,
  }))
  if (!res.image?.base64) throw new Error('No image data returned')
  return res.image.base64
}

// Edits an existing image rather than generating a fresh one from the text prompt — used
// by the "Tweak" action. Passing `images` is what turns this into an edit: on the direct
// OpenAI route the SDK posts it to /v1/images/edits, on OpenRouter it becomes an
// input_references entry. Not every model supports editing (dall-e-3 is generation-only),
// so a model that can't will fail here with the provider's own message.
async function callImageEdit(imageBuffer: Buffer, prompt: string, modelId: string): Promise<string> {
  const route = activeRoute()
  const res = await withProviderError(() => generateImage({
    model: resolveModel(route, modelId, 'image'),
    prompt: { text: prompt, images: [imageBuffer] },
  }))
  if (!res.image?.base64) throw new Error('No image data returned')
  return res.image.base64
}

// Every generation prompt asks for a pure white background, but the model never renders
// exactly #ffffff — it's consistently off by a few units (e.g. #fefefe), no matter how
// explicit the prompt gets. Fixing this needs actual pixel correction, not more prompting.
//
// This is a tolerant flood-fill ("magic wand"), not a global threshold: a pixel joins the
// background region only if it's close to the *specific neighbor* that's pulling it in
// (LOCAL_STEP), not just close to pure white in absolute terms. A truly uniform background
// (even with a soft studio-lighting gradient across the frame) has near-zero pixel-to-pixel
// delta, so it passes easily; a product edge has at least some local jump even when the
// product itself is a light/white color with little shading against the background — e.g. a
// white ceramic countertop — so the fill stops there instead of leaking into it. ABSOLUTE_
// THRESHOLD is just an outer safety bound so a slow gradient walk can never wander into a
// genuinely different color.
const ABSOLUTE_THRESHOLD = 12 // max per-channel distance from pure white, ever
const LOCAL_STEP = 4          // max per-channel distance from the neighbor pulling this pixel in

async function whitenBackground(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const pixelAt = (p: number) => { const idx = p * channels; return [data[idx], data[idx + 1], data[idx + 2]] }
  const withinAbsolute = (p: number) => {
    const [r, g, b] = pixelAt(p)
    return (255 - r) <= ABSOLUTE_THRESHOLD && (255 - g) <= ABSOLUTE_THRESHOLD && (255 - b) <= ABSOLUTE_THRESHOLD
  }
  const closeToNeighbor = (p: number, fromP: number) => {
    const [r1, g1, b1] = pixelAt(p)
    const [r2, g2, b2] = pixelAt(fromP)
    return Math.abs(r1 - r2) <= LOCAL_STEP && Math.abs(g1 - g2) <= LOCAL_STEP && Math.abs(b1 - b2) <= LOCAL_STEP
  }

  // Two passes: first determine the full background region (reading only — comparisons
  // must always see the image's original values, never an already-whitened neighbor, or
  // the "close to neighbor" check would trivially pass once anything got set to 255), then
  // write pure white for exactly that region in a second pass.
  const included = new Uint8Array(width * height)
  const stack: number[] = []
  const trySeed = (x: number, y: number) => {
    const p = y * width + x
    if (!included[p] && withinAbsolute(p)) { included[p] = 1; stack.push(p) }
  }
  for (let x = 0; x < width; x++) { trySeed(x, 0); trySeed(x, height - 1) }
  for (let y = 0; y < height; y++) { trySeed(0, y); trySeed(width - 1, y) }

  while (stack.length) {
    const p = stack.pop()!
    const x = p % width
    const y = (p / width) | 0
    const tryExpand = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
      const np = ny * width + nx
      if (included[np]) return
      if (withinAbsolute(np) && closeToNeighbor(np, p)) { included[np] = 1; stack.push(np) }
    }
    tryExpand(x - 1, y); tryExpand(x + 1, y); tryExpand(x, y - 1); tryExpand(x, y + 1)
  }

  for (let p = 0; p < width * height; p++) {
    if (!included[p]) continue
    const idx = p * channels
    data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255
  }

  // PNG (lossless), not JPEG: the flood-fill creates a harder edge at the product boundary
  // than the original continuous-tone image had (background forced to exactly 255,255,255
  // right next to the product's original, still-slightly-varying pixels) — JPEG's block
  // compression turns that artificial sharp edge into visible ringing/speckle noise right
  // at the product outline. Written to the same "<objectID>.jpg" filename regardless (this
  // project already tolerated PNG bytes under a .jpg name before this function existed —
  // OpenAI's own response is PNG-encoded and was previously written through unmodified).
  return sharp(data, { raw: { width, height, channels: channels as 1 | 2 | 3 | 4 } }).png().toBuffer()
}

// The one text entry point. Defaults to the 'fast' model — the short, high-volume calls
// (image prompts, one-line descriptions) — with callers passing config.textModel explicitly
// when a call is worth the stronger model. Which vendor either ID names, and how it's
// reached, is entirely a matter of config; nothing here assumes Claude.
async function callText(userMessage: string, opts?: { system?: string; maxTokens?: number; model?: string }): Promise<string> {
  const route = activeRoute()
  const modelId = opts?.model ?? loadConfig().textModelFast
  const res = await withProviderError(() => generateText({
    model: resolveModel(route, modelId, 'language'),
    system: opts?.system ?? 'You write product image-generation prompts. Output one line only, no quotes, no explanation.',
    prompt: userMessage,
    maxOutputTokens: opts?.maxTokens ?? 120,
  }))
  return res.text.trim()
}

function enrichUserMessage(item: any, skin: string): string {
  const allTags = (item.tags ?? []) as string[]
  const visTags = allTags.filter(t => !IMAGE_SKIP_TAGS.has(t.toLowerCase()))
  if (skin === 'clothing') {
    const formTags = visTags.filter(t => CLOTHING_FORM.has(t.toLowerCase()))
    const restTags = visTags.filter(t => !CLOTHING_FORM.has(t.toLowerCase()))
    const fitRaw   = (item.fit ?? '').toLowerCase()
    const gender   = fitRaw === 'mens' ? "men's" : fitRaw === 'womens' ? "women's" : null
    const genderEx = gender ? ` ${gender}` : ''
    return [
      `Name: ${item.name}`,
      formTags.length ? `Silhouette/form: ${formTags.join(', ')}` : '',
      restTags.length  ? `Details: ${restTags.join(', ')}` : '',
      item.colour ? `Colour: ${item.colour}` : '',
      gender ? `Gender: ${gender}` : '',
      '',
      `Write one image-query line, 15–25 words. Format: [silhouette]${genderEx} [product type] in [colour] [material], [key visual details].${gender ? ` "${gender}" MUST appear verbatim.` : ''}`,
    ].filter(Boolean).join('\n')
  }
  const formTags = visTags.filter(t => HOME_FORM.has(t.toLowerCase()))
  const restTags = visTags.filter(t => !HOME_FORM.has(t.toLowerCase()))
  return [
    `Name: ${item.name}`,
    formTags.length ? `Form/style: ${formTags.join(', ')}` : '',
    restTags.length  ? `Details: ${restTags.join(', ')}` : '',
    item.colour ? `Colour/finish: ${item.colour}` : '',
    '',
    `Write one image-query line, 15–25 words. Lead with Form/style values.`,
  ].filter(Boolean).join('\n')
}

// ── Backup helpers ────────────────────────────────────────────────────────────

function safeFilename(name: string): boolean {
  return /^[a-z0-9._-]+\.tar\.gz$/.test(name)
}

// Strips anything but alphanumerics/hyphen/underscore from a client-supplied ID before
// it's interpolated into a filename, so a value like "../../etc/passwd" can't escape
// the images directory.
function sanitizeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '')
}

function listBackups() {
  if (!existsSync(BACKUPS)) return []
  return readdirSync(BACKUPS)
    .filter(f => f.endsWith('.tar.gz'))
    .map(f => {
      const st = statSync(join(BACKUPS, f))
      return { filename: f, size: st.size, created: st.mtime.toISOString() }
    })
    .sort((a, b) => b.created.localeCompare(a.created))
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const imageGenRoutes = new Hono()

imageGenRoutes.get('/config', c => c.json(loadConfig()))
imageGenRoutes.post('/config', async c => {
  const body = await c.req.json()
  // This route is unauthenticated (see the PROVIDER_ROUTES notes), so what it accepts is
  // the actual boundary on the model config. `provider` must name one of the closed set of
  // routes — never an arbitrary string, and never a URL — and model IDs must be well-formed
  // so a typo fails here rather than as an opaque error on the next billed call.
  if ('provider' in body && !isProviderRoute(body.provider)) {
    return c.json({ error: `provider must be one of: ${PROVIDER_ROUTE_KEYS.join(', ')}` }, 400)
  }
  for (const field of ['textModel', 'textModelFast', 'imageModel'] as const) {
    if (field in body && !MODEL_ID.test(String(body[field] ?? ''))) {
      return c.json({ error: `${field} must be a "<provider>/<name>" model ID` }, 400)
    }
  }
  return c.json({ ok: true, config: saveConfig(body) })
})
imageGenRoutes.get('/settings', c => {
  const config = loadConfig()
  return c.json({
    catalogPath:   CATALOG,
    imagesPath:    IMAGES,
    provider:      config.provider,
    textModel:     config.textModel,
    textModelFast: config.textModelFast,
    imageModel:    config.imageModel,
    // The routes and which env keys each one needs, so the UI can report a missing key for
    // whatever is actually selected instead of asking about OpenAI and Anthropic forever.
    // Only ever whether a key is present — never any part of its value.
    routes: PROVIDER_ROUTE_KEYS.map(key => ({
      key,
      label: PROVIDER_ROUTES[key].label,
      keys: Object.fromEntries(PROVIDER_ROUTES[key].keyVars.map(v => [v, !!process.env[v]])),
    })),
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    openaiKey:    !!process.env.OPENAI_API_KEY,
  })
})

// Sites (aka "skins") — top-level verticals like Clothing/Home, each owning a set of
// categories. Lets the catalog grow beyond the two demo verticals without a code change.
imageGenRoutes.get('/sites', c => c.json(loadSites()))
imageGenRoutes.post('/sites', async c => {
  const { label } = await c.req.json() as any
  const trimmed = String(label ?? '').trim()
  if (!trimmed) return c.json({ error: 'label required' }, 400)
  const id = slugify(trimmed)
  if (!id) return c.json({ error: 'invalid label' }, 400)
  const sites = loadSites()
  if (sites.some(s => s.id === id)) return c.json({ error: `Site "${id}" already exists` }, 400)
  const site: SiteDef = { id, label: trimmed, categories: [], basePrompt: GENERIC_BASE_PROMPT }
  sites.push(site)
  saveSites(sites)
  return c.json({ ok: true, site, sites }, 201)
})
imageGenRoutes.patch('/sites/:siteId', async c => {
  const siteId = c.req.param('siteId')
  const { basePrompt } = await c.req.json() as any
  if (basePrompt == null) return c.json({ error: 'basePrompt required' }, 400)
  const sites = loadSites()
  const site = sites.find(s => s.id === siteId)
  if (!site) return c.json({ error: 'Unknown site' }, 404)
  site.basePrompt = basePrompt
  saveSites(sites)
  return c.json({ ok: true, site })
})
imageGenRoutes.post('/sites/:siteId/categories', async c => {
  const siteId = c.req.param('siteId')
  const { name } = await c.req.json() as any
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return c.json({ error: 'name required' }, 400)
  const cat = slugify(trimmed)
  if (!cat) return c.json({ error: 'invalid category name' }, 400)
  const sites = loadSites()
  const site = sites.find(s => s.id === siteId)
  if (!site) return c.json({ error: 'Unknown site' }, 404)
  if (site.categories.includes(cat)) return c.json({ error: `"${cat}" is already a category on this site` }, 400)
  // A category name can independently exist on more than one site. The instant a second
  // site adopts a name, the sole existing owner's fixture — safely using the legacy
  // unprefixed filename until now — must move to the site-prefixed name so the two can't
  // collide. Every other, non-colliding category's file is untouched by this.
  const existingOwners = sitesSharingCategory(cat, sites)
  if (existingOwners.length === 1) {
    const owner = existingOwners[0]
    const legacy = join(CATALOG, `algolia-${cat}.json`)
    const prefixed = join(CATALOG, `algolia-${owner.id}-${cat}.json`)
    if (existsSync(legacy) && !existsSync(prefixed)) renameSync(legacy, prefixed)
  }
  site.categories.push(cat)
  saveSites(sites)
  return c.json({ ok: true, site, sites }, 201)
})
imageGenRoutes.delete('/sites/:siteId/categories/:cat', c => {
  const siteId = c.req.param('siteId')
  const cat = c.req.param('cat')
  const sites = loadSites()
  const site = sites.find(s => s.id === siteId)
  if (!site) return c.json({ error: 'Unknown site' }, 404)
  if (!site.categories.includes(cat)) return c.json({ error: 'Unknown category' }, 404)
  const hasItems = (loadFixture(siteId, cat)?.hits.length ?? 0) > 0
  if (hasItems) return c.json({ error: 'Cannot remove a category that has products — remove its products first' }, 400)
  const f = join(CATALOG, fixtureFilename(siteId, cat, sites))
  site.categories = site.categories.filter(c2 => c2 !== cat)
  if (existsSync(f)) unlinkSync(f)
  demigrateIfNoLongerColliding(cat, sites)
  saveSites(sites)
  return c.json({ ok: true, site, sites })
})
imageGenRoutes.delete('/sites/:siteId', c => {
  const siteId = c.req.param('siteId')
  const sites = loadSites()
  const site = sites.find(s => s.id === siteId)
  if (!site) return c.json({ error: 'Unknown site' }, 404)
  if (sites.length <= 1) return c.json({ error: 'At least one site must remain' }, 400)
  const hasItems = site.categories.some(cat => (loadFixture(siteId, cat)?.hits.length ?? 0) > 0)
  if (hasItems) return c.json({ error: 'Cannot remove a site that has products — remove its products first' }, 400)
  // Site had no products in any of its categories — safe to also drop the (empty) fixture
  // files so those category names don't linger as "extra" disk-only categories afterward.
  for (const cat of site.categories) {
    const f = join(CATALOG, fixtureFilename(siteId, cat, sites))
    if (existsSync(f)) unlinkSync(f)
  }
  const next = sites.filter(s => s.id !== siteId)
  for (const cat of site.categories) demigrateIfNoLongerColliding(cat, next)
  saveSites(next)
  return c.json({ ok: true, sites: next })
})

imageGenRoutes.get('/items', c => c.json(getAllItems()))

imageGenRoutes.get('/backups', c => c.json(listBackups()))
imageGenRoutes.post('/backups', async c => {
  if (!existsSync(BACKUPS)) mkdirSync(BACKUPS, { recursive: true })
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const label = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
  const filename = `products-${label}.tar.gz`
  const backupPath = join(BACKUPS, filename)
  try {
    await execFileAsync('tar', ['-czf', backupPath, '-C', ROOT, 'data/catalog', 'data/images'])
    const st = statSync(backupPath)
    return c.json({ ok: true, filename, size: st.size, created: st.mtime.toISOString() })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
imageGenRoutes.post('/backups/:filename/restore', async c => {
  const filename = c.req.param('filename')
  if (!safeFilename(filename)) return c.json({ error: 'Invalid filename' }, 400)
  const backupPath = join(BACKUPS, filename)
  if (!existsSync(backupPath)) return c.json({ error: 'Not found' }, 404)
  try {
    // --no-same-owner/--no-same-permissions: a snapshot is a plain file in a bind-mounted
    // directory, so it isn't necessarily one this app wrote — don't let its recorded
    // ownership or mode bits carry into the extracted files.
    await execFileAsync('tar', ['-xzf', backupPath, '-C', ROOT, '--no-same-owner', '--no-same-permissions'])
    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
imageGenRoutes.delete('/backups/:filename', c => {
  const filename = c.req.param('filename')
  if (!safeFilename(filename)) return c.json({ error: 'Invalid filename' }, 400)
  const backupPath = join(BACKUPS, filename)
  if (!existsSync(backupPath)) return c.json({ error: 'Not found' }, 404)
  try { unlinkSync(backupPath); return c.json({ ok: true }) }
  catch (err: any) { return c.json({ error: err.message }, 500) }
})

imageGenRoutes.delete('/items', async c => {
  const { objectIDs } = await c.req.json()
  if (!Array.isArray(objectIDs) || !objectIDs.length) return c.json({ error: 'objectIDs array required' }, 400)
  const idSet = new Set(objectIDs)
  let removed = 0
  for (const { site, category } of getAllCatRefs()) {
    const data = loadFixture(site, category)
    if (!data) continue
    const before = (data.hits as any[]).length
    data.hits = (data.hits as any[]).filter((h: any) => !idSet.has(h.objectID))
    if (data.hits.length < before) { data.nbHits = data.hits.length; saveFixture(site, category, data); removed += before - data.hits.length }
  }
  return c.json({ ok: true, removed })
})

imageGenRoutes.post('/items', async c => {
  const body = await c.req.json() as any
  const { site, category, name, brand, price, fit, style, tags, colourHex, description } = body
  if (!site || !category || !name) return c.json({ error: 'site, category, and name required' }, 400)
  const siteDef = loadSites().find(s => s.id === site)
  if (!siteDef) return c.json({ error: `Unknown site: ${site}` }, 400)
  if (!siteDef.categories.includes(category)) return c.json({ error: `Unknown category: ${category}` }, 400)
  const parsedPrice = parsePrice(price)
  if (parsedPrice === null) return c.json({ error: 'price must be a number' }, 400)
  const data = loadFixture(site, category) ?? emptyFixture()
  const objectID = nextObjectID(category)
  const tagList  = parseTagList(tags)
  const slug     = slugify(name)
  const newItem: CatalogItem = {
    objectID, name, brand: brand || '', price: parsedPrice,
    currency: 'USD', category, style: normalizeStyle(style), fit: fit || 'unisex',
    tags: tagList, colourHex: colourHex || '#888888', colourFamily: 'neutral',
    images: [], url: `/products/${slug}`,  // no image yet — set by /generate, never guessed at creation
    inStock: true, description: description || '',
  }
  data.hits.push(newItem); data.nbHits = data.hits.length
  saveFixture(site, category, data)
  return c.json({ ok: true, item: enrich(newItem, loadManifest()) }, 201)
})

// Shared by imageGenRoutes (local UI, no auth) and catalogRoutes (remote callers, gated by
// STUDIO_API_TOKEN via requireAuth in server.ts) — same generation logic either way, just
// reachable at two mount points with different trust levels.
async function generateImageHandler(c: any) {
  const objectID = c.req.param('objectID')
  const body = await c.req.json().catch(() => ({})) as any
  const found = findItem(objectID)
  if (!found) return c.json({ error: 'Item not found' }, 404)
  const config = loadConfig()
  const base   = getSiteBasePrompt(found.site)
  const item   = body.imagePrompt ?? found.item.imagePrompt ?? autoPrompt(found.item)
  const full   = base.replace('{item}', item)
  try {
    const b64 = await callImageModel(full, config.imageModel)
    if (!existsSync(IMAGES)) mkdirSync(IMAGES, { recursive: true })
    writeFileSync(join(IMAGES, `${objectID}.jpg`), await whitenBackground(Buffer.from(b64, 'base64')))
    addToManifest(objectID)
    const imageUrl = `/images/${objectID}.jpg`
    // images[0] is the single source of truth for what an item's image is — keep it in
    // sync with what was actually just written, not just the response payload.
    //
    // Via updateItem, which re-reads the fixture, rather than by mutating `found.data`.
    // `found` was read before the model call above and is now seconds stale: anything
    // else that touched this category in the meantime is absent from it, and writing it
    // back would undo that. Two generates running against the same category used to
    // leave only the last one's image recorded — the others were generated, paid for,
    // written to disk, and then orphaned by a fixture that no longer referenced them.
    // Deletes lost the same way, in reverse: an item removed mid-generation came back.
    const stored = updateItem(objectID, it => { it.images = [imageUrl] })
    if (!stored) return c.json({ error: 'Item was removed while its image was generating' }, 404)
    return c.json({ ok: true, imageUrl, fullPrompt: full })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
}

imageGenRoutes.post('/:objectID/generate', generateImageHandler)

// Edits the existing image in place rather than regenerating from the text prompt, using
// whatever image model Settings has configured. Not every model can edit (dall-e-3 is
// generation-only); one that can't fails with the provider's own message rather than being
// silently swapped out, so the mismatch is visible instead of quietly ignored.
// Tweak is a preview, not an in-place edit: the result is written to a separate
// "<objectID>-tweak.jpg" candidate file so the original is never touched until the
// user explicitly accepts it (POST .../tweak/accept) or discards it (.../tweak/discard).
imageGenRoutes.post('/:objectID/tweak', async c => {
  const objectID = c.req.param('objectID')
  const { note } = await c.req.json().catch(() => ({})) as any
  if (!note || !String(note).trim()) return c.json({ error: 'note required' }, 400)
  const found = findItem(objectID)
  if (!found) return c.json({ error: 'Item not found' }, 404)
  const imgPath = join(IMAGES, `${objectID}.jpg`)
  if (!existsSync(imgPath)) return c.json({ error: 'No existing image to tweak — generate one first' }, 400)
  try {
    const imageBuffer = readFileSync(imgPath)
    const editPrompt = `${note.trim()}. Keep the white background, framing, and composition otherwise the same.`
    const b64 = await callImageEdit(imageBuffer, editPrompt, loadConfig().imageModel)
    const tweakPath = join(IMAGES, `${objectID}-tweak.jpg`)
    writeFileSync(tweakPath, await whitenBackground(Buffer.from(b64, 'base64')))
    return c.json({ ok: true, tweakUrl: `/images/${objectID}-tweak.jpg?t=${Date.now()}` })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

imageGenRoutes.post('/:objectID/tweak/accept', c => {
  const objectID = c.req.param('objectID')
  const tweakPath = join(IMAGES, `${objectID}-tweak.jpg`)
  if (!existsSync(tweakPath)) return c.json({ error: 'No pending tweak for this item' }, 404)
  renameSync(tweakPath, join(IMAGES, `${objectID}.jpg`))
  addToManifest(objectID)
  return c.json({ ok: true, imageUrl: `/images/${objectID}.jpg` })
})

imageGenRoutes.post('/:objectID/tweak/discard', c => {
  const objectID = c.req.param('objectID')
  const tweakPath = join(IMAGES, `${objectID}-tweak.jpg`)
  if (existsSync(tweakPath)) unlinkSync(tweakPath)
  return c.json({ ok: true })
})

imageGenRoutes.patch('/:objectID/prompt', async c => {
  const objectID = c.req.param('objectID')
  const { imagePrompt } = await c.req.json()
  const item = updateItem(objectID, it => { it.imagePrompt = imagePrompt })
  if (!item) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

imageGenRoutes.patch('/:objectID/meta', async c => {
  const objectID = c.req.param('objectID')
  const { name, brand, colourFamily, price, currency, fit, style } = await c.req.json()
  if (!name) return c.json({ error: 'name required' }, 400)
  let parsedPrice: number | null = 0
  if (price !== undefined) {
    parsedPrice = parsePrice(price)
    if (parsedPrice === null) return c.json({ error: 'price must be a number' }, 400)
  }
  const item = updateItem(objectID, it => {
    it.name  = name
    it.brand = brand ?? it.brand
    if (colourFamily !== undefined) it.colourFamily = colourFamily
    if (price        !== undefined) it.price        = parsedPrice
    if (currency     !== undefined) it.currency     = currency || 'USD'
    if (fit           !== undefined) it.fit          = fit || 'unisex'
    if (style         !== undefined) it.style        = normalizeStyle(style)
  })
  if (!item) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

imageGenRoutes.patch('/:objectID/description', async c => {
  const objectID = c.req.param('objectID')
  const { description } = await c.req.json()
  const item = updateItem(objectID, it => { it.description = description })
  if (!item) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

imageGenRoutes.patch('/:objectID/tags', async c => {
  const objectID = c.req.param('objectID')
  const { tags } = await c.req.json()
  const tagList = parseTagList(tags)
  const item = updateItem(objectID, it => { it.tags = tagList })
  if (!item) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true, tags: tagList })
})

// Clears an item's image — resets images to [] and, if a local <objectID>.jpg exists,
// removes that file and its manifest entry too. The item itself isn't touched — this only
// ever affects the image (see /api/items DELETE for whole-product deletion).
async function deleteImageHandler(c: any) {
  const objectID = c.req.param('objectID')
  const found = findItem(objectID)
  if (!found) return c.json({ error: 'Not found' }, 404)
  const idx = (found.data.hits as any[]).findIndex(h => h.objectID === objectID)
  found.data.hits[idx].images = []
  saveFixture(found.site, found.cat, found.data)
  const localPath = join(IMAGES, `${objectID}.jpg`)
  if (existsSync(localPath)) unlinkSync(localPath)
  const manifest = loadManifest()
  if (manifest.delete(objectID)) writeFileSync(MANIFEST, JSON.stringify([...manifest], null, 2))
  return c.json({ ok: true })
}
imageGenRoutes.delete('/:objectID/image', deleteImageHandler)

imageGenRoutes.post('/:objectID/enrich', async c => {
  const objectID = c.req.param('objectID')
  const found = findItem(objectID)
  if (!found) return c.json({ error: 'Not found' }, 404)
  try {
    const imagePrompt = await callText(enrichUserMessage(found.item, found.site))
    // Re-read rather than write back `found`, which predates the await — see the note in
    // generateImageHandler for what the stale snapshot costs.
    if (!updateItem(objectID, it => { it.imagePrompt = imagePrompt })) {
      return c.json({ error: 'Item was removed while its prompt was generating' }, 404)
    }
    return c.json({ ok: true, imagePrompt })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

imageGenRoutes.post('/:objectID/describe', async c => {
  const objectID = c.req.param('objectID')
  const found = findItem(objectID)
  if (!found) return c.json({ error: 'Not found' }, 404)
  const item = found.item
  const tags = (item.tags ?? []).filter((t: string) => !SKIP_TAGS.has(t)).join(', ')
  const msg = [`Name: ${item.name}`, item.brand ? `Brand: ${item.brand}` : '', tags ? `Tags: ${tags}` : '', item.fit ? `Fit: ${item.fit}` : '', item.price ? `Price: $${item.price}` : ''].filter(Boolean).join('\n')
  try {
    const description = await callText(msg, { system: 'You write retail product descriptions. Write 1–2 sentences. Specific and punchy. Plain text only.', maxTokens: 250 })
    // Re-read rather than write back `found`, which predates the await — see the note in
    // generateImageHandler for what the stale snapshot costs.
    if (!updateItem(objectID, it => { it.description = description })) {
      return c.json({ error: 'Item was removed while its description was generating' }, 404)
    }
    return c.json({ ok: true, description })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

imageGenRoutes.post('/generate-items', async c => {
  const { prompt, priceRange, styleHint, site } = await c.req.json() as any
  if (!prompt) return c.json({ error: 'prompt required' }, 400)
  const siteDef = loadSites().find(s => s.id === site)
  const validCats = siteDef ? siteDef.categories : getAllCats()
  const priceInstruction = priceRange ? `a realistic price within $${priceRange}` : 'a realistic retail price'
  const styleInstruction = styleHint
    ? `The user suggested "${styleHint}" as style. Include this and infer parallel styles that fit.`
    : `Infer all appropriate style tags from the product type and description.`
  const system = `You generate product catalog items for a retail website.
Output a JSON array of items matching the user's description.
Valid categories: ${validCats.join(', ')}
Each item must have EXACTLY these fields:
{ "name": "...", "brand": "...", "category": "...", "fit": "mens"|"womens"|"unisex", "style": "casual"|"smart-casual", "tags": [...], "colourHex": "#rrggbb", "colourFamily": "...", "price": ${priceInstruction} }
"style" is the item's overall dress-code register — "casual" for everyday/relaxed pieces (flannel shirts, weekend wear, denim, athleisure), "smart-casual" for more polished pieces (blazers, tailored trousers, dress shoes). Judge it from the product itself, independent of whatever the user's prompt says about descriptive tags below.
Style tag instructions (these are separate descriptive tags, not the "style" field above): ${styleInstruction}
Output ONLY a valid JSON array. No markdown, no prose.`
  try {
    const raw = await callText(prompt, { system, maxTokens: 2000 })
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('No JSON array in response')
    const items = JSON.parse(match[0])
    if (!Array.isArray(items)) throw new Error('Not an array')
    return c.json({ ok: true, items })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

imageGenRoutes.post('/describe-adhoc', async c => {
  const { name, brand, tags, fit, price, colour } = await c.req.json() as any
  if (!name) return c.json({ error: 'name required' }, 400)
  const tagStr = (tags ?? []).filter((t: string) => !SKIP_TAGS.has(t)).join(', ')
  const msg = [`Name: ${name}`, brand ? `Brand: ${brand}` : '', colour ? `Colour: ${colour}` : '', tagStr ? `Tags: ${tagStr}` : '', fit && fit !== 'unisex' ? `Fit: ${fit}` : '', price ? `Price: $${price}` : ''].filter(Boolean).join('\n')
  try {
    const description = await callText(msg, { system: 'You write retail product descriptions. 1–2 sentences. First sentence MUST name the exact colour. Plain text only.', maxTokens: 250 })
    return c.json({ ok: true, description })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

imageGenRoutes.post('/suggest-adhoc', async c => {
  const { name, brand, tags, fit, site, colour } = await c.req.json() as any
  if (!name) return c.json({ error: 'name required' }, 400)
  const msg = enrichUserMessage({ name, brand, tags, fit, colour }, site)
  try {
    const imagePrompt = await callText(msg, { maxTokens: 120 })
    return c.json({ ok: true, imagePrompt })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

imageGenRoutes.post('/generate-adhoc-image', async c => {
  const { tempId, imagePrompt, site } = await c.req.json() as any
  if (!tempId || !imagePrompt) return c.json({ error: 'tempId and imagePrompt required' }, 400)
  const safeTempId = sanitizeId(tempId)
  if (!safeTempId) return c.json({ error: 'tempId invalid' }, 400)
  const config = loadConfig()
  const base = getSiteBasePrompt(site)
  const full = base.replace('{item}', imagePrompt)
  try {
    const b64 = await callImageModel(full, config.imageModel)
    if (!existsSync(IMAGES)) mkdirSync(IMAGES, { recursive: true })
    const fname = `pending-${safeTempId}.jpg`
    writeFileSync(join(IMAGES, fname), await whitenBackground(Buffer.from(b64, 'base64')))
    return c.json({ ok: true, imageUrl: `/images/${fname}`, fullPrompt: full })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

imageGenRoutes.post('/items/batch', async c => {
  const { site, items } = await c.req.json() as any
  if (!site) return c.json({ error: 'site required' }, 400)
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'items array required' }, 400)
  const siteDef = loadSites().find(s => s.id === site)
  if (!siteDef) return c.json({ error: `Unknown site: ${site}` }, 400)
  const manifest = loadManifest()
  const saved: string[] = []
  for (const item of items) {
    const cat = item.category
    if (!cat || !siteDef.categories.includes(cat)) continue
    const parsedPrice = parsePrice(item.price)
    if (parsedPrice === null) continue // invalid price — skip this item rather than fail the whole batch
    const data = loadFixture(site, cat) ?? emptyFixture()
    const objectID = nextObjectID(cat)
    const slug = slugify(item.name)
    const tagList = parseTagList(item.tags)
    let imageUrl = ''
    if (item._id) {
      const pendingPath = join(IMAGES, `pending-${sanitizeId(item._id)}.jpg`)
      const finalPath   = join(IMAGES, `${objectID}.jpg`)
      if (existsSync(pendingPath)) {
        renameSync(pendingPath, finalPath)
        manifest.add(objectID)
        imageUrl = `/images/${objectID}.jpg`
      }
    }
    const newItem: CatalogItem = {
      objectID, name: item.name, brand: item.brand || '',
      price: parsedPrice,
      currency: item.currency || 'USD', category: cat, style: normalizeStyle(item.style),
      fit: item.fit || 'unisex', tags: tagList, colourHex: item.colourHex || '#888888',
      colourFamily: item.colourFamily || 'neutral',
      images: imageUrl ? [imageUrl] : [],  // only claim an image if one was actually generated for this item
      url: `/products/${slug}`, inStock: true,
      description: item.description || '', imagePrompt: item.imagePrompt || '',
    }
    data.hits.push(newItem); data.nbHits = data.hits.length
    saveFixture(site, cat, data)
    saved.push(objectID)
  }
  writeFileSync(MANIFEST, JSON.stringify([...manifest], null, 2))
  return c.json({ ok: true, added: saved.length, objectIDs: saved })
})

// ── Exports ───────────────────────────────────────────────────────────────────

interface ExportField {
  source: string
  target: string
  transform: 'passthrough' | 'first' | 'join' | 'image-url' | 'site-url'
  include: boolean
}

interface StoredTargetSchema {
  referenceUrl?: string
  rawPaste?: string
  raw?: string
  systemName?: string
  systemVersion?: string
  hasStandardSchema?: boolean
  schemaNote?: string
  referenceTitle?: string
}

interface ExportMap {
  id: string
  name: string
  description: string
  format: 'json-array'
  fields: ExportField[]
  targetSchema?: StoredTargetSchema
  siteBaseUrl?: string      // destination storefront domain, used by the site-url transform — per-map, not global
  imageExportBase?: string  // image_url base — also determines the zip download's internal image path
  created: string
  updated: string
}

// ── Built-in export templates ───────────────────────────────────────────────
// Hand-verified mappings for integrations whose real shape isn't reliably
// discoverable by the AI schema-lookup/draft/refine flow (see custom_fields
// history in this project). Selecting one hands back a finished, ready-to-use
// map — no LLM call involved — so it can't drift the way AI-refined maps did.
interface ExportTemplate {
  key: string
  name: string
  description: string
  fields: ExportField[]
  targetSchema: StoredTargetSchema
}

const EXPORT_TEMPLATES: ExportTemplate[] = [
  {
    key: 'algolia-bigcommerce-v2',
    name: 'Algolia Search with BigCommerce Integration',
    description: "Algolia's BigCommerce v2 product indexing schema — custom_fields[], nested categories/prices, and BC-auto-assigned fields handled correctly.",
    fields: [
      { source: 'objectID', target: 'objectID', transform: 'passthrough', include: true },
      { source: 'objectID', target: 'sku', transform: 'passthrough', include: true },
      { source: 'name', target: 'name', transform: 'passthrough', include: true },
      { source: 'description', target: 'description', transform: 'passthrough', include: true },
      { source: 'images', target: 'url', transform: 'site-url', include: false },
      { source: 'images', target: 'image_url', transform: 'image-url', include: true },
      { source: 'brand', target: 'brand_name', transform: 'passthrough', include: true },
      { source: 'category', target: 'categories.lvl0', transform: 'passthrough', include: true },
      { source: 'price', target: 'default_price', transform: 'passthrough', include: true },
      { source: 'price', target: 'prices.USD', transform: 'passthrough', include: true },
      { source: 'inStock', target: 'in_stock', transform: 'passthrough', include: true },
      { source: 'style', target: 'custom_fields[].text', transform: 'passthrough', include: true },
      { source: 'fit', target: 'custom_fields[].text', transform: 'passthrough', include: true },
      { source: 'finish', target: 'custom_fields[].text', transform: 'passthrough', include: true },
      { source: 'colourFamily', target: 'custom_fields[].text', transform: 'passthrough', include: true },
      { source: 'colourHex', target: 'custom_fields[].text', transform: 'passthrough', include: true },
      { source: 'tags', target: 'custom_fields[].text', transform: 'join', include: true },
      { source: 'imagePrompt', target: '', transform: 'passthrough', include: false },
      { source: 'currency', target: '', transform: 'passthrough', include: false },
    ],
    targetSchema: {
      referenceUrl: 'https://www.algolia.com/doc/integration/bigcommerce/indexing/product-schema',
      // Full real schema (not just the fields this template maps) so the schema
      // panel lets users browse and map additional fields on their own.
      raw: JSON.stringify({
        objectID: '111',
        name: 'My Awesome Product',
        description: '...',
        sku: 'MAP0001',
        url: '/my-awesome-product/',
        image_url: 'https://...',
        brand_id: 37,
        brand_name: 'My Brand',
        categories: { lvl0: ['Library', 'New Products', 'Publications'] },
        category_ids: [20, 23, 24],
        default_price: 37,
        prices: { EUR: 11.112, USD: 34.65 },
        retail_prices: { EUR: 0, USD: 0 },
        sales_prices: { EUR: 0, USD: 0 },
        calculated_prices: { EUR: 0, USD: 0 },
        in_stock: true,
        inventory: 90,
        inventory_tracking: 'variant',
        is_visible: true,
        date_created: '2015-07-03T20:55:30Z',
        date_modified: '2023-11-22T10:26:41Z',
        option_names: ['Publisher', 'Edition'],
        product_images: [
          { description: '', is_thumbnail: false, url_thumbnail: 'https://...' },
          { description: '', is_thumbnail: true, url_thumbnail: 'https://...' },
        ],
        // Known real shape — the source doc only shows this as an opaque {} placeholder
        // since it's merchant-configurable; see applyKnownFieldOverrides.
        custom_fields: [{ id: 1, product_id: 123, name: 'Style', text: 'sample value' }],
        metafields: {},
        variant_ids: [1210, 1211],
        variants: [
          {
            id: 1210, image_url: '', in_stock: false, inventory: 0, metafields: {},
            options: { Premium: 'Yes', Toto: 'test' },
            prices: { EUR: 11.112, USD: 34.65 },
            retail_prices: { EUR: 0, USD: 0 }, sales_prices: { EUR: 0, USD: 0 },
            sku: 'MAP0001-A', upc: '1234', mpn: '2344', gtin: '3456',
          },
          {
            id: 1211, image_url: '', in_stock: true, inventory: 10, metafields: {},
            options: { Publisher: 'My Publisher', Edition: '2024' },
            prices: { EUR: 11.112, USD: 34.65 },
            retail_prices: { EUR: 0, USD: 0 }, sales_prices: { EUR: 0, USD: 0 },
            sku: 'MAP0001-B', upc: '4321', mpn: '5432', gtin: '6543',
          },
        ],
        upc: '123456789',
        mpn: '123456789',
        gtin: '123456789',
      }, null, 2),
      systemName: 'Algolia Search & Discovery for BigCommerce',
      systemVersion: 'v2',
      hasStandardSchema: true,
      referenceTitle: 'Product schema - Algolia',
      schemaNote: 'id, product_id, and date_created/modified are auto-assigned by BigCommerce and intentionally left unmapped. url never fabricates a path — with no Site base URL set it\'s just the picture filename; with one set it\'s baseUrl + filename; a base URL with <field>/{field} tokens (e.g. https://store.com/prods/<objectID>/) gets that field substituted first.',
    },
  },
  {
    key: 'coveo-commerce-v1',
    name: 'Coveo for Commerce',
    description: "Coveo for Commerce catalog Product object — ec_-prefixed standard fields.",
    fields: [
      { source: 'objectID', target: 'documentId', transform: 'passthrough', include: true },
      { source: 'objectID', target: 'ec_product_id', transform: 'passthrough', include: true },
      { source: 'objectID', target: 'ec_variant_id', transform: 'passthrough', include: true },
      { source: 'objectID', target: 'ec_item_group_id', transform: 'passthrough', include: true },
      { source: '<compute:literal:Product>', target: 'objecttype', transform: 'passthrough', include: true },
      { source: 'name', target: 'ec_name', transform: 'passthrough', include: true },
      { source: 'description', target: 'ec_description', transform: 'passthrough', include: true },
      { source: 'category', target: 'ec_category', transform: 'passthrough', include: true },
      { source: 'price', target: 'ec_price', transform: 'passthrough', include: true },
      { source: 'brand', target: 'ec_brand', transform: 'passthrough', include: true },
      { source: 'images', target: 'ec_images', transform: 'passthrough', include: true },
      { source: 'inStock', target: 'ec_in_stock', transform: 'passthrough', include: true },
      { source: 'style', target: 'style', transform: 'passthrough', include: true },
      { source: 'fit', target: 'fit', transform: 'passthrough', include: true },
      { source: 'finish', target: 'finish', transform: 'passthrough', include: true },
      { source: 'colourFamily', target: 'color', transform: 'passthrough', include: true },
      { source: 'colourHex', target: 'colour_hex', transform: 'passthrough', include: true },
      { source: 'tags', target: 'tags', transform: 'passthrough', include: true },
      { source: 'url', target: '', transform: 'passthrough', include: false },
      { source: 'imagePrompt', target: '', transform: 'passthrough', include: false },
      { source: 'currency', target: '', transform: 'passthrough', include: false },
    ],
    targetSchema: {
      referenceUrl: 'https://docs.coveo.com/en/n73f0502/',
      raw: JSON.stringify({
        documentId: 'product://jacket-001',
        objecttype: 'Product',
        ec_product_id: 'jacket-001',
        ec_variant_id: 'jacket-001',
        ec_item_group_id: 'jacket-001',
        ec_name: 'Coveo Soccer Shoes - Red',
        ec_description: 'The astonishing, the original, and always relevant Coveo style.',
        ec_category: 'Apparel;Apparel|Footwear;Apparel|Footwear|Soccer Cleats',
        ec_price: 28.0,
        ec_brand: 'Coveo',
        ec_images: ['https://myimagegallery?productid'],
        ec_thumbnails: ['https://myimagegallery?productid&thumb'],
        ec_shortdesc: 'Authentic soccer cleats',
        ec_in_stock: true,
        color: ['Red'],
        gender: 'Men',
        model: 'Authentic',
      }, null, 2),
      systemName: 'Coveo for Commerce',
      systemVersion: '',
      hasStandardSchema: true,
      referenceTitle: 'Commerce fields | Coveo for Commerce',
      schemaNote: 'Worth verifying before relying on this: documentId is mapped from objectID as-is (e.g. "jacket-001") — Coveo\'s own example uses a URI-style value like "product://jacket-001"; docs say any scheme is acceptable, but confirm against your org. ec_in_stock is included as a documented Product field, but Coveo\'s reference also lists it as deprecated/no-longer-automatic — confirm it\'s still honored before relying on it for stock faceting. ec_variant_id/ec_item_group_id mirror objectID/ec_product_id since this catalog has no real product/variant grouping, matching Coveo\'s documented convention for products without variants.',
    },
  },
]

// Strip derived fields — only source fields should ever be persisted
function toStoredSchema(schema: any): StoredTargetSchema | undefined {
  if (!schema) return undefined
  const out: StoredTargetSchema = {}
  if (schema.referenceUrl)                    out.referenceUrl    = schema.referenceUrl
  if (schema.rawPaste)                        out.rawPaste        = schema.rawPaste
  if (schema.raw)                             out.raw             = schema.raw
  if (schema.systemName)                      out.systemName      = schema.systemName
  if (schema.systemVersion)                   out.systemVersion   = schema.systemVersion
  if (schema.hasStandardSchema !== undefined) out.hasStandardSchema = schema.hasStandardSchema
  if (schema.schemaNote)                      out.schemaNote      = schema.schemaNote
  if (schema.referenceTitle)                  out.referenceTitle  = schema.referenceTitle
  return Object.keys(out).length ? out : undefined
}

// Export-map ids arrive straight off the wire — from the :id route param, and from the
// request body on create, where the caller picks the id outright. They're interpolated
// into a filename, so this is the choke point that has to stop traversal: an id like
// "../../src/products/sites" makes join() resolve cleanly *outside* EXPORTS, turning map
// create/delete into an arbitrary .json write/unlink (and, since /:id/download puts the
// id in a Content-Disposition header, keeping the class tight closes that too). Real ids
// are already slugs or "<template-key>-<suffix>", so nothing legitimate needs more than
// this — same character class sanitizeId() uses.
function safeMapId(id: string): string {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
}

function exportMapPath(id: string) { return join(EXPORTS, `${safeMapId(id)}.json`) }

function loadExportMaps(): ExportMap[] {
  if (!existsSync(EXPORTS)) return []
  return readdirSync(EXPORTS)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(EXPORTS, f), 'utf-8')) as ExportMap)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function saveExportMap(map: ExportMap) {
  if (!existsSync(EXPORTS)) mkdirSync(EXPORTS, { recursive: true })
  writeFileSync(exportMapPath(map.id), JSON.stringify(map, null, 2))
}

function loadExportMap(id: string): ExportMap | null {
  const path = exportMapPath(id)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null
}

// Raw (un-enriched) items from every catalog fixture — the source of truth for exports.
// Optionally scoped to one site and/or a set of category names — used by export run/
// download so a map can be run against a slice of the catalog without being permanently
// tied to it. No filter = every item, unchanged from before site-scoped export existed.
function getAllCatalogItems(filter?: { site?: string; categories?: string[] }): any[] {
  let refs = getAllCatRefs()
  if (filter?.site) refs = refs.filter(r => r.site === filter.site)
  // Distinguish "no categories key sent at all" (no filtering — every category) from an
  // explicit but empty categories array (the UI's "None" selection — zero items on purpose).
  if (filter?.categories !== undefined) refs = refs.filter(r => filter.categories!.includes(r.category))
  return refs.flatMap(({ site, category }) => loadFixture(site, category)?.hits ?? [])
}

function applyExportMap(map: Pick<ExportMap, 'fields' | 'siteBaseUrl' | 'imageExportBase'>, items: any[]): any[] {
  return items.map(raw => {
    const out: Record<string, any> = {}
    const arrayGroups: Record<string, { source: string; subkey: string; val: any }[]> = {}

    for (const field of map.fields) {
      if (!field.include || !field.target) continue
      const computed =
        field.transform === 'site-url'  ? resolveFileUrl(raw, map.siteBaseUrl) :
        field.transform === 'image-url' ? resolveFileUrl(raw, map.imageExportBase) :
        transformValue(resolveSourceValue(raw, field.source), field.transform)
      // Pattern: prefix[].subkey → array-of-objects target
      const arrayMatch = field.target.match(/^([^[]+)\[\]\.(.+)$/)
      if (arrayMatch) {
        const prefix = arrayMatch[1]
        const subkey = arrayMatch[2]
        // Same reasoning as setNestedValue's UNSAFE_PATH_KEYS guard, which this branch
        // never reaches: a target of "__proto__[].text" would land on out[prefix] below
        // and hit Object.prototype's __proto__ setter instead of writing a field. Drop it.
        if (UNSAFE_PATH_KEYS.has(prefix) || UNSAFE_PATH_KEYS.has(subkey)) continue
        if (!arrayGroups[prefix]) arrayGroups[prefix] = []
        arrayGroups[prefix].push({ source: field.source, subkey, val: computed })
      } else {
        // Plain dotted target (e.g. "categories.lvl0") → build a real nested object
        setNestedValue(out, field.target, computed)
      }
    }

    // Emit array-of-objects groups
    for (const [prefix, entries] of Object.entries(arrayGroups)) {
      const uniqueSubkeys = [...new Set(entries.map(e => e.subkey))]
      if (uniqueSubkeys.length === 1) {
        // All mapped to the same subkey (e.g., custom_fields[].text for BigCommerce)
        // One array entry per source field, auto-populating 'name' from the source field name
        const subkey = uniqueSubkeys[0]
        out[prefix] = entries.map(e => ({ name: e.source, [subkey]: e.val }))
      } else {
        // Multiple subkeys — group by source field (one array entry per unique source)
        const bySource = new Map<string, Record<string, any>>()
        for (const e of entries) {
          if (!bySource.has(e.source)) bySource.set(e.source, {})
          bySource.get(e.source)![e.subkey] = e.val
        }
        out[prefix] = [...bySource.values()]
      }
    }

    return out
  })
}

// Writes val into obj following a dotted path, building nested objects as needed
// (mirrors getNestedValue's dot-notation reading, applied to the output side)
// A field's target path is caller-supplied (a saved map's fields, or the raw fields array
// POSTed to /exports/preview), so a target of "__proto__.x" would walk this loop straight
// onto Object.prototype — the "is it already an object?" guard passes for __proto__, so it
// isn't replaced with a fresh {} — and assign a property visible on every object in the
// process from then on. Nothing legitimate maps to these keys, so drop the write entirely.
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function setNestedValue(obj: Record<string, any>, path: string, val: any) {
  const keys = path.split('.')
  if (keys.some(k => UNSAFE_PATH_KEYS.has(k))) return
  let cur = obj
  // The walk below descends through computed keys, which semgrep flags as a prototype
  // pollution sink. UNSAFE_PATH_KEYS is checked against every segment above and returns
  // before this runs, so no polluting key can reach it — keep that guard if this function
  // is ever refactored, because the suppression below assumes it.
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {}
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = val
}

function getNestedValue(obj: any, path: string): any {
  // supports dot-notation: "images.0" → obj.images[0]
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj)
}

// Resolves a field's source value, honoring the <compute:literal:X> virtual source
// (a fixed string, same value on every record — e.g. Coveo's required objecttype:"Product")
// alongside the other <compute:*> virtual sources, which are handled at the UI/prompt layer.
function resolveSourceValue(raw: any, source: string): any {
  const literalMatch = source.match(/^<compute:literal:(.*)>$/)
  if (literalMatch) return literalMatch[1]
  return getNestedValue(raw, source)
}

// Resolves a value from the item's picture filename + a configurable base — used by
// both the "site-url" transform (base = map.siteBaseUrl) and the "image-url" transform
// (base = map.imageExportBase). Never fabricates a URL:
// - no base configured → just the picture filename (the one real thing we have)
// - base configured → base + picture filename
// - base contains <field> or {field} tokens → substituted with that item's real field value first
// - no picture at all → null (nothing honest to build a value from)
// A relative-path base (no http(s) scheme) is exactly what the zip download uses as the
// image's in-archive path too, so the JSON and the bundled files always match.
function resolveFileUrl(raw: any, base: string | undefined): string | null {
  const images = raw?.images
  const firstImage = Array.isArray(images) ? images[0] : images
  const picFilename = typeof firstImage === 'string' ? firstImage.split('/').pop() || null : null
  if (!picFilename) return null
  if (!base) return picFilename

  const expanded = base.replace(/[<{]([a-zA-Z0-9_.]+)[>}]/g, (_match, key) => {
    const v = getNestedValue(raw, key)
    return v == null ? '' : String(v)
  })
  const trimmed = expanded.replace(/\/+$/, '')
  return `${trimmed}/${picFilename}`
}

function extractPaths(obj: any, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return prefix ? [prefix] : []
  if (Array.isArray(obj)) {
    const firstObj = obj.find((v: any) => v && typeof v === 'object' && !Array.isArray(v))
    const arrayPrefix = prefix ? `${prefix}[]` : '[]'
    return firstObj ? extractPaths(firstObj, arrayPrefix) : (prefix ? [`${prefix}[]`] : [])
  }
  const paths: string[] = []
  for (const [key, val] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key
    if (val && typeof val === 'object') paths.push(...extractPaths(val as any, p))
    else paths.push(p)
  }
  return paths
}

// 'image-url' and 'site-url' are handled directly in applyExportMap (via resolveFileUrl) —
// both need the whole raw item, not just one extracted field value.
function transformValue(val: any, transform: ExportField['transform']): any {
  switch (transform) {
    case 'first':
      return Array.isArray(val) ? val[0] ?? null : val
    case 'join':
      return Array.isArray(val) ? val.join(', ') : val
    default:
      return val
  }
}

// build a representative sample item for the LLM to inspect
function sampleCatalogItem(): any {
  for (const { site, category } of getAllCatRefs()) {
    const data = loadFixture(site, category)
    if (data?.hits?.length) return data.hits[0]
  }
  return {}
}

// routes
imageGenRoutes.get('/exports', c => c.json(loadExportMaps()))

// List available built-in templates (metadata only, no field/schema payload)
imageGenRoutes.get('/exports/templates', c =>
  c.json(EXPORT_TEMPLATES.map(({ key, name, description }) => ({ key, name, description })))
)

// Instantiate a template into a new, ready-to-use saved export map — no LLM call
imageGenRoutes.post('/exports/templates/:key', c => {
  const key = c.req.param('key')
  const tpl = EXPORT_TEMPLATES.find(t => t.key === key)
  if (!tpl) return c.json({ error: 'Template not found' }, 404)
  const now = new Date().toISOString()
  const id = `${tpl.key}-${Date.now().toString(36).slice(-4)}`
  const map: ExportMap = {
    id, name: tpl.name, description: tpl.description,
    format: 'json-array',
    fields: tpl.fields.map(f => ({ ...f })),
    targetSchema: { ...tpl.targetSchema },
    created: now, updated: now,
  }
  saveExportMap(map)
  return c.json({ ok: true, map }, 201)
})

imageGenRoutes.post('/exports', async c => {
  const body = await c.req.json() as Partial<ExportMap>
  if (!body.name) return c.json({ error: 'name required' }, 400)
  const id = safeMapId(body.id || slugify(body.name))
  if (!id) return c.json({ error: 'invalid id' }, 400)
  const now = new Date().toISOString()
  const stored = toStoredSchema(body.targetSchema)
  const map: ExportMap = {
    id, name: body.name, description: body.description ?? '',
    format: 'json-array', fields: body.fields ?? [],
    ...(stored ? { targetSchema: stored } : {}),
    created: now, updated: now,
  }
  saveExportMap(map)
  return c.json({ ok: true, map }, 201)
})

imageGenRoutes.put('/exports/:id', async c => {
  const id = safeMapId(c.req.param('id'))
  const existing = loadExportMap(id)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json() as Partial<ExportMap>
  const merged = { ...existing, ...body, id, updated: new Date().toISOString() }
  if (merged.targetSchema) merged.targetSchema = toStoredSchema(merged.targetSchema)
  const updated: ExportMap = merged
  saveExportMap(updated)
  return c.json({ ok: true, map: updated })
})

// ── Known field shapes we won't trust the LLM to reconstruct ──────────────
// Some platform fields are merchant-configurable / dynamic (BigCommerce custom_fields,
// metafields, etc). Docs for the *indexing* integration often show these as an opaque
// placeholder ("custom_fields": {}) because the real shape lives in a different API
// reference. Rather than let the LLM invent plausible-looking sub-keys for these, we
// substitute the actual documented shape whenever the target system matches.
function applyKnownFieldOverrides(sample: any, systemName: string): any {
  if (!sample || typeof sample !== 'object') return sample
  if (/bigcommerce/i.test(systemName ?? '') && 'custom_fields' in sample) {
    sample.custom_fields = [{ id: 1, product_id: 123, name: 'Style', text: 'sample value' }]
  }
  return sample
}

// ── Claude web search for schema lookup ───────────────────────────────────
// The one model call in this file that is NOT provider-portable. It leans on Anthropic's
// server-side web_search tool: the search runs inside the single API call, which is why
// there's no agent loop here. That tool is Anthropic-specific and, going through an
// aggregator that re-frames requests as OpenAI chat completions, is either dropped or
// rejected — so rather than making a call that quietly comes back without having searched
// anything, this requires the direct Anthropic route and says so plainly when it isn't.
// The schema-from-URL flow is the fallback for every other configuration.
async function lookupSchemaWithWebSearch(name: string, description: string): Promise<any> {
  const config = loadConfig()
  const route = activeRoute()
  const { vendor, name: modelName } = splitModelId(config.textModel)
  if (route !== 'direct' || vendor !== 'anthropic') {
    throw new Error(
      `Schema lookup by web search needs an anthropic/* text model on the "direct" provider route ` +
      `(currently "${config.textModel}" on "${route}") — it uses Anthropic's server-side web search, ` +
      `which the other routes don't carry. Paste or link the schema instead.`,
    )
  }
  const anthropicProvider = providerFor('direct', 'anthropic') as ReturnType<typeof createAnthropic>

  const system = `You are a system integration expert. The user wants to find the canonical product/item schema for a specific platform integration.

Search the official documentation. Read the schema, API reference, or indexing documentation. Then output ONLY a raw JSON object — no markdown, no code fences, no explanation:
{
  "systemName": "human-readable system name",
  "systemVersion": "version if known, else empty string",
  "hasStandardSchema": true or false,
  "schemaNote": "if no fixed schema: one sentence explaining why. Otherwise empty string.",
  "referenceUrl": "the exact URL of the documentation page you found and read",
  "referenceTitle": "title of that page",
  "sample": { ...see rules below... }
}

Rules for hasStandardSchema and the "sample" field — this is critical:
- Determine first whether the SYSTEM ITSELF has a fixed/required schema at all. Schema-free or dynamically-mapped search engines (Algolia, Elasticsearch, OpenSearch, Typesense, Meilisearch, and similar) have NO required field list — any field name is valid, only an ID field is typically required. If that's what you find: set hasStandardSchema:false, sample:{} (genuinely empty, not a "recommended" or "typical" example), and explain in schemaNote that the system is schema-free so the catalog's own field names should be used directly. A guide's suggested/example record is NOT a required schema — do not return one just because docs, blog posts, or integration guides show example fields.
- Only when the system DOES have a real fixed/required schema: include every top-level field it supports, with realistic placeholder values.
- For fields that are arrays of objects (e.g. variants, images), include the array with ONE complete example object showing ALL available sub-fields and their correct property names. Never use [] or {} for these — always show the real structure.
- For nested objects, include all their sub-fields too.
- Use the exact property names from the documentation — do not invent or abbreviate them.
- Example of correct array-of-objects representation: "custom_fields": [{"id": 1, "product_id": 123, "name": "Style", "text": "sample value"}]
- IMPORTANT — do not fabricate individual fields either: if a field is merchant-configurable / dynamic (e.g. custom_fields, metafields) and the page you're reading only shows it as an opaque placeholder ("custom_fields": {}) without documenting real sub-field names, do NOT invent plausible-looking keys for it. Instead search specifically for that sub-resource's own API reference (e.g. "BigCommerce custom fields API") to find its real shape. If you still can't find a real shape, leave it as an empty array/object and say so in schemaNote — an honest empty placeholder beats a fabricated one.

Use the real field names from what you find. Output ONLY the JSON object.`

  const res = await withProviderError(() => generateText({
    model: anthropicProvider.languageModel(modelName),
    system,
    prompt: `Integration: ${name}\nDescription: ${description || '(none)'}`,
    maxOutputTokens: 4000,
    tools: { web_search: anthropicProvider.tools.webSearch_20250305({ maxUses: 3 }) },
  }))

  // web search runs server-side inside the single call, so there's nothing to loop over —
  // the SDK concatenates the response's text blocks into .text for us.
  const match = res.text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON in response')
  const parsed = JSON.parse(match[0])
  parsed.sample = applyKnownFieldOverrides(parsed.sample, parsed.systemName)
  return parsed
}

// ── Parse schema from a fetched URL ───────────────────────────────────────

// This endpoint fetches a URL the caller chose, from inside the network the server sits
// in — the classic SSRF shape. Without these checks it reaches cloud metadata endpoints
// (169.254.169.254), anything on loopback, and any internal host the container can route
// to, and hands the response back to the caller via the LLM summary. So: http(s) only,
// and every address the hostname actually resolves to must be public. Checking the
// resolved IPs rather than the hostname is what stops a name that deliberately points at
// a private address, and re-checking each hop below is what stops a public URL that just
// redirects there.
function isPrivateAddress(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '')
  // v4-mapped has to be unwrapped *before* the dotted-quad branch below, not after it:
  // "::ffff:127.0.0.1".split('.') is also 4 long, so it would be taken for IPv4, the
  // first octet would parse as NaN, no range would match, and a loopback (or metadata)
  // address would be reported public. Only the dotted form is reachable in practice —
  // that's what dns.lookup() hands back — so anything else wearing the ::ffff: prefix is
  // refused outright rather than guessed at.
  if (addr.startsWith('::ffff:')) {
    const mapped = addr.slice(7)
    return mapped.split('.').length === 4 ? isPrivateAddress(mapped) : true
  }
  const v4 = addr.split('.')
  if (v4.length === 4) {
    const [a, b] = v4.map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true   // link-local — AWS/GCP/Azure metadata
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
    return false
  }
  if (addr === '::1' || addr === '::') return true
  if (/^f[cd]/.test(addr)) return true        // unique-local
  if (addr.startsWith('fe80')) return true    // link-local
  return false
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL
  try { u = new URL(raw) } catch { throw new Error('Invalid URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are supported')
  const addrs = await lookup(u.hostname, { all: true }).catch(() => {
    throw new Error('Could not resolve host')
  })
  if (!addrs.length) throw new Error('Could not resolve host')
  if (addrs.some(a => isPrivateAddress(a.address))) throw new Error('Refusing to fetch a private/internal address')
  return u
}

// Redirects are followed by hand so each hop gets the same check — 'follow' would let a
// public URL bounce us to an internal one with no second look.
async function fetchPublicUrl(raw: string, hops = 3): Promise<Response> {
  let target = raw
  for (let i = 0; i <= hops; i++) {
    const u = await assertPublicUrl(target)
    const res = await fetch(u, {
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (res.status < 300 || res.status >= 400) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    target = new URL(loc, u).toString()
  }
  throw new Error('Too many redirects')
}

async function fetchAndParseSchema(url: string): Promise<any> {
  const pageRes = await fetchPublicUrl(url)
  if (!pageRes.ok) throw new Error(`URL returned ${pageRes.status}`)
  const html = await pageRes.text()
  // strip tags, keep text
  const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                   .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s{2,}/g, ' ')
                   .slice(0, 12000) // fit in context

  const system = `Extract the product/item record schema from this documentation page and return a JSON object:
{
  "systemName": "name of the platform/integration",
  "systemVersion": "version if mentioned, else empty string",
  "hasStandardSchema": true,
  "hasStandardSchema": false if the schema is user-configurable or not fixed,
  "schemaNote": "brief note if the schema is configurable or context-dependent, else empty string",
  "referenceTitle": "page title",
  "sample": { ...see rules below... }
}

Rules for the "sample" field — this represents ONE real record as it would appear in the system:
- First determine whether the SYSTEM ITSELF has a fixed/required schema at all. Schema-free or dynamically-mapped search engines (Algolia, Elasticsearch, OpenSearch, Typesense, Meilisearch, and similar) have NO required field list — any field name is valid. If that's what this page describes: set hasStandardSchema:false, sample:{} (genuinely empty, not a "recommended" or "typical" example), and explain in schemaNote that the system is schema-free. A guide's suggested/example record shown on the page is NOT a required schema — do not return one just because the page shows example fields.
- Only when the system DOES have a real fixed/required schema: include actual field names of a record (e.g. "objectID", "name", "price") — NOT schema configuration options or mode names.
- If the page describes multiple schema options (e.g. product-level vs variant-level), pick the most common one and document it. Note the choice in schemaNote.
- For fields that are arrays of objects, include the array with ONE complete example object showing ALL sub-fields with their exact property names. Never use [] or {}.
- Use placeholder values that reflect the field type (strings, numbers, booleans).
- If the page does not contain enough field-level detail to produce a real sample, set hasStandardSchema:false and return an empty sample {}.
- IMPORTANT — do not fabricate individual fields either: if a field is merchant-configurable / dynamic (e.g. custom_fields, metafields) and this page only shows it as an opaque placeholder ("custom_fields": {}) without documenting real sub-field names, do NOT invent plausible-looking keys for it — leave it as an empty array/object and note it in schemaNote rather than guessing.
Output ONLY the raw JSON object.`

  const raw = await callText(text, { system, maxTokens: 1500, model: loadConfig().textModel })
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Could not parse schema from page')
  const parsed = JSON.parse(match[0])
  parsed.sample = applyKnownFieldOverrides(parsed.sample, parsed.systemName)
  return { ...parsed, referenceUrl: url, referenceTitle: parsed.referenceTitle || url }
}

imageGenRoutes.delete('/exports/:id', c => {
  const id = c.req.param('id')
  const path = exportMapPath(id)
  if (!existsSync(path)) return c.json({ error: 'Not found' }, 404)
  unlinkSync(path)
  return c.json({ ok: true })
})

imageGenRoutes.post('/exports/draft', async c => {
  const { name, description, targetSchema, targetSystemName } = await c.req.json() as {
    name: string; description: string; targetSchema?: string; targetSystemName?: string
  }
  if (!name) return c.json({ error: 'name required' }, 400)
  const sample = sampleCatalogItem()
  const { hasImage, isAIGenerated, hasCustomPrompt, imageUrl, ...cleanSample } = sample
  const dest = targetSystemName || name
  // Detect schema-free flat targets (Algolia standalone, Elasticsearch) vs structured targets
  const flatTarget = !targetSchema && /algolia|elasticsearch|opensearch|typesense/i.test(dest)
  const schemaBlock = targetSchema
    ? `\nThe TARGET system has this fixed schema — map TO these exact field names only:\n${targetSchema}\n`
    : ''
  const system = `You generate export field maps for product catalog data.
Destination system: ${dest} — ${description || 'standard format'}.
${schemaBlock}
Here is a sample catalog item — these are the ONLY valid "source" field names (exact keys). Never invent source fields not present here:
${JSON.stringify(cleanSample, null, 2)}

Virtual computed sources (allowed in addition to the above):
- "<compute:uuid>" — generates a new UUID at export time (use when target requires a UUID primary key)
- "<compute:timestamp>" — generates current ISO timestamp (use when target requires date_created/date_modified and catalog has no value)
- "<compute:empty>" — emits null/empty (use to satisfy required target fields with no catalog equivalent)
- "<compute:literal:X>" — emits the fixed literal string X on every record (use only when the target requires a constant discriminator value, e.g. a fixed "type" or "objecttype" field — never use this to invent placeholder data for a field that should come from the catalog)

${flatTarget ? `IMPORTANT — ${dest} is a schema-free search engine. Every source field maps directly to a top-level attribute. Rules for flat/schema-free targets:
- Include ALL fields that are meaningful product data — every attribute becomes searchable or facetable
- Style, finish, colourFamily, fit, width, tags, category etc. are valuable facet attributes — include them ALL
- Arrays (tags, category) stay as arrays — DO NOT use join; the engine handles arrays natively
- Use snake_case for target field names (colourFamily → colour_family)
- Map images with "image-url" transform → "image_url"
- NEVER consolidate fields into custom_fields, attributes[], or any other envelope structure — every field is top-level
- objectID is the required unique identifier — map from the source objectID field (keep our readable ID e.g. jacket-001, not a UUID)
` : `IMPORTANT — map to the target schema fields provided. If a source field cannot cleanly map to a target field, set include:false. Do not invent nested structures (like custom_fields) that are not in the schema.
- For BigCommerce custom_fields, the object shape is { id, product_id, name, text } — use "custom_fields[].text" as the target (NOT "value"). Multiple source fields can share the same target path.
- For target fields that are auto-assigned by the system (e.g. BigCommerce numeric id, created_at timestamps), omit them from the output entirely — do not create a row. Map our objectID to a stable string identifier the target accepts (e.g. sku, external_id).
- Only use <compute:uuid> or <compute:timestamp> when the target explicitly requires a generated value with no catalog equivalent.`}

Output a JSON array of field mapping objects with this exact shape:
[{ "source": "<field-name or <compute:*>>", "target": "<export-field-name>", "transform": "passthrough"|"first"|"join"|"image-url", "include": true|false }]

Transform rules:
- "passthrough" — copy value as-is (strings, numbers, booleans, arrays)
- "first" — take first element of an array
- "join" — join array to a comma-separated string (only if target explicitly requires a string, not for flat search engines)
- "image-url" — build a URL from the item's picture filename + this map's Image export base (set separately by the user); never fabricates a host

Always exclude internal fields (set include:false): imagePrompt, isAIGenerated, hasCustomPrompt, hasImage.
${targetSchema ? 'Target field names MUST exactly match the schema above.' : ''}
Output ONLY a valid JSON array. No markdown, no explanation.`

  const validDraftSources = new Set(Object.keys(cleanSample))
  try {
    const raw = await callText(name + (description ? ': ' + description : ''), { system, maxTokens: 2000 })
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('No JSON array in response')
    const allFields: ExportField[] = JSON.parse(match[0])
    const fields = allFields.filter((f: ExportField) =>
      !f.source || validDraftSources.has(f.source) || /^<compute:[^>]+>$/.test(f.source)
    )
    // Always include every catalog source field — add any the LLM skipped as excluded rows
    const mappedSources = new Set(fields.map((f: ExportField) => f.source))
    for (const src of Object.keys(cleanSample)) {
      if (!mappedSources.has(src)) {
        fields.push({ source: src, target: '', transform: 'passthrough', include: false })
      }
    }
    return c.json({ ok: true, fields })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

imageGenRoutes.post('/exports/refine', async c => {
  const { fields, targetSchema, targetSystemName, instruction } = await c.req.json() as {
    fields: ExportField[]; targetSchema?: string; targetSystemName?: string; instruction: string
  }
  if (!fields?.length || !instruction) return c.json({ error: 'fields and instruction required' }, 400)

  const sample = sampleCatalogItem()
  const { hasImage, isAIGenerated, hasCustomPrompt, imageUrl, ...cleanSample } = sample
  const dest = targetSystemName || 'target system'
  const validSourceKeys = new Set(Object.keys(cleanSample))

  const system = `You are refining an existing export field map based on a user instruction.

SOURCE — all catalog fields available to map FROM (use ONLY these exact key names as "source" values — never invent source fields not present here):
${JSON.stringify(cleanSample, null, 2)}

Virtual computed sources (allowed in addition to the above):
- "<compute:uuid>" — generates a new UUID at export time
- "<compute:timestamp>" — generates current ISO timestamp
- "<compute:empty>" — emits null/empty for required target fields with no catalog equivalent
- "<compute:literal:X>" — emits the fixed literal string X on every record (only for a required constant discriminator field, e.g. objecttype — never for data that should come from the catalog)

${targetSchema ? `TARGET SCHEMA — ${dest} (map TO these fields):
${targetSchema}
` : `TARGET — ${dest} (schema-free; any field name is valid)`}

CURRENT MAP (complete — update only what the instruction requires):
${JSON.stringify(fields, null, 2)}

Follow the user's instruction exactly. Return ALL fields — changed and unchanged — as a single JSON array.

Mapping rules:
- "source" must be an exact key from the SOURCE object above OR one of the <compute:*> virtual sources — never invent other source fields.
- For BigCommerce custom_fields, the object shape is { id, product_id, name, text } — use "custom_fields[].text" as the target (NOT "value"). The "name" key is auto-populated from the source field name — do NOT create separate rows for "custom_fields[].name". Multiple source fields can share the same target path (e.g. style, fit, finish all → custom_fields[].text).
- For flat/schema-free targets (Algolia etc.), all fields are top-level attributes.
- For target fields that are auto-assigned by the system (e.g. numeric primary keys, system-generated timestamps), omit them from the output entirely — do not create a row.
- Always set include:false for internal fields: imagePrompt, isAIGenerated, hasCustomPrompt, hasImage.
- Preserve all fields not mentioned in the instruction exactly as they are.

Output ONLY a valid JSON array of field mapping objects with shape:
[{ "source": "...", "target": "...", "transform": "passthrough"|"first"|"join"|"image-url", "include": true|false }]
No markdown, no explanation.`

  try {
    const raw = await callText(instruction, { system, maxTokens: 2000 })
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('No JSON array in response')
    const updated: ExportField[] = JSON.parse(match[0])
    // Strip hallucinated source fields not present in the actual catalog or original map
    const inputSources = new Set(fields.map((f: ExportField) => f.source).filter(Boolean))
    const filtered = updated.filter((f: ExportField) =>
      !f.source ||
      validSourceKeys.has(f.source) ||
      inputSources.has(f.source) ||
      /^<compute:[^>]+>$/.test(f.source)
    )
    return c.json({ ok: true, fields: filtered })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

imageGenRoutes.post('/exports/schema-lookup', async c => {
  const { name, description } = await c.req.json() as { name: string; description: string }
  if (!name) return c.json({ error: 'name required' }, 400)

  try {
    const parsed = await lookupSchemaWithWebSearch(name, description ?? '')
    const sample = parsed.sample ?? {}
    const fields = extractPaths(sample)
    return c.json({
      ok: true,
      systemName: parsed.systemName ?? name,
      systemVersion: parsed.systemVersion ?? '',
      hasStandardSchema: parsed.hasStandardSchema ?? false,
      schemaNote: parsed.schemaNote ?? '',
      referenceUrl: parsed.referenceUrl ?? '',
      referenceTitle: parsed.referenceTitle ?? '',
      sample,
      fields,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Fetch a user-provided docs URL and extract the schema from it
imageGenRoutes.post('/exports/schema-from-url', async c => {
  const { url } = await c.req.json() as { url: string }
  if (!url) return c.json({ error: 'url required' }, 400)
  try {
    const parsed = await fetchAndParseSchema(url)
    const fields = extractPaths(parsed.sample ?? {})
    return c.json({ ok: true, ...parsed, fields })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Preview the transform for a single record — lets users verify a mapping
// (e.g. custom_fields[] grouping) before saving or running the full export.
imageGenRoutes.post('/exports/preview', async c => {
  const { fields, objectID, siteBaseUrl, imageExportBase } = await c.req.json() as {
    fields: ExportField[]; objectID?: string; siteBaseUrl?: string; imageExportBase?: string
  }
  if (!fields?.length) return c.json({ error: 'fields required' }, 400)
  const found = objectID ? findItem(objectID) : null
  const item = found?.item ?? sampleCatalogItem()
  if (!item) return c.json({ error: 'No catalog items to preview against' }, 400)
  const [result] = applyExportMap({ fields, siteBaseUrl, imageExportBase }, [item])
  return c.json({ ok: true, objectID: item.objectID, result })
})

imageGenRoutes.post('/exports/:id/run', async c => {
  const map = loadExportMap(c.req.param('id'))
  if (!map) return c.json({ error: 'Not found' }, 404)
  // site/categories are optional and chosen ad-hoc per run — not persisted on the map —
  // so one map stays reusable across sites. Omitted = every item, same as before this existed.
  const { site, categories } = await c.req.json().catch(() => ({})) as { site?: string; categories?: string[] }
  return c.json(applyExportMap(map, getAllCatalogItems({ site, categories })))
})

// Bundle the export JSON together with every referenced product image into one zip
imageGenRoutes.post('/exports/:id/download', async c => {
  const id = safeMapId(c.req.param('id'))
  const map = loadExportMap(id)
  if (!map) return c.json({ error: 'Not found' }, 404)
  const { site, categories } = await c.req.json().catch(() => ({})) as { site?: string; categories?: string[] }
  const allItems = getAllCatalogItems({ site, categories })
  const exported = applyExportMap(map, allItems)

  // Place each item's image at the exact same path its image_url resolves to, so the
  // zip's layout always matches the JSON — a relative imageExportBase means moving the
  // whole extracted zip preserves working references. An absolute-URL base (an external
  // host) has no meaningful in-zip path to mirror, so those fall back to a flat images/ folder.
  const imageEntries = new Map<string, string>() // in-zip path → source file path on disk
  for (const item of allItems) {
    const firstImage = Array.isArray(item.images) ? item.images[0] : item.images
    if (typeof firstImage !== 'string') continue
    const filename = basename(firstImage)
    const resolved = resolveFileUrl(item, map.imageExportBase)
    const inZipPath = resolved && !/^https?:\/\//.test(resolved) ? resolved : `images/${filename}`
    imageEntries.set(inZipPath, join(IMAGES, filename))
  }

  const archive = archiver('zip', { zlib: { level: 9 } })
  const chunks: Buffer[] = []
  archive.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve())
    archive.on('error', reject)
  })

  archive.append(JSON.stringify(exported, null, 2), { name: `${id}-export.json` })
  for (const [inZipPath, filePath] of imageEntries) {
    if (existsSync(filePath)) archive.file(filePath, { name: inZipPath })
  }
  archive.finalize()
  await finished

  return new Response(Buffer.concat(chunks), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${id}-export.zip"`,
    },
  })
})

// ── Catalog API (for remote consumers — other services using this as a backend) ─

export const catalogRoutes = new Hono()

catalogRoutes.get('/', c => {
  const cat      = c.req.query('category')
  const siteQ    = c.req.query('site')
  const style    = c.req.query('style')
  const limit    = parseInt(c.req.query('limit') ?? '20', 10)
  const offset   = parseInt(c.req.query('offset') ?? '0', 10)
  const manifest = loadManifest()
  // A bare ?category= is ambiguous once two sites genuinely share that name — an optional
  // ?site= disambiguates; omitted, it merges every site's matching category (unchanged
  // behavior for the common, non-colliding case existing external callers rely on).
  let refs = getAllCatRefs()
  if (siteQ) refs = refs.filter(r => r.site === siteQ)
  if (cat)   refs = refs.filter(r => r.category === cat)
  const hits: any[] = refs.flatMap(({ site, category }) => {
    const data = loadFixture(site, category)
    if (!data) return []
    return (data.hits as any[])
      .filter(h => !style || (h.style === style || (h.tags ?? []).includes(style)))
      .map(h => enrich(h, manifest))
  })
  const page = hits.slice(offset, offset + limit)
  return c.json({ hits: page, nbHits: hits.length, offset, limit })
})

catalogRoutes.get('/:objectID', c => {
  const found = findItem(c.req.param('objectID'))
  if (!found) return c.json({ error: 'Not found' }, 404)
  return c.json(enrich(found.item, loadManifest()))
})

// Lets an authenticated remote caller (anything with STUDIO_API_TOKEN, not just the local
// UI) trigger image generation or clear an item's image — same handlers as the
// local-only /api/... routes. Reading the full catalog already exists above
// (GET / and GET /:objectID).
catalogRoutes.post('/:objectID/generate', generateImageHandler)
catalogRoutes.delete('/:objectID/image', deleteImageHandler)

// ── Test surface ──────────────────────────────────────────────────────────────
// Internals grouped into one export so the unit tests can reach them directly
// rather than only through HTTP routes. Nothing in the app imports from here —
// server.ts consumes imageGenRoutes/catalogRoutes only.
export {
  slugify, parseTagList, parsePrice, autoPrompt, enrich, emptyFixture,
  sitesSharingCategory, fixtureFilename, nextObjectID, getAllCatRefs, getAllCats,
  loadSites, saveSites, loadConfig, loadFixture, saveFixture, loadManifest,
  safeFilename, sanitizeId, safeMapId,
  setNestedValue, getNestedValue, resolveSourceValue, resolveFileUrl,
  transformValue, applyExportMap, extractPaths, toStoredSchema,
  isPrivateAddress, assertPublicUrl, whitenBackground,
  splitModelId, isProviderRoute, resolveModel, providerErrorMessage,
  PROVIDER_ROUTES, PROVIDER_ROUTE_KEYS, MODEL_ID,
  getAllCatalogItems, loadExportMaps, loadExportMap, EXPORT_TEMPLATES,
}
export type { CatalogItem, CatalogFixture, SiteDef, ExportField, ExportMap }
