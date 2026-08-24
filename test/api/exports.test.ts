import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile,
  writeImage, item, json, noBody,
} from '../helpers/workspace.ts'

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

beforeEach(() => {
  for (const dir of [ws.catalog, ws.images, ws.exports]) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
  }
  writeSites(ws, [
    { id: 'clothing', categories: ['pants', 'shoes'] },
    { id: 'home', categories: ['tile'] },
  ])
})

afterAll(() => destroyWorkspace(ws))

const passthrough = (source: string, target: string) =>
  ({ source, target, transform: 'passthrough' as const, include: true })

async function createMap(over: Record<string, any> = {}) {
  const res = await app.request('/api/exports', json({
    name: 'My Map', description: 'test map',
    fields: [passthrough('objectID', 'id'), passthrough('name', 'title')],
    ...over,
  }))
  return (await res.json() as any).map
}

describe('GET /api/exports/templates', () => {
  it('lists the built-ins as metadata only', async () => {
    const templates = await (await app.request('/api/exports/templates')).json() as any
    expect(templates.map((t: any) => t.key)).toEqual(['algolia-bigcommerce-v2', 'coveo-commerce-v1'])
    for (const t of templates) {
      expect(Object.keys(t).sort()).toEqual(['description', 'key', 'name'])
    }
  })
})

describe('POST /api/exports/templates/:key', () => {
  it('instantiates a ready-to-use saved map with no LLM involved', async () => {
    const res = await app.request('/api/exports/templates/algolia-bigcommerce-v2', json({}))
    expect(res.status).toBe(201)
    const { map } = await res.json() as any
    expect(map.id).toMatch(/^algolia-bigcommerce-v2-[a-z0-9]{1,4}$/)
    expect(map.name).toBe('Algolia Search with BigCommerce Integration')
    expect(map.fields.length).toBeGreaterThan(10)
    expect(map.targetSchema.referenceUrl).toContain('algolia.com')
    expect(existsSync(join(ws.exports, `${map.id}.json`))).toBe(true)
  })

  it('404s an unknown template key', async () => {
    const res = await app.request('/api/exports/templates/nope', json({}))
    expect(res.status).toBe(404)
    expect(await res.json() as any).toEqual({ error: 'Template not found' })
  })

  it('does not hand out a reference to the template that later edits could mutate', async () => {
    const a = (await (await app.request('/api/exports/templates/coveo-commerce-v1', json({}))).json() as any).map
    a.fields[0].target = 'MUTATED'
    await app.request(`/api/exports/${a.id}`, json(a, { method: 'PUT' }))

    const b = (await (await app.request('/api/exports/templates/coveo-commerce-v1', json({}))).json() as any).map
    expect(b.fields[0].target).toBe('documentId')
  })
})

describe('POST /api/exports', () => {
  it('creates a map, deriving the id from the name', async () => {
    const map = await createMap({ name: 'Shopify Feed' })
    expect(map.id).toBe('shopify-feed')
    expect(map).toMatchObject({ name: 'Shopify Feed', format: 'json-array' })
    expect(map.created).toBe(map.updated)
    expect(existsSync(join(ws.exports, 'shopify-feed.json'))).toBe(true)
  })

  it('requires a name', async () => {
    const res = await app.request('/api/exports', json({ fields: [] }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'name required' })
  })

  it('rejects an id that sanitizes away to nothing', async () => {
    const res = await app.request('/api/exports', json({ name: 'X', id: '../..' }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'invalid id' })
  })

  // The id goes straight into a filename, so this is the choke point that has to stop a
  // create from writing a .json anywhere outside data/exports.
  it('sanitizes a traversing id rather than writing outside the exports directory', async () => {
    const map = await createMap({ name: 'X', id: '../../src/products/sites' })
    expect(map.id).toBe('srcproductssites')
    expect(readdirSync(ws.exports)).toEqual(['srcproductssites.json'])
    // sites.json itself is untouched
    expect(JSON.parse(readFileSync(ws.sitesPath, 'utf-8'))[0].id).toBe('clothing')
  })

  it('strips derived schema fields before persisting', async () => {
    const map = await createMap({
      name: 'Y',
      targetSchema: { systemName: 'Algolia', raw: '{}', fields: ['a'], sample: { a: 1 }, tree: {} },
    })
    expect(map.targetSchema).toEqual({ systemName: 'Algolia', raw: '{}' })
  })
})

