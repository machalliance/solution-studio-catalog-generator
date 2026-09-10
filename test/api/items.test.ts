import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile, readFixtureFile,
  writeManifest, readManifest, writeImage, imageExists, item, json, noBody,
} from '../helpers/workspace.ts'

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

beforeEach(() => {
  for (const f of readdirSync(ws.catalog)) rmSync(join(ws.catalog, f), { force: true })
  for (const f of readdirSync(ws.images)) rmSync(join(ws.images, f), { force: true })
  writeSites(ws, [
    { id: 'clothing', categories: ['pants', 'shoes'] },
    { id: 'home', categories: ['tile'] },
  ])
})

afterAll(() => destroyWorkspace(ws))

describe('GET /api/items', () => {
  it('groups items by site and category, enriched', async () => {
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-001', images: ['/images/pants-001.jpg'] })])
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
    writeManifest(ws, ['pants-001'])

    const groups = await (await app.request('/api/items')).json() as any
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ skin: 'clothing', category: 'pants' })
    expect(groups[0].items[0]).toMatchObject({ objectID: 'pants-001', hasImage: true, isAIGenerated: true })
    expect(groups[1]).toMatchObject({ skin: 'home', category: 'tile' })
    expect(groups[1].items[0]).toMatchObject({ hasImage: false, isAIGenerated: false })
  })

  it('omits categories that have no fixture at all', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item()])
    const groups = await (await app.request('/api/items')).json() as any
    expect(groups.map((g: any) => g.category)).toEqual(['tile'])
  })
})

describe('POST /api/items', () => {
  it('creates an item with a generated objectID and no image', async () => {
    const res = await app.request('/api/items', json({
      site: 'home', category: 'tile', name: 'Zellige Square', brand: 'Clé',
      price: '12.50', tags: 'matte, handmade', colourHex: '#e8e2d5', description: 'Nice.',
    }))
    expect(res.status).toBe(201)
    const { item: created } = await res.json() as any
    expect(created).toMatchObject({
      objectID: 'tile-001', name: 'Zellige Square', brand: 'Clé', price: 12.5,
      currency: 'USD', category: 'tile', fit: 'unisex', tags: ['matte', 'handmade'],
      colourHex: '#e8e2d5', images: [], url: '/products/zellige-square', inStock: true,
      hasImage: false, isAIGenerated: false,
    })
    expect(readFixtureFile(ws, 'algolia-tile.json')).toMatchObject({ nbHits: 1 })
  })

  it('numbers subsequent items sequentially', async () => {
    await app.request('/api/items', json({ site: 'home', category: 'tile', name: 'One' }))
    const res = await app.request('/api/items', json({ site: 'home', category: 'tile', name: 'Two' }))
    expect((await res.json() as any).item.objectID).toBe('tile-002')
  })

  it('requires site, category and name', async () => {
    for (const body of [
      { category: 'tile', name: 'x' }, { site: 'home', name: 'x' }, { site: 'home', category: 'tile' },
    ]) {
      const res = await app.request('/api/items', json(body))
      expect(res.status).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'site, category, and name required' })
    }
  })

  it('rejects an unknown site or a category that site does not own', async () => {
    let res = await app.request('/api/items', json({ site: 'nope', category: 'tile', name: 'x' }))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/Unknown site/)

    // 'tile' exists, but belongs to home — not clothing
    res = await app.request('/api/items', json({ site: 'clothing', category: 'tile', name: 'x' }))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/Unknown category/)
  })

  it('rejects a non-numeric price instead of storing NaN', async () => {
    const res = await app.request('/api/items', json({ site: 'home', category: 'tile', name: 'x', price: 'free' }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'price must be a number' })
    expect(readdirSync(ws.catalog)).toEqual([])
  })

  it('defaults an omitted price to 0', async () => {
    const res = await app.request('/api/items', json({ site: 'home', category: 'tile', name: 'x' }))
    expect((await res.json() as any).item.price).toBe(0)
  })
})

