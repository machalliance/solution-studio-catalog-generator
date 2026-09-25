import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readdirSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile,
  writeManifest, writeImage, pngBuffer, item, json, noBody,
} from '../helpers/workspace.ts'

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

beforeEach(() => {
  for (const dir of [ws.catalog, ws.images]) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
  }
  writeSites(ws, [
    { id: 'clothing', categories: ['pants'] },
    { id: 'home', categories: ['tile'] },
  ])
})

afterAll(() => destroyWorkspace(ws))

describe('GET /health', () => {
  it('reports ok with a timestamp — this is what the container healthcheck hits', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(Date.parse(body.ts)).not.toBeNaN()
  })

  it('needs no same-origin header, so the healthcheck works without one', async () => {
    expect((await app.request('/health', { headers: { Host: 'localhost' } })).status).toBe(200)
  })
})

describe('GET /', () => {
  it('serves the UI as HTML', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })
})

describe('GET /images/:filename', () => {
  it('serves a stored image with a type derived from the extension', async () => {
    await writeImage(ws, 'tile-001.jpg')
    await writeImage(ws, 'shot.png')
    await writeImage(ws, 'anim.gif')

    expect((await app.request('/images/tile-001.jpg')).headers.get('content-type')).toBe('image/jpeg')
    expect((await app.request('/images/shot.png')).headers.get('content-type')).toBe('image/png')
    expect((await app.request('/images/anim.gif')).headers.get('content-type')).toBe('image/gif')
  })

  it('returns the actual bytes and asks not to cache them', async () => {
    const png = await pngBuffer(4, 4, [10, 20, 30])
    await writeImage(ws, 'tile-001.jpg', png)

    const res = await app.request('/images/tile-001.jpg')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
  })

  it('404s a file that is not there', async () => {
    const res = await app.request('/images/nope.jpg')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not found')
  })

  // The filename is interpolated straight into a path under data/images.
  it('refuses to traverse out of the images directory', async () => {
    const secret = join(ws.root, 'secret.txt')
    writeFileSync(secret, 'do not serve me')

    for (const path of [
      '/images/..%2Fsecret.txt',
      '/images/..%2F..%2Fsecret.txt',
      '/images/%2e%2e%2fsecret.txt',
      '/images/....%2F%2Fsecret.txt',
    ]) {
      const res = await app.request(path)
      expect(res.status, path).toBe(404)
      expect(await res.text()).not.toContain('do not serve me')
    }
  })

  it('serves .jpeg and .webp with their own types, case-insensitively', async () => {
    await writeImage(ws, 'a.jpeg')
    await writeImage(ws, 'b.webp')
    await writeImage(ws, 'C.PNG')

    expect((await app.request('/images/a.jpeg')).headers.get('content-type')).toBe('image/jpeg')
    expect((await app.request('/images/b.webp')).headers.get('content-type')).toBe('image/webp')
    expect((await app.request('/images/C.PNG')).headers.get('content-type')).toBe('image/png')
  })

  // IMAGES_HOST_PATH can point the mount at any host directory (e.g. ~/.ssh), so a file
  // that exists in it is not enough — only image extensions are ever served.
  it('refuses a non-image file even when it exists in the images directory', async () => {
    for (const name of ['id_rsa', 'credentials', '.env', 'config.json', 'notes.txt', 'key.pem', 'x.jpg.txt']) {
      writeFileSync(join(ws.images, name), 'do not serve me')
      const res = await app.request(`/images/${encodeURIComponent(name)}`)
      expect(res.status, name).toBe(404)
      expect(await res.text()).not.toContain('do not serve me')
    }
  })
})

