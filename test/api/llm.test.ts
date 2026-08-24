import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile, readFixtureFile,
  writeImage, imageExists, readManifest, pngBuffer, item, json,
} from '../helpers/workspace.ts'
import {
  installFetchStub, anthropicText, anthropicError,
  openaiImage, openaiImageUrl, openaiError, htmlPage, type FetchStub,
} from '../helpers/fetch-stub.ts'
import sharp from 'sharp'

// /exports/schema-from-url resolves the target hostname before fetching it. Stub the
// resolver so the tests neither depend on real DNS nor need a real public host: an IP
// literal resolves to itself (which is how the private-address cases are driven), and
// any name resolves to a public address.
const lookup = vi.hoisted(() => vi.fn(async (hostname: string) => [{
  address: /^[\d.]+$/.test(hostname) ? hostname : '93.184.216.34',
  family: 4,
}]))
vi.mock('node:dns/promises', () => ({ lookup }))

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

const OPENAI = /api\.openai\.com/
const ANTHROPIC = /api\.anthropic\.com/

let stub: FetchStub

// An image whose background is *almost* white, so a successful generate proves the
// whitening pass ran over the bytes before they were written. Built once — sharp is
// comparatively slow and every generate test wants the same bytes.
let nearWhite: Buffer
beforeAll(async () => { nearWhite = await pngBuffer(8, 8, [253, 253, 253]) })

beforeEach(() => {
  for (const dir of [ws.catalog, ws.images]) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
  }
  writeSites(ws, [
    { id: 'clothing', categories: ['pants'], basePrompt: 'clothing shot: {item}' },
    { id: 'home', categories: ['tile'], basePrompt: 'home shot: {item}' },
  ])
  process.env.OPENAI_API_KEY = 'test-openai-key'
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
  stub = installFetchStub()
})

afterEach(() => stub.restore())
afterAll(() => destroyWorkspace(ws))

describe('POST /api/:objectID/generate', () => {
  beforeEach(() => writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', name: 'Zellige' })]))

  it('builds the prompt from the site base prompt and writes the whitened image', async () => {
    stub.on(OPENAI, () => openaiImage(nearWhite))
    const res = await app.request('/api/tile-001/generate', json({}))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body).toMatchObject({ ok: true, imageUrl: '/images/tile-001.jpg' })
    // 'slim' survives autoPrompt; 'premium' is filtered out as a vague tag
    expect(body.fullPrompt).toBe('home shot: Zellige, slim')

    const sent = stub.callsTo(OPENAI)[0]
    expect(sent.url).toBe('https://api.openai.com/v1/images/generations')
    expect(sent.headers.Authorization).toBe('Bearer test-openai-key')
    expect(sent.body).toMatchObject({ prompt: 'home shot: Zellige, slim', n: 1, size: '1024x1024' })

    // written, recorded, and referenced from the item
    expect(imageExists(ws, 'tile-001.jpg')).toBe(true)
    expect(readManifest(ws)).toEqual(['tile-001'])
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].images).toEqual(['/images/tile-001.jpg'])

    // the near-white background came out exactly white
    const { data } = await sharp(join(ws.images, 'tile-001.jpg')).raw().toBuffer({ resolveWithObject: true })
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255])
  })

  it('prefers a prompt sent in the body over the stored one', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', imagePrompt: 'stored prompt' })])
    stub.on(OPENAI, () => openaiImage(nearWhite))
    const res = await app.request('/api/tile-001/generate', json({ imagePrompt: 'override' }))
    expect((await res.json() as any).fullPrompt).toBe('home shot: override')
  })

  it('falls back to the auto prompt when the item has none', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [
      item({ objectID: 'tile-001', name: 'Zellige', fit: 'womens', tags: ['matte', 'premium'] }),
    ])
    stub.on(OPENAI, () => openaiImage(nearWhite))
    const res = await app.request('/api/tile-001/generate', json({}))
    expect((await res.json() as any).fullPrompt).toBe('home shot: Zellige for women, matte')
  })

  it('uses the site the item actually belongs to', async () => {
    writeFixtureFile(ws, 'algolia-pants.json', [item({ objectID: 'pants-001', name: 'Chinos' })])
    stub.on(OPENAI, () => openaiImage(nearWhite))
    const res = await app.request('/api/pants-001/generate', json({}))
    expect((await res.json() as any).fullPrompt).toBe('clothing shot: Chinos, slim')
  })

  it('follows a url-style response by fetching the image', async () => {
    stub.on(/images\/generations/, () => openaiImageUrl('https://files.example/out.png'))
    stub.on(/files\.example/, () => new Response(nearWhite))
    const res = await app.request('/api/tile-001/generate', json({}))
    expect(res.status).toBe(200)
    expect(imageExists(ws, 'tile-001.jpg')).toBe(true)
  })

  it('surfaces the upstream error message and writes nothing', async () => {
    stub.on(OPENAI, () => openaiError('content policy violation', 400))
    const res = await app.request('/api/tile-001/generate', json({}))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'content policy violation' })
    expect(imageExists(ws, 'tile-001.jpg')).toBe(false)
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].images).toEqual([])
  })

  it('reports a response carrying no image data', async () => {
    stub.on(OPENAI, () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const res = await app.request('/api/tile-001/generate', json({}))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'No image data returned' })
  })

  it('fails cleanly when no API key is configured', async () => {
    delete process.env.OPENAI_API_KEY
    const res = await app.request('/api/tile-001/generate', json({}))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'OPENAI_API_KEY not set' })
    expect(stub.calls).toHaveLength(0)
  })

  it('404s an unknown objectID before calling out', async () => {
    const res = await app.request('/api/ghost-001/generate', json({}))
    expect(res.status).toBe(404)
    expect(stub.calls).toHaveLength(0)
  })
})