describe('DELETE /api/items', () => {
  beforeEach(() => {
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-001' }), item({ objectID: 'pants-002' })])
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
  })

  it('removes items across every category and reports the count', async () => {
    const res = await app.request('/api/items', json({ objectIDs: ['pants-001', 'tile-001'] }, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toEqual({ ok: true, removed: 2 })
    expect(readFixtureFile(ws, 'algolia-pants.json')).toMatchObject({ nbHits: 1 })
    expect(readFixtureFile(ws, 'algolia-tile.json')).toMatchObject({ nbHits: 0, hits: [] })
  })

  it('requires a non-empty objectIDs array', async () => {
    for (const body of [{}, { objectIDs: [] }, { objectIDs: 'pants-001' }]) {
      const res = await app.request('/api/items', json(body, { method: 'DELETE' }))
      expect(res.status).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'objectIDs array required' })
    }
  })

  it('reports zero and rewrites nothing for ids that do not exist', async () => {
    const res = await app.request('/api/items', json({ objectIDs: ['ghost-001'] }, { method: 'DELETE' }))
    expect(await res.json() as any).toEqual({ ok: true, removed: 0 })
    expect(readFixtureFile(ws, 'algolia-pants.json').hits).toHaveLength(2)
  })
})

describe('PATCH /api/:objectID/*', () => {
  beforeEach(() => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', name: 'Old', brand: 'B', price: 5 })])
  })

  it('sets a custom image prompt', async () => {
    const res = await app.request('/api/tile-001/prompt', json({ imagePrompt: 'a zellige tile' }, { method: 'PATCH' }))
    expect(res.status).toBe(200)
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].imagePrompt).toBe('a zellige tile')
  })

  it('sets a description', async () => {
    await app.request('/api/tile-001/description', json({ description: 'Handmade.' }, { method: 'PATCH' }))
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].description).toBe('Handmade.')
  })

  it('replaces tags, accepting either a list or a comma string', async () => {
    let res = await app.request('/api/tile-001/tags', json({ tags: ' matte , handmade ' }, { method: 'PATCH' }))
    expect(await res.json() as any).toEqual({ ok: true, tags: ['matte', 'handmade'] })

    res = await app.request('/api/tile-001/tags', json({ tags: ['glossy'] }, { method: 'PATCH' }))
    expect(await res.json() as any).toEqual({ ok: true, tags: ['glossy'] })
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].tags).toEqual(['glossy'])
  })

  it('updates metadata, leaving omitted fields alone', async () => {
    const res = await app.request('/api/tile-001/meta', json({ name: 'New', price: '9.99' }, { method: 'PATCH' }))
    expect(res.status).toBe(200)
    const stored = readFixtureFile(ws, 'algolia-tile.json').hits[0]
    expect(stored).toMatchObject({ name: 'New', price: 9.99, brand: 'B', currency: 'USD' })
  })

  it('applies the currency and fit fallbacks when they are sent empty', async () => {
    await app.request('/api/tile-001/meta', json({ name: 'N', currency: '', fit: '' }, { method: 'PATCH' }))
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0]).toMatchObject({ currency: 'USD', fit: 'unisex' })
  })

  it('requires a name and rejects a non-numeric price', async () => {
    let res = await app.request('/api/tile-001/meta', json({ price: 1 }, { method: 'PATCH' }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'name required' })

    res = await app.request('/api/tile-001/meta', json({ name: 'N', price: 'free' }, { method: 'PATCH' }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'price must be a number' })
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].name).toBe('Old')
  })

  it('404s every patch route on an unknown objectID', async () => {
    for (const path of ['prompt', 'description', 'tags', 'meta']) {
      const res = await app.request(`/api/ghost-001/${path}`, json({ name: 'x' }, { method: 'PATCH' }))
      expect(res.status, path).toBe(404)
    }
  })
})

