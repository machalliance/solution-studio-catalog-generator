import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
    expect(cfg).toMatchObject({ model: 'gpt-image-1', landingDemoMode: false })
    expect(cfg.basePromptClothing).toContain('{item}')
  })

  it('merges a saved patch over the defaults', async () => {
    const res = await app.request('/api/config', json({ model: 'dall-e-3' }))
    expect(res.status).toBe(200)
    expect((await res.json() as any).config).toMatchObject({ model: 'dall-e-3', landingDemoMode: false })
    expect((await (await app.request('/api/config')).json() as any).model).toBe('dall-e-3')
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
})

// The catalog API is the read surface remote consumers (e.g. Greeter) use.
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
})
