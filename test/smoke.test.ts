import { describe, it, expect, afterAll } from 'vitest'
import { createWorkspace, destroyWorkspace, writeSites } from './helpers/workspace.ts'

const ws = createWorkspace()
writeSites(ws, [{ id: 'home', categories: ['vanity'] }])

const api = await import('../src/products/api.ts')
const server = await import('../src/server.ts')

afterAll(() => destroyWorkspace(ws))

describe('module wiring', () => {
  it('resolves the test surface from api.ts', () => {
    expect(api.slugify('Hello World!')).toBe('hello-world')
  })

  it('picks up the temp workspace instead of the repo data dir', () => {
    expect(api.loadSites().map(s => s.id)).toEqual(['home'])
  })

  it('imports server.ts without binding a port', async () => {
    const res = await server.app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json() as any).toMatchObject({ ok: true })
  })
})