describe('POST /api/:objectID/tweak', () => {
  beforeEach(() => writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })]))

  it('edits the existing image into a separate candidate file', async () => {
    await writeImage(ws, 'tile-001.jpg')
    stub.on(/images\/edits/, () => openaiImage(nearWhite))

    const res = await app.request('/api/tile-001/tweak', json({ note: '  make it warmer  ' }))
    expect(res.status).toBe(200)
    expect((await res.json() as any).tweakUrl).toMatch(/^\/images\/tile-001-tweak\.jpg\?t=\d+$/)

    // the original is untouched until the user accepts
    expect(imageExists(ws, 'tile-001.jpg')).toBe(true)
    expect(imageExists(ws, 'tile-001-tweak.jpg')).toBe(true)

    const sent = stub.callsTo(OPENAI)[0]
    expect(sent.url).toBe('https://api.openai.com/v1/images/edits')
    expect(sent.body).toBeInstanceOf(FormData)
    expect(sent.body.get('model')).toBe('gpt-image-1')
    expect(sent.body.get('prompt')).toBe(
      'make it warmer. Keep the white background, framing, and composition otherwise the same.',
    )
  })

  it('requires a note', async () => {
    await writeImage(ws, 'tile-001.jpg')
    for (const body of [{}, { note: '' }, { note: '   ' }]) {
      const res = await app.request('/api/tile-001/tweak', json(body))
      expect(res.status).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'note required' })
    }
  })

  it('refuses when there is no image to edit yet', async () => {
    const res = await app.request('/api/tile-001/tweak', json({ note: 'warmer' }))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/generate one first/)
  })

  it('404s an unknown objectID', async () => {
    expect((await app.request('/api/ghost-001/tweak', json({ note: 'x' }))).status).toBe(404)
  })
})

