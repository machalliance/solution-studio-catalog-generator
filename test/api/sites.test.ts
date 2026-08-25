import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createWorkspace, destroyWorkspace, writeSites, readSites,
  writeFixtureFile, readFixtureFile, catalogFiles, item, json, noBody,
} from '../helpers/workspace.ts'

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

beforeEach(() => {
  for (const f of readdirSync(ws.catalog)) rmSync(join(ws.catalog, f), { force: true })
  rmSync(ws.sitesPath, { force: true })
})

afterAll(() => destroyWorkspace(ws))

describe('GET /api/sites', () => {
  it('falls back to the two seed verticals before sites.json exists', async () => {
    const res = await app.request('/api/sites')
    expect(res.status).toBe(200)
    const sites = await res.json() as any
    expect(sites.map((s: any) => s.id)).toEqual(['clothing', 'home'])
    expect(sites[0].categories).toContain('jacket')
    expect(sites[1].categories).toContain('vanity')
    expect(sites[0].basePrompt).toContain('{item}')
  })

  it('returns what sites.json holds once it exists', async () => {
    writeSites(ws, [{ id: 'garden', label: 'Garden', categories: ['planter'] }])
    const sites = await (await app.request('/api/sites')).json() as any
    expect(sites).toEqual([{ id: 'garden', label: 'Garden', categories: ['planter'], basePrompt: 'a photo of {item}' }])
  })
})

describe('POST /api/sites', () => {
  beforeEach(() => writeSites(ws, [{ id: 'home', categories: ['tile'] }]))

  it('creates a site with a slugified id and the trimmed label', async () => {
    const res = await app.request('/api/sites', json({ label: '  Outdoor Living  ' }))
    expect(res.status).toBe(201)
    const { site } = await res.json() as any
    expect(site).toMatchObject({ id: 'outdoor-living', label: 'Outdoor Living', categories: [] })
    expect(site.basePrompt).toContain('{item}')
    expect(readSites(ws).map(s => s.id)).toEqual(['home', 'outdoor-living'])
  })

  it('rejects a missing or blank label', async () => {
    for (const body of [{}, { label: '' }, { label: '   ' }, { label: null }]) {
      const res = await app.request('/api/sites', json(body))
      expect(res.status).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'label required' })
    }
  })

  it('rejects a label that slugifies to nothing', async () => {
    const res = await app.request('/api/sites', json({ label: '!!!' }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'invalid label' })
  })

  it('rejects a duplicate, including one reached by a different label spelling', async () => {
    const res = await app.request('/api/sites', json({ label: 'Home' }))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/already exists/)
    expect(readSites(ws)).toHaveLength(1)
  })
})

