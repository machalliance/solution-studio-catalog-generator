import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile, readFixtureFile,
  readManifest, pngBuffer, item, json,
} from '../helpers/workspace.ts'
import { installFetchStub, anthropicText, openaiImage, type FetchStub } from '../helpers/fetch-stub.ts'

// Every route here reads a category fixture, awaits a model call for seconds, then writes
// the result back. What these cover is the read in between: a handler that saves the
// snapshot it took *before* the await silently erases whatever another request committed
// while it was waiting.
//
// The window is driven by a barrier rather than a sleep, so the interleaving is exact
// instead of probable — no test here depends on how long anything takes.

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

const OPENAI = /api\.openai\.com/
const ANTHROPIC = /api\.anthropic\.com/

// Holds every model call until `n` of them have arrived, then releases them together.
// That guarantees all n handlers have read the fixture before any of them writes.
function barrier(n: number) {
  let arrived = 0
  let open!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  return async () => {
    if (++arrived >= n) open()
    await gate
  }
}

let stub: FetchStub
let png: Buffer
beforeAll(async () => { png = await pngBuffer(8, 8, [253, 253, 253]) })

beforeEach(() => {
  for (const dir of [ws.catalog, ws.images]) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
  }
  writeSites(ws, [{ id: 'home', categories: ['tile'], basePrompt: 'shot: {item}' }])
  process.env.OPENAI_API_KEY = 'test-openai-key'
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
  stub = installFetchStub()
})

afterEach(() => stub.restore())
afterAll(() => destroyWorkspace(ws))

const IDS = ['tile-001', 'tile-002', 'tile-003', 'tile-004', 'tile-005']
const seedFive = () =>
  writeFixtureFile(ws, 'algolia-tile.json', IDS.map(id => item({ objectID: id, name: id })))

describe('concurrent writes to one category fixture', () => {
  it('keeps every image reference when five generates run in parallel', async () => {
    seedFive()
    const allRead = barrier(5)
    stub.on(OPENAI, async () => { await allRead(); return openaiImage(png) })

    const res = await Promise.all(IDS.map(id => app.request(`/api/${id}/generate`, json({}))))
    expect(res.map(r => r.status)).toEqual([200, 200, 200, 200, 200])

    // Each item points at its own file. Before the fix exactly one did — the last handler
    // to finish wrote back a snapshot taken before any of the others had saved, so four
    // images were generated, paid for, written to disk, and then orphaned.
    const hits = readFixtureFile(ws, 'algolia-tile.json').hits
    expect(Object.fromEntries(hits.map((h: any) => [h.objectID, h.images]))).toEqual({
      'tile-001': ['/images/tile-001.jpg'],
      'tile-002': ['/images/tile-002.jpg'],
      'tile-003': ['/images/tile-003.jpg'],
      'tile-004': ['/images/tile-004.jpg'],
      'tile-005': ['/images/tile-005.jpg'],
    })
    expect(readManifest(ws).sort()).toEqual(IDS)
  })

  it('keeps every prompt when five enrich calls run in parallel', async () => {
    seedFive()
    const allRead = barrier(5)
    stub.on(ANTHROPIC, async () => { await allRead(); return anthropicText('a generated image prompt') })

    const res = await Promise.all(IDS.map(id => app.request(`/api/${id}/enrich`, json({}))))
    expect(res.every(r => r.status === 200)).toBe(true)

    const hits = readFixtureFile(ws, 'algolia-tile.json').hits
    expect(hits.filter((h: any) => h.imagePrompt === 'a generated image prompt')).toHaveLength(5)
  })

  it('keeps every description when five describe calls run in parallel', async () => {
    seedFive()
    const allRead = barrier(5)
    stub.on(ANTHROPIC, async () => { await allRead(); return anthropicText('a generated description') })

    const res = await Promise.all(IDS.map(id => app.request(`/api/${id}/describe`, json({}))))
    expect(res.every(r => r.status === 200)).toBe(true)

    const hits = readFixtureFile(ws, 'algolia-tile.json').hits
    expect(hits.filter((h: any) => h.description === 'a generated description')).toHaveLength(5)
  })

  it('does not let a generate in flight resurrect an item deleted while it ran', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [
      item({ objectID: 'tile-001', name: 'A' }),
      item({ objectID: 'tile-002', name: 'B' }),
    ])

    // Barrier of 1: the stub blocks as soon as the model call is reached, which is proof
    // the handler has already read the fixture. Only then is the item deleted, so the
    // deletion is guaranteed to land inside the handler's await rather than racing it.
    const reachedModel = barrier(1)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    stub.on(OPENAI, async () => { await reachedModel(); await held; return openaiImage(png) })

    const inFlight = app.request('/api/tile-001/generate', json({}))
    await new Promise(r => setImmediate(r))   // let the handler run up to the model call

    const del = await app.request('/api/items', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectIDs: ['tile-001'] }),
    })
    expect(await del.json()).toMatchObject({ removed: 1 })

    release()
    await inFlight

    // Writing back the pre-await snapshot would put the deleted item straight back.
    const ids = readFixtureFile(ws, 'algolia-tile.json').hits.map((h: any) => h.objectID)
    expect(ids).toEqual(['tile-002'])
  })
})