describe('POST /api/generate-adhoc-image', () => {
  it('writes a pending file keyed by the temp id', async () => {
    stub.on(OPENAI, () => openaiImage(nearWhite))
    const res = await app.request('/api/generate-adhoc-image', json({
      tempId: 'abc123', imagePrompt: 'a blue tile', site: 'home',
    }))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toMatchObject({
      ok: true, imageUrl: '/images/pending-abc123.jpg', fullPrompt: 'home shot: a blue tile',
    })
    expect(imageExists(ws, 'pending-abc123.jpg')).toBe(true)
  })

  it('sanitizes a traversing temp id into a plain filename', async () => {
    stub.on(OPENAI, () => openaiImage(nearWhite))
    const res = await app.request('/api/generate-adhoc-image', json({
      tempId: '../../etc/passwd', imagePrompt: 'x', site: 'home',
    }))
    expect((await res.json() as any).imageUrl).toBe('/images/pending-etcpasswd.jpg')
    expect(readdirSync(ws.images)).toEqual(['pending-etcpasswd.jpg'])
  })

  it('rejects a temp id with nothing usable left after sanitizing', async () => {
    const res = await app.request('/api/generate-adhoc-image', json({ tempId: '///', imagePrompt: 'x' }))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'tempId invalid' })
  })

  it('requires tempId and imagePrompt', async () => {
    for (const body of [{ imagePrompt: 'x' }, { tempId: 'a' }, {}]) {
      const res = await app.request('/api/generate-adhoc-image', json(body))
      expect(res.status).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'tempId and imagePrompt required' })
    }
  })
})

describe('POST /api/:objectID/enrich', () => {
  beforeEach(() => writeFixtureFile(ws, 'algolia-pants.json', [
    item({ objectID: 'pants-001', name: 'Wide Leg Trouser', fit: 'womens', tags: ['wide-leg', 'premium', 'linen'] }),
  ]))

  it('stores the generated image prompt on the item', async () => {
    stub.on(ANTHROPIC, () => anthropicText('  wide-leg women\'s trousers in oatmeal linen  '))
    const res = await app.request('/api/pants-001/enrich', json({}))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toEqual({ ok: true, imagePrompt: "wide-leg women's trousers in oatmeal linen" })
    expect(readFixtureFile(ws, 'algolia-pants.json').hits[0].imagePrompt)
      .toBe("wide-leg women's trousers in oatmeal linen")
  })

  it('sends the clothing-shaped brief: form tags first, vague tags dropped, gender pinned', async () => {
    stub.on(ANTHROPIC, () => anthropicText('x'))
    await app.request('/api/pants-001/enrich', json({}))

    const sent = stub.callsTo(ANTHROPIC)[0]
    expect(sent.headers['x-api-key']).toBe('test-anthropic-key')
    expect(sent.headers['anthropic-version']).toBe('2023-06-01')
    const msg = sent.body.messages[0].content
    expect(msg).toContain('Name: Wide Leg Trouser')
    expect(msg).toContain('Silhouette/form: wide-leg')
    expect(msg).toContain('Details: linen')   // 'premium' is filtered as non-visual
    expect(msg).not.toContain('premium')
    expect(msg).toContain("Gender: women's")
    expect(msg).toContain('MUST appear verbatim')
  })

  it('sends the home-shaped brief with no gender line', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', name: 'Zellige', tags: ['zellige', 'matte'] })])
    stub.on(ANTHROPIC, () => anthropicText('x'))
    await app.request('/api/tile-001/enrich', json({}))

    const msg = stub.callsTo(ANTHROPIC)[0].body.messages[0].content
    expect(msg).toContain('Form/style: zellige, matte')
    expect(msg).toContain('Lead with Form/style values')
    expect(msg).not.toContain('Gender')
  })

  it('surfaces the upstream error and leaves the item alone', async () => {
    stub.on(ANTHROPIC, () => anthropicError('overloaded', 529))
    const res = await app.request('/api/pants-001/enrich', json({}))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'overloaded' })
    expect(readFixtureFile(ws, 'algolia-pants.json').hits[0].imagePrompt).toBeUndefined()
  })

  it('404s an unknown objectID', async () => {
    expect((await app.request('/api/ghost-001/enrich', json({}))).status).toBe(404)
  })
})