describe('PUT /api/exports/:id', () => {
  it('merges the update and refreshes the timestamp', async () => {
    const map = await createMap({ name: 'Editable' })
    const res = await app.request(`/api/exports/${map.id}`, json({
      description: 'now with feeling',
      fields: [passthrough('brand', 'vendor')],
      siteBaseUrl: 'https://store.example',
    }, { method: 'PUT' }))

    expect(res.status).toBe(200)
    const updated = (await res.json() as any).map
    expect(updated).toMatchObject({
      id: 'editable', name: 'Editable', description: 'now with feeling',
      siteBaseUrl: 'https://store.example',
    })
    expect(updated.fields).toEqual([passthrough('brand', 'vendor')])
    expect(updated.created).toBe(map.created)
  })

  it('will not let the body change the id out from under the path', async () => {
    const map = await createMap({ name: 'Fixed' })
    const res = await app.request(`/api/exports/${map.id}`, json({ id: 'somewhere-else' }, { method: 'PUT' }))
    expect((await res.json() as any).map.id).toBe('fixed')
    expect(readdirSync(ws.exports)).toEqual(['fixed.json'])
  })

  it('404s an unknown map', async () => {
    const res = await app.request('/api/exports/nope', json({ name: 'x' }, { method: 'PUT' }))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/exports/:id', () => {
  it('removes the map', async () => {
    const map = await createMap()
    expect((await app.request(`/api/exports/${map.id}`, noBody('DELETE'))).status).toBe(200)
    expect(readdirSync(ws.exports)).toEqual([])
  })

  it('404s an unknown map', async () => {
    expect((await app.request('/api/exports/nope', noBody('DELETE'))).status).toBe(404)
  })

  it('cannot unlink a file outside the exports directory', async () => {
    const outside = join(ws.root, 'data', 'victim.json')
    writeFileSync(outside, '{}')
    const res = await app.request('/api/exports/..%2Fvictim', noBody('DELETE'))
    expect(res.status).toBe(404)
    expect(existsSync(outside)).toBe(true)
  })
})

describe('GET /api/exports', () => {
  it('lists saved maps sorted by name', async () => {
    await createMap({ name: 'Zeta' })
    await createMap({ name: 'Alpha' })
    const maps = await (await app.request('/api/exports')).json() as any
    expect(maps.map((m: any) => m.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('returns an empty list when nothing is saved', async () => {
    expect(await (await app.request('/api/exports')).json() as any).toEqual([])
  })
})

describe('POST /api/exports/preview', () => {
  beforeEach(() => {
    writeFixtureFile(ws, 'algolia-tile.json', [
      item({ objectID: 'tile-001', name: 'First' }),
      item({ objectID: 'tile-002', name: 'Second' }),
    ])
  })

  it('transforms the requested item', async () => {
    const res = await app.request('/api/exports/preview', json({
      objectID: 'tile-002', fields: [passthrough('name', 'title')],
    }))
    expect(await res.json() as any).toEqual({ ok: true, objectID: 'tile-002', result: { title: 'Second' } })
  })

  it('falls back to the first catalog item when no objectID is given', async () => {
    const res = await app.request('/api/exports/preview', json({ fields: [passthrough('name', 'title')] }))
    expect(await res.json() as any).toMatchObject({ objectID: 'tile-001', result: { title: 'First' } })
  })

  it('shows the custom_fields[] grouping so it can be checked before saving', async () => {
    const res = await app.request('/api/exports/preview', json({
      objectID: 'tile-001',
      fields: [
        { source: 'style', target: 'custom_fields[].text', transform: 'passthrough', include: true },
        { source: 'fit', target: 'custom_fields[].text', transform: 'passthrough', include: true },
      ],
    }))
    expect((await res.json() as any).result).toEqual({
      custom_fields: [{ name: 'style', text: 'smart-casual' }, { name: 'fit', text: 'unisex' }],
    })
  })

  it('honours the per-map image base', async () => {
    const res = await app.request('/api/exports/preview', json({
      objectID: 'tile-001',
      fields: [{ source: 'images', target: 'image_url', transform: 'image-url', include: true }],
      imageExportBase: 'https://cdn.example/i',
    }))
    // tile-001 has no picture, so there is nothing honest to build a URL from
    expect((await res.json() as any).result).toEqual({ image_url: null })
  })

  it('requires a non-empty fields array', async () => {
    for (const body of [{}, { fields: [] }]) {
      const res = await app.request('/api/exports/preview', json(body))
      expect(res.status).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'fields required' })
    }
  })
})

describe('POST /api/exports/:id/run', () => {
  beforeEach(() => {
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-001' })])
    writeFixtureFile(ws, 'algolia-shoes.json', [item({ objectID: 'shoes-001' })])
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
  })

  it('runs across the whole catalog when nothing is scoped', async () => {
    const map = await createMap()
    const rows = await (await app.request(`/api/exports/${map.id}/run`, json({}))).json() as any
    expect(rows.map((r: any) => r.id)).toEqual(['pants-001', 'shoes-001', 'tile-001'])
  })

  it('scopes to one site', async () => {
    const map = await createMap()
    const rows = await (await app.request(`/api/exports/${map.id}/run`, json({ site: 'clothing' }))).json() as any
    expect(rows.map((r: any) => r.id)).toEqual(['pants-001', 'shoes-001'])
  })

  it('scopes to named categories', async () => {
    const map = await createMap()
    const rows = await (await app.request(`/api/exports/${map.id}/run`, json({ categories: ['shoes', 'tile'] }))).json() as any
    expect(rows.map((r: any) => r.id)).toEqual(['shoes-001', 'tile-001'])
  })

  // "no categories key" and "an explicitly empty list" are different intents — the second
  // is the UI's "None" selection and must produce zero rows, not every row.
  it('distinguishes an explicit empty category list from no filter at all', async () => {
    const map = await createMap()
    const none = await (await app.request(`/api/exports/${map.id}/run`, json({ categories: [] }))).json() as any
    expect(none).toEqual([])
  })

  it('runs with no body at all', async () => {
    const map = await createMap()
    const res = await app.request(`/api/exports/${map.id}/run`, noBody('POST'))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toHaveLength(3)
  })

  it('404s an unknown map', async () => {
    expect((await app.request('/api/exports/nope/run', json({}))).status).toBe(404)
  })
})

describe('POST /api/exports/:id/download', () => {
  beforeEach(async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [
      item({ objectID: 'tile-001', images: ['/images/tile-001.jpg'] }),
      item({ objectID: 'tile-002', images: [] }),
    ])
    await writeImage(ws, 'tile-001.jpg')
  })

  // Reads the zip's central directory for entry names — enough to assert layout without
  // pulling in an unzip dependency just for the tests.
  function zipEntryNames(buf: Buffer): string[] {
    const names: string[] = []
    const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]) // central directory file header
    let i = buf.indexOf(sig)
    while (i !== -1) {
      const nameLen = buf.readUInt16LE(i + 28)
      names.push(buf.subarray(i + 46, i + 46 + nameLen).toString('utf-8'))
      i = buf.indexOf(sig, i + 1)
    }
    return names.sort()
  }

  async function download(mapId: string, body: unknown = {}): Promise<{ buf: Buffer; res: Response }> {
    const res = await app.request(`/api/exports/${mapId}/download`, json(body))
    return { res, buf: Buffer.from(await res.arrayBuffer()) }
  }

  it('returns a zip with the export JSON and the referenced image', async () => {
    const map = await createMap({ name: 'Bundle' })
    const { res, buf } = await download(map.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="bundle-export.zip"')
    // With no image base configured the JSON carries the bare filename, so the zip
    // mirrors it at the archive root — the two always agree.
    expect(zipEntryNames(buf)).toEqual(['bundle-export.json', 'tile-001.jpg'])
  })

  it('bundles the image at exactly the path the JSON references', async () => {
    const map = await createMap({ name: 'Agree' })
    await app.request(`/api/exports/${map.id}`, json({
      imageExportBase: 'media/img',
      fields: [{ source: 'images', target: 'image_url', transform: 'image-url', include: true }],
    }, { method: 'PUT' }))

    const rows = await (await app.request(`/api/exports/${map.id}/run`, json({}))).json() as any
    const referenced = rows.map((r: any) => r.image_url).filter(Boolean)
    expect(referenced).toEqual(['media/img/tile-001.jpg'])

    const { buf } = await download(map.id)
    for (const path of referenced) expect(zipEntryNames(buf)).toContain(path)
  })

  it('mirrors a relative image base as the in-zip path so extracted references still work', async () => {
    const map = await createMap({ name: 'Rel' })
    await app.request(`/api/exports/${map.id}`, json({ imageExportBase: 'assets/products' }, { method: 'PUT' }))
    const { buf } = await download(map.id)
    expect(zipEntryNames(buf)).toEqual(['assets/products/tile-001.jpg', 'rel-export.json'])
  })

  it('falls back to a flat images/ folder for an absolute-URL base', async () => {
    const map = await createMap({ name: 'Abs' })
    await app.request(`/api/exports/${map.id}`, json({ imageExportBase: 'https://cdn.example' }, { method: 'PUT' }))
    const { buf } = await download(map.id)
    expect(zipEntryNames(buf)).toEqual(['abs-export.json', 'images/tile-001.jpg'])
  })

  it('honours the site/category scope', async () => {
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-001' })])
    const map = await createMap({ name: 'Scoped' })
    const { buf } = await download(map.id, { site: 'clothing' })
    // clothing has no images, so only the JSON is bundled
    expect(zipEntryNames(buf)).toEqual(['scoped-export.json'])
  })

  it('404s an unknown map', async () => {
    const res = await app.request('/api/exports/nope/download', json({}))
    expect(res.status).toBe(404)
  })
})