describe('PATCH /api/sites/:siteId', () => {
  beforeEach(() => writeSites(ws, [{ id: 'home', categories: ['tile'] }]))

  it('replaces the base prompt and persists it', async () => {
    const res = await app.request('/api/sites/home', json({ basePrompt: 'studio shot of {item}' }, { method: 'PATCH' }))
    expect(res.status).toBe(200)
    expect(readSites(ws)[0].basePrompt).toBe('studio shot of {item}')
  })

  it('accepts an empty prompt but rejects an absent one', async () => {
    expect((await app.request('/api/sites/home', json({ basePrompt: '' }, { method: 'PATCH' }))).status).toBe(200)
    const res = await app.request('/api/sites/home', json({}, { method: 'PATCH' }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'basePrompt required' })
  })

  it('404s on an unknown site', async () => {
    const res = await app.request('/api/sites/nope', json({ basePrompt: 'x' }, { method: 'PATCH' }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/sites/:siteId/categories', () => {
  beforeEach(() => writeSites(ws, [
    { id: 'clothing', categories: ['pants'] },
    { id: 'home', categories: ['tile'] },
  ]))

  it('adds a slugified category', async () => {
    const res = await app.request('/api/sites/home/categories', json({ name: '  Wall Tile  ' }))
    expect(res.status).toBe(201)
    expect((await res.json() as any).site.categories).toEqual(['tile', 'wall-tile'])
  })

  it('rejects a blank or unslugifiable name', async () => {
    expect((await app.request('/api/sites/home/categories', json({}))).status).toBe(400)
    expect((await app.request('/api/sites/home/categories', json({ name: '   ' }))).status).toBe(400)
    const res = await app.request('/api/sites/home/categories', json({ name: '???' }))
    expect(await res.json() as any).toEqual({ error: 'invalid category name' })
  })

  it('rejects a category the site already has', async () => {
    const res = await app.request('/api/sites/home/categories', json({ name: 'tile' }))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/already a category/)
  })

  it('404s on an unknown site', async () => {
    expect((await app.request('/api/sites/nope/categories', json({ name: 'x' }))).status).toBe(404)
  })

  // The rename is the whole point: until a second site adopts the name, the sole owner
  // keeps the legacy flat filename. The instant one does, that file has to move.
  it("migrates the existing owner's fixture to the site-prefixed name on first collision", async () => {
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-001' })])
    const res = await app.request('/api/sites/home/categories', json({ name: 'pants' }))
    expect(res.status).toBe(201)
    expect(catalogFiles(ws)).toEqual(['algolia-clothing-pants.json'])
    // and the data survived the move
    expect(readFixtureFile(ws, 'algolia-clothing-pants.json').hits[0].objectID).toBe('pants-001')
  })

  it('has nothing to migrate when the owner never had a fixture on disk', async () => {
    await app.request('/api/sites/home/categories', json({ name: 'pants' }))
    expect(catalogFiles(ws)).toEqual([])
  })

  it('leaves an already-prefixed fixture alone rather than clobbering it', async () => {
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-001' })])
    writeFixtureFile(ws, 'algolia-clothing-pants.json', [item({ objectID: 'pants-099' })])
    await app.request('/api/sites/home/categories', json({ name: 'pants' }))
    expect(catalogFiles(ws)).toEqual(['algolia-clothing-pants.json', 'algolia-pants.json'])
  })

  it('does not disturb an unrelated category when a different one collides', async () => {
    writeFixtureFile(ws, 'algolia-pants.json', [item()])
    writeFixtureFile(ws, 'algolia-tile.json', [item()])
    await app.request('/api/sites/home/categories', json({ name: 'pants' }))
    expect(catalogFiles(ws)).toContain('algolia-tile.json')
  })
})

describe('DELETE /api/sites/:siteId/categories/:cat', () => {
  beforeEach(() => writeSites(ws, [
    { id: 'clothing', categories: ['pants'] },
    { id: 'home', categories: ['tile'] },
  ]))

  it('removes the category and its (empty) fixture file', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [])
    const res = await app.request('/api/sites/home/categories/tile', noBody('DELETE'))
    expect(res.status).toBe(200)
    expect(readSites(ws).find(s => s.id === 'home').categories).toEqual([])
    expect(catalogFiles(ws)).toEqual([])
  })

  it('refuses to remove a category that still has products', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
    const res = await app.request('/api/sites/home/categories/tile', noBody('DELETE'))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/remove its products first/)
    expect(catalogFiles(ws)).toEqual(['algolia-tile.json'])
  })

  it('404s on an unknown site or category', async () => {
    expect((await app.request('/api/sites/nope/categories/tile', noBody('DELETE'))).status).toBe(404)
    expect((await app.request('/api/sites/home/categories/nope', noBody('DELETE'))).status).toBe(404)
  })

  // The reverse of the forward migration: dropping back to a single owner has to move
  // that owner's fixture back to the flat name, or fixtureFilename() starts pointing at
  // a file that doesn't exist and the data is orphaned.
  it("demigrates the remaining owner's fixture back to the flat filename", async () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-clothing-pants.json', [item({ objectID: 'pants-001' })])
    writeFixtureFile(ws, 'algolia-home-pants.json', [])

    const res = await app.request('/api/sites/home/categories/pants', noBody('DELETE'))
    expect(res.status).toBe(200)
    expect(catalogFiles(ws)).toEqual(['algolia-pants.json'])

    // and the surviving owner can still read its own data through the normal path
    const items = await (await app.request('/api/items')).json() as any
    expect(items).toEqual([{ skin: 'clothing', category: 'pants', items: [expect.objectContaining({ objectID: 'pants-001' })] }])
  })

  it('keeps the prefixed filenames when three sites drop to two', async () => {
    writeSites(ws, [
      { id: 'a', categories: ['pants'] }, { id: 'b', categories: ['pants'] }, { id: 'c', categories: ['pants'] },
    ])
    writeFixtureFile(ws, 'algolia-a-pants.json', [])
    writeFixtureFile(ws, 'algolia-b-pants.json', [])
    writeFixtureFile(ws, 'algolia-c-pants.json', [])
    await app.request('/api/sites/c/categories/pants', noBody('DELETE'))
    expect(catalogFiles(ws)).toEqual(['algolia-a-pants.json', 'algolia-b-pants.json'])
  })
})

describe('DELETE /api/sites/:siteId', () => {
  it('removes an empty site along with its empty fixtures', async () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['tile', 'faucet'] }])
    writeFixtureFile(ws, 'algolia-tile.json', [])
    writeFixtureFile(ws, 'algolia-pants.json', [item()])

    const res = await app.request('/api/sites/home', noBody('DELETE'))
    expect(res.status).toBe(200)
    expect((await res.json() as any).sites.map((s: any) => s.id)).toEqual(['clothing'])
    expect(catalogFiles(ws)).toEqual(['algolia-pants.json'])
  })

  it('refuses when any of its categories still has products', async () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['tile'] }])
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
    const res = await app.request('/api/sites/home', noBody('DELETE'))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/remove its products first/)
    expect(readSites(ws)).toHaveLength(2)
  })

  it('refuses to remove the last remaining site', async () => {
    writeSites(ws, [{ id: 'home', categories: [] }])
    const res = await app.request('/api/sites/home', noBody('DELETE'))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'At least one site must remain' })
  })

  it('404s on an unknown site', async () => {
    writeSites(ws, [{ id: 'home', categories: [] }, { id: 'clothing', categories: [] }])
    expect((await app.request('/api/sites/nope', noBody('DELETE'))).status).toBe(404)
  })

  it('demigrates a category it was sharing with the surviving site', async () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-clothing-pants.json', [item({ objectID: 'pants-001' })])
    writeFixtureFile(ws, 'algolia-home-pants.json', [])

    await app.request('/api/sites/home', noBody('DELETE'))
    expect(catalogFiles(ws)).toEqual(['algolia-pants.json'])
    expect(existsSync(join(ws.catalog, 'algolia-home-pants.json'))).toBe(false)
  })
})