describe('DELETE /api/:objectID/image', () => {
  it('clears images, deletes the local file and drops the manifest entry', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', images: ['/images/tile-001.jpg'] })])
    writeManifest(ws, ['tile-001', 'tile-002'])
    await writeImage(ws, 'tile-001.jpg')

    const res = await app.request('/api/tile-001/image', noBody('DELETE'))
    expect(res.status).toBe(200)
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].images).toEqual([])
    expect(imageExists(ws, 'tile-001.jpg')).toBe(false)
    expect(readManifest(ws)).toEqual(['tile-002'])
  })

  it('still clears the reference when the item points at an external image', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', images: ['https://cdn.example/x.jpg'] })])
    const res = await app.request('/api/tile-001/image', noBody('DELETE'))
    expect(res.status).toBe(200)
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].images).toEqual([])
  })

  it('404s on an unknown objectID', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
    expect((await app.request('/api/ghost-001/image', noBody('DELETE'))).status).toBe(404)
  })
})

describe('POST /api/:objectID/tweak/accept|discard', () => {
  beforeEach(() => writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })]))

  it('promotes the pending tweak over the original and records it as generated', async () => {
    await writeImage(ws, 'tile-001.jpg')
    await writeImage(ws, 'tile-001-tweak.jpg')
    writeManifest(ws, [])

    const res = await app.request('/api/tile-001/tweak/accept', json({}))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toEqual({ ok: true, imageUrl: '/images/tile-001.jpg' })
    expect(imageExists(ws, 'tile-001-tweak.jpg')).toBe(false)
    expect(imageExists(ws, 'tile-001.jpg')).toBe(true)
    expect(readManifest(ws)).toEqual(['tile-001'])
  })

  it('404s accept when there is no pending tweak', async () => {
    const res = await app.request('/api/tile-001/tweak/accept', json({}))
    expect(res.status).toBe(404)
    expect(await res.json() as any).toEqual({ error: 'No pending tweak for this item' })
  })

  it('discards the candidate and leaves the original in place', async () => {
    await writeImage(ws, 'tile-001.jpg')
    await writeImage(ws, 'tile-001-tweak.jpg')

    const res = await app.request('/api/tile-001/tweak/discard', json({}))
    expect(res.status).toBe(200)
    expect(imageExists(ws, 'tile-001-tweak.jpg')).toBe(false)
    expect(imageExists(ws, 'tile-001.jpg')).toBe(true)
  })

  it('treats discarding a non-existent tweak as a no-op success', async () => {
    expect((await app.request('/api/tile-001/tweak/discard', json({}))).status).toBe(200)
  })

  // Regression for the audit finding: objectID reached the filesystem unsanitized here,
  // unlike every other route that puts one on disk. Hono URL-decodes path params, so a
  // %2e%2e%2f-encoded objectID could rename/delete a file outside data/images entirely.
  it('sanitizes the objectID before touching the filesystem, blocking traversal', async () => {
    const canaryPath = join(ws.images, '..', 'canary-tweak.jpg')
    await writeImage(ws, '../canary-tweak.jpg')
    expect(existsSync(canaryPath)).toBe(true)

    const res = await app.request('/api/%2e%2e%2fcanary/tweak/discard', json({}))
    expect(res.status).toBe(200)
    expect(existsSync(canaryPath)).toBe(true) // untouched — sanitizeId stripped the traversal
  })
})