// /api/* has no bearer token — it is the local UI's own backend — so the same-origin
// check is what stops a page the user happens to have open from driving these routes on
// their behalf. c.req.json() as any parses whatever the body is regardless of Content-Type, so
// a cross-origin text/plain POST is a "simple" request that skips preflight entirely.
describe('same-origin enforcement on /api/*', () => {
  it('allows a write whose Origin matches Host', async () => {
    const res = await app.request('/api/sites', json({ label: 'Garden' }))
    expect(res.status).toBe(201)
  })

  it('rejects a write from another origin', async () => {
    const res = await app.request('/api/sites', json({ label: 'Evil' }, {
      headers: { Origin: 'https://evil.example' },
    }))
    expect(res.status).toBe(403)
    expect(await res.json() as any).toEqual({ error: 'Cross-origin request rejected' })
  })

  it('rejects it whatever the Content-Type claims', async () => {
    const res = await app.request('/api/sites', {
      method: 'POST',
      headers: { Host: 'localhost', Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ label: 'Evil' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects a same-host origin on a different port', async () => {
    const res = await app.request('/api/sites', json({ label: 'Evil' }, {
      headers: { Origin: 'http://localhost:9999' },
    }))
    expect(res.status).toBe(403)
  })

  it('allows a request with no Origin at all — curl and server-to-server callers', async () => {
    const res = await app.request('/api/sites', {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Scripted' }),
    })
    expect(res.status).toBe(201)
  })

  it('lets reads through from anywhere — they change nothing', async () => {
    for (const method of ['GET', 'HEAD']) {
      const res = await app.request('/api/sites', {
        method, headers: { Host: 'localhost', Origin: 'https://evil.example' },
      })
      expect(res.status, method).toBe(200)
    }
  })

  it('rejects every mutating verb from a foreign origin', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
    const foreign = { Host: 'localhost', Origin: 'https://evil.example', 'Content-Type': 'application/json' }
    const cases: [string, string][] = [
      ['POST', '/api/items'],
      ['PATCH', '/api/tile-001/meta'],
      ['PUT', '/api/exports/anything'],
      ['DELETE', '/api/items'],
    ]
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: foreign, body: '{}' })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('rejects a malformed Origin rather than treating it as absent', async () => {
    const res = await app.request('/api/sites', json({ label: 'Evil' }, { headers: { Origin: 'not-a-url' } }))
    expect(res.status).toBe(403)
  })
})

describe('error handling', () => {
  it('turns an unhandled throw into the same {error} shape every route uses', async () => {
    // an invalid JSON body makes c.req.json() as any throw inside the handler
    const res = await app.request('/api/config', {
      method: 'POST',
      headers: { Host: 'localhost', Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json() as any).toEqual({ error: 'Internal error' })
  })

  it('does not leak the underlying message to the client', async () => {
    const res = await app.request('/api/config', {
      method: 'POST',
      headers: { Host: 'localhost', Origin: 'http://localhost' },
      body: '{ not json',
    })
    const body = await res.json() as any
    expect(body.error).toBe('Internal error')
    expect(JSON.stringify(body)).not.toMatch(/JSON|token|position|\//)
  })
})

describe('GET /api/config and /api/settings', () => {
  it('returns the defaults before anything is saved', async () => {
    const cfg = await (await app.request('/api/config')).json() as any
    expect(cfg).toMatchObject({
      provider: 'direct',
      imageModel: 'openai/gpt-image-1',
      textModel: 'anthropic/claude-opus-5',
      textModelFast: 'anthropic/claude-haiku-4-5',
      landingDemoMode: false,
    })
    expect(cfg.basePromptClothing).toContain('{item}')
  })

  it('merges a saved patch over the defaults', async () => {
    const res = await app.request('/api/config', json({ imageModel: 'openai/dall-e-3' }))
    expect(res.status).toBe(200)
    expect((await res.json() as any).config).toMatchObject({ imageModel: 'openai/dall-e-3', landingDemoMode: false })
    expect((await (await app.request('/api/config')).json() as any).imageModel).toBe('openai/dall-e-3')
  })

  // A pre-provider config.json holds a bare, unqualified OpenAI image model. It has to keep
  // working across the upgrade — silently reverting someone's chosen model to the default
  // would be invisible until their next (billed) generation came back looking wrong.
  it('reads a legacy unqualified `model` forward into imageModel', async () => {
    writeFileSync(ws.configPath, JSON.stringify({ model: 'dall-e-2' }))
    const cfg = await (await app.request('/api/config')).json() as any
    expect(cfg.imageModel).toBe('openai/dall-e-2')
    expect(cfg.model).toBeUndefined()
  })

  it('rejects a provider route outside the known set, and a malformed model ID', async () => {
    rmSync(ws.configPath, { force: true })   // config.json survives beforeEach — start from defaults

    // The security-relevant half: this route is unauthenticated, so an arbitrary provider
    // value must never reach the resolver — a URL here would redirect billed calls, and the
    // API key with them.
    for (const bad of ['https://evil.example/v1', 'nonsense', '']) {
      const res = await app.request('/api/config', json({ provider: bad }))
      expect(res.status).toBe(400)
    }
    const malformed = await app.request('/api/config', json({ imageModel: 'gpt-image-1' }))
    expect(malformed.status).toBe(400)
    expect((await malformed.json() as any).error).toContain('<provider>/<name>')

    // and none of it was persisted
    const cfg = await (await app.request('/api/config')).json() as any
    expect(cfg.provider).toBe('direct')
    expect(cfg.imageModel).toBe('openai/gpt-image-1')
  })

  it('reports which keys are configured without disclosing them', async () => {
    process.env.ANTHROPIC_API_KEY = 'super-secret-value'
    delete process.env.OPENAI_API_KEY

    const settings = await (await app.request('/api/settings')).json() as any
    expect(settings).toMatchObject({ anthropicKey: true, openaiKey: false })
    expect(settings.catalogPath).toBe(ws.catalog)
    expect(JSON.stringify(settings)).not.toContain('super-secret-value')

    delete process.env.ANTHROPIC_API_KEY
  })

  // SHOW_BRAND isn't set anywhere in this file's env, so this is the off/default case —
  // see show-brand.test.ts for the SHOW_BRAND=true side (its own process; the flag is read
  // once at module scope, before any test runs).
  it('reports showBrand as false when SHOW_BRAND is unset', async () => {
    const settings = await (await app.request('/api/settings')).json() as any
    expect(settings.showBrand).toBe(false)
  })
})

// A container can't remount its own bind mounts, so POST /settings/host-paths only ever
// stages CATALOG_HOST_PATH/IMAGES_HOST_PATH into .env for the *next* recreate — it must
// never touch the live process.env (that's what "active" reports), and it must never
// clobber anything else already in .env.
describe('POST /api/settings/host-paths', () => {
  const envPath = join(ws.root, '.env')

  beforeEach(() => {
    rmSync(envPath, { force: true })
    delete process.env.CATALOG_HOST_PATH
    delete process.env.IMAGES_HOST_PATH
  })

  it('reports empty active/configured paths and no pending restart when nothing is set', async () => {
    const settings = await (await app.request('/api/settings')).json() as any
    expect(settings).toMatchObject({
      catalogHostPathActive: '', imagesHostPathActive: '',
      catalogHostPathConfigured: '', imagesHostPathConfigured: '',
      restartRequired: false,
    })
  })

  it('stages a new path without touching the live process env, and flags a restart as required', async () => {
    const res = await app.request('/api/settings/host-paths', json({
      catalogHostPath: '../wismo/apps/agent/data/catalog',
      imagesHostPath:  '../wismo/apps/storefront/public/products',
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      catalogHostPathConfigured: '../wismo/apps/agent/data/catalog',
      imagesHostPathConfigured:  '../wismo/apps/storefront/public/products',
      restartRequired: true,
    })
    expect(process.env.CATALOG_HOST_PATH).toBeUndefined()

    const settings = await (await app.request('/api/settings')).json() as any
    expect(settings.catalogHostPathConfigured).toBe('../wismo/apps/agent/data/catalog')
    expect(settings.catalogHostPathActive).toBe('')   // still whatever this container was started with
    expect(settings.restartRequired).toBe(true)
  })

  it('stops flagging a restart once the container has actually picked up the configured value', async () => {
    await app.request('/api/settings/host-paths', json({ catalogHostPath: '../greeter/catalog/fixtures' }))
    process.env.CATALOG_HOST_PATH = '../greeter/catalog/fixtures'   // stands in for a real recreate
    const settings = await (await app.request('/api/settings')).json() as any
    expect(settings.restartRequired).toBe(false)
  })

  it('resets to the project default with an empty string', async () => {
    await app.request('/api/settings/host-paths', json({ catalogHostPath: '../greeter/catalog/fixtures' }))
    const res = await app.request('/api/settings/host-paths', json({ catalogHostPath: '' }))
    expect((await res.json() as any).catalogHostPathConfigured).toBe('')
  })

  it('rejects a value containing a newline instead of writing a corrupt line into .env', async () => {
    const res = await app.request('/api/settings/host-paths', json({ catalogHostPath: 'x\nPORT=9999' }))
    expect(res.status).toBe(400)
    const settings = await (await app.request('/api/settings')).json() as any
    expect(settings.catalogHostPathConfigured).toBe('')
  })

  it('rewrites only the given key, leaving other .env content untouched', async () => {
    writeFileSync(envPath, 'ANTHROPIC_API_KEY=super-secret\nCATALOG_HOST_PATH=../old/catalog\n# a comment\nPORT=3004\n')
    await app.request('/api/settings/host-paths', json({ imagesHostPath: '../new/images' }))
    const text = readFileSync(envPath, 'utf-8')
    expect(text).toContain('ANTHROPIC_API_KEY=super-secret')
    expect(text).toContain('CATALOG_HOST_PATH=../old/catalog')
    expect(text).toContain('# a comment')
    expect(text).toContain('PORT=3004')
    expect(text).toContain('IMAGES_HOST_PATH=../new/images')
  })
})

// The catalog API is the read surface remote consumers use.
describe('GET /catalog', () => {
  beforeEach(() => {
    writeFixtureFile(ws, 'algolia-pants.json', [
      item({ objectID: 'pants-001', style: 'smart-casual', tags: ['wide-leg'], images: ['/images/pants-001.jpg'] }),
      item({ objectID: 'pants-002', style: 'casual', tags: ['coastal'] }),
    ])
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', style: 'modern', tags: [] })])
    writeManifest(ws, ['pants-001'])
  })

  it('returns every item, enriched, with a total', async () => {
    const body = await (await app.request('/catalog')).json() as any
    expect(body).toMatchObject({ nbHits: 3, offset: 0, limit: 20 })
    expect(body.hits.map((h: any) => h.objectID)).toEqual(['pants-001', 'pants-002', 'tile-001'])
    expect(body.hits[0]).toMatchObject({ hasImage: true, isAIGenerated: true })
  })

  it('filters by category and by site', async () => {
    let body = await (await app.request('/catalog?category=tile')).json() as any
    expect(body.hits.map((h: any) => h.objectID)).toEqual(['tile-001'])

    body = await (await app.request('/catalog?site=clothing')).json() as any
    expect(body.nbHits).toBe(2)

    body = await (await app.request('/catalog?site=home&category=tile')).json() as any
    expect(body.nbHits).toBe(1)
  })

  it('merges a category name shared by two sites unless ?site disambiguates', async () => {
    // Start clean: once the name collides, both fixtures are site-prefixed and the flat
    // one no longer exists (the add-category route renames it).
    for (const f of readdirSync(ws.catalog)) rmSync(join(ws.catalog, f), { force: true })
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-clothing-pants.json', [item({ objectID: 'pants-100' })])
    writeFixtureFile(ws, 'algolia-home-pants.json', [item({ objectID: 'pants-200' })])

    let body = await (await app.request('/catalog?category=pants')).json() as any
    expect(body.hits.map((h: any) => h.objectID)).toEqual(['pants-100', 'pants-200'])

    body = await (await app.request('/catalog?site=home&category=pants')).json() as any
    expect(body.hits.map((h: any) => h.objectID)).toEqual(['pants-200'])
  })

  it('matches style against either the style field or the tags', async () => {
    let body = await (await app.request('/catalog?style=casual')).json() as any
    expect(body.hits.map((h: any) => h.objectID)).toEqual(['pants-002'])

    body = await (await app.request('/catalog?style=wide-leg')).json() as any
    expect(body.hits.map((h: any) => h.objectID)).toEqual(['pants-001'])
  })

  it('pages with limit and offset, reporting the unpaged total', async () => {
    const body = await (await app.request('/catalog?limit=2&offset=1')).json() as any
    expect(body).toMatchObject({ nbHits: 3, offset: 1, limit: 2 })
    expect(body.hits.map((h: any) => h.objectID)).toEqual(['pants-002', 'tile-001'])
  })

  it('returns an empty page for a filter that matches nothing', async () => {
    const body = await (await app.request('/catalog?category=nope')).json() as any
    expect(body).toMatchObject({ hits: [], nbHits: 0 })
  })
})

describe('GET /catalog/:objectID', () => {
  beforeEach(() => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', name: 'Zellige' })])
  })

  it('returns the enriched item', async () => {
    const body = await (await app.request('/catalog/tile-001')).json() as any
    expect(body).toMatchObject({ objectID: 'tile-001', name: 'Zellige', hasImage: false })
    expect(body.imagePrompt).toBeTruthy()
  })

  it('404s an unknown objectID', async () => {
    const res = await app.request('/catalog/ghost-001')
    expect(res.status).toBe(404)
    expect(await res.json() as any).toEqual({ error: 'Not found' })
  })
})

describe('/catalog with no STUDIO_API_TOKEN configured', () => {
  it('is open — reachability is what protects it in that configuration', async () => {
    expect((await app.request('/catalog')).status).toBe(200)
    expect((await app.request('/catalog', { headers: { Authorization: 'Bearer anything' } })).status).toBe(200)
  })

  // The token is optional, so it can't be the only thing guarding the mutating routes
  // /catalog shares with /api. Without the same-origin check, a page the user happens to
  // have open could POST /catalog/:id/generate as a no-preflight "simple" request and
  // spend the operator's provider credit overwriting product images. Mirrors the /api
  // case in auth.test.ts.
  it('still applies the same-origin check to the mutating routes', async () => {
    const evil = { Origin: 'https://evil.example' }
    for (const [method, path] of [['POST', '/catalog/tile-001/generate'], ['DELETE', '/catalog/tile-001/image']]) {
      const res = await app.request(path, noBody(method, { headers: evil }))
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(await res.json() as any).toEqual({ error: 'Cross-origin request rejected' })
    }
  })

  it('leaves reads and Origin-less callers alone', async () => {
    // GET is never a CSRF write, and a non-browser consumer sends no Origin at all.
    expect((await app.request('/catalog', { headers: { Origin: 'https://evil.example' } })).status).toBe(200)
    expect((await app.request('/catalog/tile-001/image', { method: 'DELETE' })).status).not.toBe(403)
  })
})
