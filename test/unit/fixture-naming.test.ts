import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile, item,
} from '../helpers/workspace.ts'
import { rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'

const ws = createWorkspace()
const {
  sitesSharingCategory, fixtureFilename, nextObjectID,
  getAllCatRefs, getAllCats, loadFixture,
} = await import('../../src/products/api.ts')

// Category names are per-site, but the fixture filename only gets the site prefix once
// two sites genuinely share a name — that's what keeps the shared catalog directory
// migration-free for the common case, and it's recomputed from live sharer count on
// every call, so getting it wrong orphans data.
beforeEach(() => {
  for (const f of readdirSync(ws.catalog)) rmSync(`${ws.catalog}/${f}`, { force: true })
})

afterAll(() => destroyWorkspace(ws))

describe('sitesSharingCategory', () => {
  it('finds every site registering the name', () => {
    const sites = [
      { id: 'clothing', label: 'C', categories: ['pants', 'shoes'], basePrompt: '' },
      { id: 'home', label: 'H', categories: ['pants', 'tile'], basePrompt: '' },
    ]
    expect(sitesSharingCategory('pants', sites).map(s => s.id)).toEqual(['clothing', 'home'])
    expect(sitesSharingCategory('tile', sites).map(s => s.id)).toEqual(['home'])
    expect(sitesSharingCategory('nope', sites)).toEqual([])
  })
})

describe('fixtureFilename', () => {
  it('uses the legacy flat name when a category is owned by one site', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['tile'] }])
    expect(fixtureFilename('clothing', 'pants')).toBe('algolia-pants.json')
    expect(fixtureFilename('home', 'tile')).toBe('algolia-tile.json')
  })

  it('uses the legacy flat name for a category no site claims (a hand-added file)', () => {
    writeSites(ws, [{ id: 'home', categories: ['tile'] }])
    expect(fixtureFilename('home', 'orphan')).toBe('algolia-orphan.json')
  })

  it('site-prefixes only once two sites genuinely share the name', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['pants'] }])
    expect(fixtureFilename('clothing', 'pants')).toBe('algolia-clothing-pants.json')
    expect(fixtureFilename('home', 'pants')).toBe('algolia-home-pants.json')
  })
})

describe('nextObjectID', () => {
  it('starts at 001 for an empty category', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }])
    expect(nextObjectID('pants')).toBe('pants-001')
  })

  it('continues one past the highest existing suffix, zero-padded', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-pants.json', [
      item({ objectID: 'pants-001' }), item({ objectID: 'pants-009' }), item({ objectID: 'pants-003' }),
    ])
    expect(nextObjectID('pants')).toBe('pants-010')
  })

  it('keeps ids globally unique across every site sharing the name', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-clothing-pants.json', [item({ objectID: 'pants-002' })])
    writeFixtureFile(ws, 'algolia-home-pants.json', [item({ objectID: 'pants-007' })])
    expect(nextObjectID('pants')).toBe('pants-008')
  })

  it('ignores objectIDs that do not carry a numeric suffix', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-pants.json', [
      item({ objectID: 'pants' }), item({ objectID: 'pants-abc' }), item({ objectID: 'pants-004' }),
    ])
    expect(nextObjectID('pants')).toBe('pants-005')
  })

  it('falls back to the last site for a category no site registers', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['tile'] }])
    writeFixtureFile(ws, 'algolia-orphan.json', [item({ objectID: 'orphan-005' })])
    expect(nextObjectID('orphan')).toBe('orphan-006')
  })

  it('pads past three digits without truncating', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-999' })])
    expect(nextObjectID('pants')).toBe('pants-1000')
  })
})

describe('getAllCatRefs', () => {
  it('lists every registered (site, category) pair', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants', 'shoes'] }, { id: 'home', categories: ['tile'] }])
    expect(getAllCatRefs()).toEqual([
      { site: 'clothing', category: 'pants' },
      { site: 'clothing', category: 'shoes' },
      { site: 'home', category: 'tile' },
    ])
  })

  it('picks up an unregistered on-disk fixture and attributes it to the fallback site', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['tile'] }])
    writeFixtureFile(ws, 'algolia-pants.json', [item()])
    writeFixtureFile(ws, 'algolia-handmade.json', [item()])
    expect(getAllCatRefs()).toContainEqual({ site: 'home', category: 'handmade' })
    // The registered ones are accounted for and must not be duplicated as orphans.
    expect(getAllCatRefs().filter(r => r.category === 'pants')).toEqual([{ site: 'clothing', category: 'pants' }])
  })

  it('does not treat a site-prefixed fixture of a shared category as an orphan', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants'] }, { id: 'home', categories: ['pants'] }])
    writeFixtureFile(ws, 'algolia-clothing-pants.json', [item()])
    writeFixtureFile(ws, 'algolia-home-pants.json', [item()])
    expect(getAllCatRefs()).toEqual([
      { site: 'clothing', category: 'pants' },
      { site: 'home', category: 'pants' },
    ])
  })

  it('ignores files that are not catalog fixtures', () => {
    writeSites(ws, [{ id: 'home', categories: ['tile'] }])
    writeFixtureFile(ws, 'notes.json', [])
    writeFixtureFile(ws, 'algolia-real.json', [])
    expect(getAllCatRefs().map(r => r.category).sort()).toEqual(['real', 'tile'])
  })

  it('survives the catalog directory not existing yet', () => {
    writeSites(ws, [{ id: 'home', categories: ['tile'] }])
    rmSync(ws.catalog, { recursive: true, force: true })
    expect(getAllCatRefs()).toEqual([{ site: 'home', category: 'tile' }])
    mkdirSync(ws.catalog, { recursive: true })
  })
})

describe('getAllCats', () => {
  it('de-duplicates a name shared by two sites', () => {
    writeSites(ws, [{ id: 'clothing', categories: ['pants', 'shoes'] }, { id: 'home', categories: ['pants'] }])
    expect(getAllCats().sort()).toEqual(['pants', 'shoes'])
  })
})

describe('loadFixture', () => {
  it('returns null when the file is absent', () => {
    writeSites(ws, [{ id: 'home', categories: ['tile'] }])
    expect(loadFixture('home', 'tile')).toBeNull()
  })

  it('returns null rather than throwing on a corrupted fixture', () => {
    writeSites(ws, [{ id: 'home', categories: ['tile'] }])
    writeFileSync(`${ws.catalog}/algolia-tile.json`, '{ not json')
    expect(loadFixture('home', 'tile')).toBeNull()
  })
})
