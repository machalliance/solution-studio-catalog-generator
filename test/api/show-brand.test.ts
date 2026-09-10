import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { createWorkspace, destroyWorkspace, writeSites, readFixtureFile, json } from '../helpers/workspace.ts'
import { installFetchStub, anthropicText, sentSystem, type FetchStub } from '../helpers/fetch-stub.ts'

// SHOW_BRAND is read once at module scope (api.ts), so the only way to exercise the "on"
// state is a file of its own — vitest's per-file fork (pool: 'forks', isolate: true) gives
// this its own process, set *before* the dynamic import below. See llm.test.ts and
// server.test.ts for the (default) off case, which every other test file gets for free.
process.env.SHOW_BRAND = 'true'

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

const ANTHROPIC = /api\.anthropic\.com/

let stub: FetchStub

beforeEach(() => {
  writeSites(ws, [{ id: 'clothing', categories: ['pants'], basePrompt: 'clothing shot: {item}' }])
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
  stub = installFetchStub()
})

afterEach(() => stub.restore())
afterAll(() => destroyWorkspace(ws))

describe('SHOW_BRAND=true', () => {
  it('GET /api/settings reports showBrand as true', async () => {
    const settings = await (await app.request('/api/settings')).json() as any
    expect(settings.showBrand).toBe(true)
  })

  it('requires /generate-items to invent a fictional brand, never a real one', async () => {
    stub.on(ANTHROPIC, () => anthropicText('[]'))
    await app.request('/api/generate-items', json({ prompt: 'x', site: 'clothing' }))
    const system = sentSystem(stub.callsTo(ANTHROPIC)[0])
    expect(system).toContain('"brand"')
    expect(system).toContain('invented, fictional house-brand')
    expect(system).toContain('never a real, currently-trading company')
  })

  // The other half of the off-state tests in llm.test.ts and items.test.ts: with the flag
  // on, a generated brand is meant to survive both routes untouched.
  it('keeps a generated brand through /generate-items and /items/batch', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify([
      { name: 'Wide Leg', brand: 'Northmoor Supply', category: 'pants', fit: 'unisex',
        style: 'casual', tags: ['wide-leg'], colourHex: '#aabbcc', colourFamily: 'blue', price: 120 },
    ])))
    const gen = await app.request('/api/generate-items', json({ prompt: 'x', site: 'clothing' }))
    const { items } = await gen.json() as any
    expect(items[0].brand).toBe('Northmoor Supply')

    await app.request('/api/items/batch', json({ site: 'clothing', items }))
    expect(readFixtureFile(ws, 'algolia-pants.json').hits[0].brand).toBe('Northmoor Supply')
  })
})