describe('POST /api/items/batch', () => {
  // SHOW_BRAND is off in this file's env — the shipped default. Batch is the route the
  // generated items come back through, so it is the last place a real trademark the model
  // volunteered can be stopped before it reaches disk and, from there, the description and
  // image prompts. See show-brand.test.ts for the SHOW_BRAND=true side.
  it('does not persist a brand when SHOW_BRAND is off', async () => {
    const res = await app.request('/api/items/batch', json({
      site: 'clothing',
      items: [{ category: 'pants', name: 'Wide Leg', brand: "Levi's", price: 120 }],
    }))
    expect(res.status).toBe(200)
    const stored = readFixtureFile(ws, 'algolia-pants.json').hits[0]
    expect(stored.name).toBe('Wide Leg')
    expect(stored).not.toHaveProperty('brand')
  })

  it('adds every valid item and reports the ids it assigned', async () => {
    const res = await app.request('/api/items/batch', json({
      site: 'clothing',
      items: [
        { category: 'pants', name: 'Wide Leg', price: 120, tags: ['wide-leg'] },
        { category: 'shoes', name: 'Derby', price: '95' },
      ],
    }))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toEqual({ ok: true, added: 2, objectIDs: ['pants-001', 'shoes-001'] })
    expect(readFixtureFile(ws, 'algolia-pants.json').hits[0]).toMatchObject({
      name: 'Wide Leg', price: 120, images: [], url: '/products/wide-leg', currency: 'USD',
    })
    expect(readFixtureFile(ws, 'algolia-shoes.json').hits[0].price).toBe(95)
  })

  it('skips items whose category the site does not own, keeping the rest', async () => {
    const res = await app.request('/api/items/batch', json({
      site: 'clothing',
      items: [
        { category: 'tile', name: 'Wrong site' },
        { name: 'No category' },
        { category: 'pants', name: 'Good' },
      ],
    }))
    expect(await res.json() as any).toEqual({ ok: true, added: 1, objectIDs: ['pants-001'] })
  })

  it('skips an item with an invalid price rather than failing the whole batch', async () => {
    const res = await app.request('/api/items/batch', json({
      site: 'clothing',
      items: [{ category: 'pants', name: 'Bad', price: 'free' }, { category: 'pants', name: 'Good', price: 10 }],
    }))
    expect(await res.json() as any).toEqual({ ok: true, added: 1, objectIDs: ['pants-001'] })
    expect(readFixtureFile(ws, 'algolia-pants.json').hits[0].name).toBe('Good')
  })

  it('adopts a pending image, renaming it to the assigned objectID', async () => {
    await writeImage(ws, 'pending-abc123.jpg')
    const res = await app.request('/api/items/batch', json({
      site: 'clothing',
      items: [{ _id: 'abc123', category: 'pants', name: 'With Image' }],
    }))
    expect(res.status).toBe(200)
    expect(imageExists(ws, 'pending-abc123.jpg')).toBe(false)
    expect(imageExists(ws, 'pants-001.jpg')).toBe(true)
    expect(readFixtureFile(ws, 'algolia-pants.json').hits[0].images).toEqual(['/images/pants-001.jpg'])
    expect(readManifest(ws)).toEqual(['pants-001'])
  })

  it('claims no image when the pending file was never generated', async () => {
    await app.request('/api/items/batch', json({
      site: 'clothing', items: [{ _id: 'never-generated', category: 'pants', name: 'No Image' }],
    }))
    expect(readFixtureFile(ws, 'algolia-pants.json').hits[0].images).toEqual([])
    expect(readManifest(ws)).toEqual([])
  })

  it('sanitizes a traversing _id rather than reading outside the images directory', async () => {
    await writeImage(ws, 'pending-etcpasswd.jpg')
    await app.request('/api/items/batch', json({
      site: 'clothing', items: [{ _id: '../../etc/passwd', category: 'pants', name: 'Sneaky' }],
    }))
    // the sanitized name is what gets looked up, so the traversal resolves to a plain
    // filename inside data/images and nothing escapes
    expect(imageExists(ws, 'pants-001.jpg')).toBe(true)
    expect(imageExists(ws, 'pending-etcpasswd.jpg')).toBe(false)
  })

  it('requires a site and a non-empty items array', async () => {
    let res = await app.request('/api/items/batch', json({ items: [{}] }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'site required' })

    res = await app.request('/api/items/batch', json({ site: 'clothing', items: [] }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'items array required' })

    res = await app.request('/api/items/batch', json({ site: 'nope', items: [{ category: 'pants', name: 'x' }] }))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/Unknown site/)
  })
})