describe('POST /api/:objectID/describe', () => {
  beforeEach(() => writeFixtureFile(ws, 'algolia-tile.json', [
    item({ objectID: 'tile-001', name: 'Zellige', brand: 'Clé', price: 12, tags: ['matte', 'premium'] }),
  ]))

  it('stores the generated description', async () => {
    stub.on(ANTHROPIC, () => anthropicText('Hand-glazed and quietly irregular.'))
    const res = await app.request('/api/tile-001/describe', json({}))
    expect(await res.json() as any).toEqual({ ok: true, description: 'Hand-glazed and quietly irregular.' })
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].description).toBe('Hand-glazed and quietly irregular.')
  })

  it('builds the brief from the item, dropping the vague tags', async () => {
    stub.on(ANTHROPIC, () => anthropicText('x'))
    await app.request('/api/tile-001/describe', json({}))
    const call = stub.callsTo(ANTHROPIC)[0]
    const msg = call.body.messages[0].content
    expect(msg).toContain('Name: Zellige')
    expect(msg).toContain('Brand: Clé')
    expect(msg).toContain('Tags: matte')
    expect(msg).not.toContain('premium')
    expect(msg).toContain('Price: $12')
    expect(call.body.system).toContain('retail product descriptions')
    expect(call.body.max_tokens).toBe(250)
  })

  it('404s an unknown objectID', async () => {
    expect((await app.request('/api/ghost-001/describe', json({}))).status).toBe(404)
  })
})

describe('POST /api/describe-adhoc and /api/suggest-adhoc', () => {
  it('describes an item that is not in the catalog yet', async () => {
    stub.on(ANTHROPIC, () => anthropicText('A crisp oxford in pale blue.'))
    const res = await app.request('/api/describe-adhoc', json({ name: 'Oxford', colour: 'pale blue' }))
    expect(await res.json() as any).toEqual({ ok: true, description: 'A crisp oxford in pale blue.' })
    expect(stub.callsTo(ANTHROPIC)[0].body.system).toContain('MUST name the exact colour')
  })

  it('suggests an image prompt for an item that is not in the catalog yet', async () => {
    stub.on(ANTHROPIC, () => anthropicText('slim-fit oxford shirt in pale blue cotton'))
    const res = await app.request('/api/suggest-adhoc', json({ name: 'Oxford', site: 'clothing', fit: 'mens' }))
    expect(await res.json() as any).toEqual({ ok: true, imagePrompt: 'slim-fit oxford shirt in pale blue cotton' })
    expect(stub.callsTo(ANTHROPIC)[0].body.messages[0].content).toContain("Gender: men's")
  })

  it('both require a name', async () => {
    for (const path of ['/api/describe-adhoc', '/api/suggest-adhoc']) {
      const res = await app.request(path, json({}))
      expect(res.status, path).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'name required' })
    }
    expect(stub.calls).toHaveLength(0)
  })
})

describe('POST /api/generate-items', () => {
  it('pulls the JSON array out of a response that wraps it in prose', async () => {
    stub.on(ANTHROPIC, () => anthropicText(
      'Sure! Here are the items:\n```json\n[{"name":"Chinos","category":"pants"}]\n```\nHope that helps.',
    ))
    const res = await app.request('/api/generate-items', json({ prompt: 'three trousers', site: 'clothing' }))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toEqual({ ok: true, items: [{ name: 'Chinos', category: 'pants' }] })
  })

  it("constrains the model to the chosen site's categories", async () => {
    stub.on(ANTHROPIC, () => anthropicText('[]'))
    await app.request('/api/generate-items', json({ prompt: 'x', site: 'clothing', priceRange: '50-100', styleHint: 'coastal' }))
    const system = stub.callsTo(ANTHROPIC)[0].body.system
    expect(system).toContain('Valid categories: pants')
    expect(system).not.toContain('tile')
    expect(system).toContain('within $50-100')
    expect(system).toContain('"coastal"')
  })

  it('falls back to every known category when the site is unknown', async () => {
    stub.on(ANTHROPIC, () => anthropicText('[]'))
    await app.request('/api/generate-items', json({ prompt: 'x', site: 'nope' }))
    const system = stub.callsTo(ANTHROPIC)[0].body.system
    expect(system).toContain('pants')
    expect(system).toContain('tile')
  })

  it('requires a prompt', async () => {
    const res = await app.request('/api/generate-items', json({}))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'prompt required' })
  })

  it('reports a response with no array in it', async () => {
    stub.on(ANTHROPIC, () => anthropicText('I cannot help with that.'))
    const res = await app.request('/api/generate-items', json({ prompt: 'x' }))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'No JSON array in response' })
  })

  it('reports malformed JSON rather than returning half an answer', async () => {
    stub.on(ANTHROPIC, () => anthropicText('[{"name": broken]'))
    const res = await app.request('/api/generate-items', json({ prompt: 'x' }))
    expect(res.status).toBe(500)
  })
})

