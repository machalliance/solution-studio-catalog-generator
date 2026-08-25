import { describe, it, expect, afterAll } from 'vitest'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile, item, json, noBody,
} from '../helpers/workspace.ts'

// server.ts reads STUDIO_API_TOKEN once, at module scope, so the token-configured case
// needs its own file: the env has to be set before the import, and vitest gives each
// test file its own process.
const ws = createWorkspace()
process.env.STUDIO_API_TOKEN = 's3cret-token'

const { app } = await import('../../src/server.ts')

writeSites(ws, [{ id: 'home', categories: ['tile'] }])
writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])

afterAll(() => destroyWorkspace(ws))

const bearer = (token: string) => ({ headers: { Host: 'localhost', Authorization: `Bearer ${token}` } })

describe('bearer auth on /catalog/*', () => {
  it('accepts the configured token', async () => {
    expect((await app.request('/catalog', bearer('s3cret-token'))).status).toBe(200)
    expect((await app.request('/catalog/tile-001', bearer('s3cret-token'))).status).toBe(200)
  })

  it('401s with no Authorization header', async () => {
    const res = await app.request('/catalog')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json() as any).toEqual({ error: 'Unauthorized' })
  })

  it('401s a wrong or malformed token', async () => {
    for (const header of ['Bearer wrong', 'bearer s3cret-token', 's3cret-token', 'Basic czNjcmV0', 'Bearer ']) {
      const res = await app.request('/catalog', { headers: { Host: 'localhost', Authorization: header } })
      expect(res.status, header).toBe(401)
    }
  })

  it('gates the whole subtree, including the mutating routes', async () => {
    for (const [method, path] of [['POST', '/catalog/tile-001/generate'], ['DELETE', '/catalog/tile-001/image']]) {
      const res = await app.request(path, { method, headers: { Host: 'localhost' } })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('401s an unknown path under /catalog too, rather than 404ing it first', async () => {
    expect((await app.request('/catalog/ghost-001')).status).toBe(401)
  })

  // The token guards remote consumers; the local UI has none to send, so /api and the
  // unauthenticated surfaces must stay reachable without it.
  it('does not gate /api, /health or the UI', async () => {
    expect((await app.request('/health')).status).toBe(200)
    expect((await app.request('/')).status).toBe(200)
    expect((await app.request('/api/sites', noBody('GET'))).status).toBe(200)
    expect((await app.request('/api/items', noBody('GET'))).status).toBe(200)
  })

  it('still applies the same-origin check to /api independently of the token', async () => {
    const res = await app.request('/api/sites', json({ label: 'Evil' }, {
      headers: { Origin: 'https://evil.example' },
    }))
    expect(res.status).toBe(403)
  })
})