describe('POST /api/exports/draft', () => {
  beforeEach(() => writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })]))

  it('keeps mapped fields and adds every unmapped catalog field as an excluded row', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify([
      { source: 'name', target: 'title', transform: 'passthrough', include: true },
    ])))
    const res = await app.request('/api/exports/draft', json({ name: 'Some Feed', description: 'a feed' }))
    expect(res.status).toBe(200)

    const { fields } = await res.json() as any
    expect(fields[0]).toEqual({ source: 'name', target: 'title', transform: 'passthrough', include: true })
    // everything else the catalog has shows up, excluded, so the user can turn it on
    const bySource = Object.fromEntries(fields.map((f: any) => [f.source, f]))
    expect(bySource.objectID).toMatchObject({ include: false, target: '' })
    expect(bySource.price).toMatchObject({ include: false })
    expect(Object.keys(bySource)).toContain('colourHex')
  })

  // The model reliably invents source fields that aren't in the catalog; a map built on
  // one silently exports undefined for every record.
  it('drops source fields that do not exist in the catalog', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify([
      { source: 'name', target: 'title', transform: 'passthrough', include: true },
      { source: 'gtin', target: 'gtin', transform: 'passthrough', include: true },
      { source: 'variants', target: 'variants', transform: 'passthrough', include: true },
    ])))
    const { fields } = await (await app.request('/api/exports/draft', json({ name: 'X' }))).json() as any
    const included = fields.filter((f: any) => f.include).map((f: any) => f.source)
    expect(included).toEqual(['name'])
    expect(fields.some((f: any) => f.source === 'gtin')).toBe(false)
  })

  it('keeps the <compute:*> virtual sources', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify([
      { source: '<compute:uuid>', target: 'id', transform: 'passthrough', include: true },
      { source: '<compute:literal:Product>', target: 'objecttype', transform: 'passthrough', include: true },
    ])))
    const { fields } = await (await app.request('/api/exports/draft', json({ name: 'X' }))).json() as any
    const included = fields.filter((f: any) => f.include).map((f: any) => f.source)
    expect(included).toEqual(['<compute:uuid>', '<compute:literal:Product>'])
  })

  it('tells the model a schema-free target is flat, and hides the UI-only fields', async () => {
    stub.on(ANTHROPIC, () => anthropicText('[]'))
    await app.request('/api/exports/draft', json({ name: 'Algolia Index' }))
    const system = stub.callsTo(ANTHROPIC)[0].body.system
    expect(system).toContain('schema-free search engine')
    // The sample handed to the model must not carry enrich()'s derived fields — they are
    // not real catalog keys and a map built on one exports nothing. (They do appear in
    // the prompt as an explicit "exclude these" instruction, so match on the JSON key
    // form rather than the bare word.)
    const sampleBlock = system.slice(system.indexOf('{'), system.indexOf('\n}') + 2)
    expect(sampleBlock).toContain('"objectID"')
    for (const derived of ['isAIGenerated', 'hasCustomPrompt', 'hasImage', 'imageUrl']) {
      expect(sampleBlock, derived).not.toContain(`"${derived}"`)
    }
  })

  it('passes an explicit target schema through instead of the flat instructions', async () => {
    stub.on(ANTHROPIC, () => anthropicText('[]'))
    await app.request('/api/exports/draft', json({
      name: 'BigCommerce', targetSchema: '{"sku":"ABC"}', targetSystemName: 'BigCommerce',
    }))
    const system = stub.callsTo(ANTHROPIC)[0].body.system
    expect(system).toContain('{"sku":"ABC"}')
    expect(system).toContain('custom_fields[].text')
    expect(system).not.toContain('schema-free search engine')
  })

  it('requires a name', async () => {
    const res = await app.request('/api/exports/draft', json({}))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'name required' })
  })

  it('reports a response with no array', async () => {
    stub.on(ANTHROPIC, () => anthropicText('nope'))
    const res = await app.request('/api/exports/draft', json({ name: 'X' }))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'No JSON array in response' })
  })
})

describe('POST /api/exports/refine', () => {
  beforeEach(() => writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })]))

  const current = [{ source: 'name', target: 'title', transform: 'passthrough', include: true }]

  it('returns the refined map', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify([
      { source: 'name', target: 'product_name', transform: 'passthrough', include: true },
    ])))
    const res = await app.request('/api/exports/refine', json({
      fields: current, instruction: 'rename title to product_name',
    }))
    expect(await res.json() as any).toEqual({
      ok: true,
      fields: [{ source: 'name', target: 'product_name', transform: 'passthrough', include: true }],
    })
  })

  it('strips invented sources but keeps ones the incoming map already used', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify([
      { source: 'name', target: 'title', transform: 'passthrough', include: true },
      { source: 'legacy_sku', target: 'sku', transform: 'passthrough', include: true },
      { source: 'invented', target: 'x', transform: 'passthrough', include: true },
    ])))
    const res = await app.request('/api/exports/refine', json({
      // legacy_sku is not a catalog field, but it IS in the map we sent — keep it
      fields: [...current, { source: 'legacy_sku', target: 'sku', transform: 'passthrough', include: true }],
      instruction: 'tidy up',
    }))
    const { fields } = await res.json() as any
    expect(fields.map((f: any) => f.source)).toEqual(['name', 'legacy_sku'])
  })

  it('gives the model the current map and the target schema', async () => {
    stub.on(ANTHROPIC, () => anthropicText('[]'))
    await app.request('/api/exports/refine', json({
      fields: current, instruction: 'do a thing',
      targetSchema: '{"sku":"ABC"}', targetSystemName: 'BigCommerce',
    }))
    const call = stub.callsTo(ANTHROPIC)[0]
    expect(call.body.system).toContain('"target": "title"')
    expect(call.body.system).toContain('{"sku":"ABC"}')
    expect(call.body.messages[0].content).toBe('do a thing')
  })

  it('requires both fields and an instruction', async () => {
    for (const body of [{ instruction: 'x' }, { fields: current }, { fields: [], instruction: 'x' }]) {
      const res = await app.request('/api/exports/refine', json(body))
      expect(res.status).toBe(400)
      expect(await res.json() as any).toEqual({ error: 'fields and instruction required' })
    }
  })
})

describe('POST /api/exports/schema-lookup', () => {
  it('returns the discovered schema along with its flattened field paths', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify({
      systemName: 'BigCommerce', systemVersion: 'v2', hasStandardSchema: true,
      schemaNote: '', referenceUrl: 'https://docs.example/schema', referenceTitle: 'Product schema',
      sample: { sku: 'ABC', prices: { USD: 1 }, variants: [{ id: 1, sku: 'A' }] },
    })))
    const res = await app.request('/api/exports/schema-lookup', json({ name: 'BigCommerce', description: '' }))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body).toMatchObject({
      ok: true, systemName: 'BigCommerce', systemVersion: 'v2',
      hasStandardSchema: true, referenceUrl: 'https://docs.example/schema',
    })
    expect(body.fields.sort()).toEqual(['prices.USD', 'sku', 'variants[].id', 'variants[].sku'])
  })

  it('asks for web search', async () => {
    stub.on(ANTHROPIC, () => anthropicText('{"sample":{}}'))
    await app.request('/api/exports/schema-lookup', json({ name: 'X' }))
    const call = stub.callsTo(ANTHROPIC)[0]
    expect(call.headers['anthropic-beta']).toBe('web-search-2025-03-05')
    expect(call.body.tools[0].name).toBe('web_search')
  })

  // The indexing docs show custom_fields as an opaque {}, and the model fills it with
  // invented sub-keys; the known-shape override is what stops that reaching the user.
  it('substitutes the real custom_fields shape for a BigCommerce target', async () => {
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify({
      systemName: 'Algolia for BigCommerce',
      sample: { sku: 'ABC', custom_fields: { madeUpKey: 'nonsense' } },
    })))
    const res = await app.request('/api/exports/schema-lookup', json({ name: 'x' }))
    const body = await res.json() as any
    expect(body.sample.custom_fields).toEqual([{ id: 1, product_id: 123, name: 'Style', text: 'sample value' }])
    expect(body.fields).toContain('custom_fields[].text')
  })

  it('concatenates every text block, ignoring the tool-use blocks between them', async () => {
    stub.on(ANTHROPIC, () => new Response(JSON.stringify({
      content: [
        { type: 'text', text: '{"systemName":"X",' },
        { type: 'server_tool_use', name: 'web_search', input: {} },
        { type: 'text', text: '"sample":{"a":1}}' },
      ],
    }), { status: 200 }))
    const res = await app.request('/api/exports/schema-lookup', json({ name: 'x' }))
    expect(await res.json() as any).toMatchObject({ systemName: 'X', fields: ['a'] })
  })

  it('requires a name and reports an unparseable response', async () => {
    expect((await app.request('/api/exports/schema-lookup', json({}))).status).toBe(400)
    stub.on(ANTHROPIC, () => anthropicText('no json here'))
    const res = await app.request('/api/exports/schema-lookup', json({ name: 'x' }))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'No JSON in response' })
  })
})

describe('POST /api/exports/schema-from-url', () => {
  const PAGE = 'https://docs.example/product-schema'

  it('fetches the page, strips it to text and returns the parsed schema', async () => {
    stub.on(/docs\.example/, () => htmlPage(
      '<html><head><style>.a{color:red}</style></head><body><script>var x=1</script>' +
      '<h1>Product schema</h1><p>sku is the identifier</p></body></html>',
    ))
    stub.on(ANTHROPIC, () => anthropicText(JSON.stringify({
      systemName: 'Example', hasStandardSchema: true, referenceTitle: 'Product schema',
      sample: { sku: 'ABC', price: 1 },
    })))

    const res = await app.request('/api/exports/schema-from-url', json({ url: PAGE }))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({ ok: true, systemName: 'Example', referenceUrl: PAGE, referenceTitle: 'Product schema' })
    expect(body.fields.sort()).toEqual(['price', 'sku'])

    // the page text handed to the model has the markup, styles and scripts removed
    const text = stub.callsTo(ANTHROPIC)[0].body.messages[0].content
    expect(text).toContain('sku is the identifier')
    expect(text).not.toContain('<h1>')
    expect(text).not.toContain('var x=1')
    expect(text).not.toContain('color:red')
  })

  it('refuses a URL whose host is private, without fetching it', async () => {
    const res = await app.request('/api/exports/schema-from-url', json({ url: 'http://169.254.169.254/latest/meta-data/' }))
    expect(res.status).toBe(500)
    expect((await res.json() as any).error).toMatch(/private\/internal address/)
    expect(stub.calls).toHaveLength(0)
  })

  it('refuses a non-http scheme', async () => {
    const res = await app.request('/api/exports/schema-from-url', json({ url: 'file:///etc/passwd' }))
    expect(res.status).toBe(500)
    expect((await res.json() as any).error).toMatch(/Only http\(s\)/)
    expect(stub.calls).toHaveLength(0)
  })

  it('re-checks each redirect hop rather than following blindly', async () => {
    stub.on(/docs\.example/, () => new Response(null, {
      status: 302, headers: { location: 'http://169.254.169.254/latest/' },
    }))
    const res = await app.request('/api/exports/schema-from-url', json({ url: PAGE }))
    expect(res.status).toBe(500)
    expect((await res.json() as any).error).toMatch(/private\/internal address/)
    // the first hop happened; the second was refused before any request went out
    expect(stub.calls).toHaveLength(1)
  })

  it('gives up after too many redirects', async () => {
    stub.on(/docs\.example/, () => new Response(null, {
      status: 302, headers: { location: 'https://docs.example/again' },
    }))
    const res = await app.request('/api/exports/schema-from-url', json({ url: PAGE }))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'Too many redirects' })
  })

  it('reports a non-OK page', async () => {
    stub.on(/docs\.example/, () => new Response('nope', { status: 404 }))
    const res = await app.request('/api/exports/schema-from-url', json({ url: PAGE }))
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ error: 'URL returned 404' })
  })

  it('requires a url', async () => {
    const res = await app.request('/api/exports/schema-from-url', json({}))
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'url required' })
  })
})
