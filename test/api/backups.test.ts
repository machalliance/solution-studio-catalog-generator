import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createWorkspace, destroyWorkspace, writeSites, writeFixtureFile, readFixtureFile,
  writeImage, imageExists, item, json, noBody,
} from '../helpers/workspace.ts'

const ws = createWorkspace()
const { app } = await import('../../src/server.ts')

beforeEach(() => {
  for (const dir of [ws.catalog, ws.images, ws.backups]) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
  }
  writeSites(ws, [{ id: 'home', categories: ['tile'] }])
})

afterAll(() => destroyWorkspace(ws))

describe('POST /api/backups', () => {
  it('writes a timestamped tarball and reports its size', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001' })])
    await writeImage(ws, 'tile-001.jpg')

    const res = await app.request('/api/backups', json({}))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.filename).toMatch(/^products-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/)
    expect(body.size).toBeGreaterThan(0)
    expect(existsSync(join(ws.backups, body.filename))).toBe(true)
  })

  it('lists what it wrote, newest first', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [])
    const { filename } = await (await app.request('/api/backups', json({}))).json() as any

    const listed = await (await app.request('/api/backups')).json() as any
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ filename })
    expect(listed[0].created).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(listed[0].size).toBeGreaterThan(0)
  })

  it('ignores non-tarballs sitting in the backups directory', async () => {
    writeFileSync(join(ws.backups, 'notes.txt'), 'hello')
    expect(await (await app.request('/api/backups')).json() as any).toEqual([])
  })
})

describe('POST /api/backups/:filename/restore', () => {
  it('puts back catalog and image files that were deleted after the snapshot', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', name: 'Original' })])
    await writeImage(ws, 'tile-001.jpg')
    const { filename } = await (await app.request('/api/backups', json({}))).json() as any

    // Destroy both after snapshotting
    await app.request('/api/tile-001/image', noBody('DELETE'))
    writeFixtureFile(ws, 'algolia-tile.json', [])
    expect(imageExists(ws, 'tile-001.jpg')).toBe(false)

    const res = await app.request(`/api/backups/${filename}/restore`, json({}))
    expect(res.status).toBe(200)
    expect(await res.json() as any).toEqual({ ok: true })
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0]).toMatchObject({ objectID: 'tile-001', name: 'Original' })
    expect(imageExists(ws, 'tile-001.jpg')).toBe(true)
  })

  it('overwrites a file that changed since the snapshot', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', name: 'Original' })])
    const { filename } = await (await app.request('/api/backups', json({}))).json() as any

    writeFixtureFile(ws, 'algolia-tile.json', [item({ objectID: 'tile-001', name: 'Edited' })])
    await app.request(`/api/backups/${filename}/restore`, json({}))
    expect(readFixtureFile(ws, 'algolia-tile.json').hits[0].name).toBe('Original')
  })

  it('rejects a filename that is not a plain .tar.gz', async () => {
    for (const name of ['../evil.tar.gz', 'evil.sh', 'Evil.tar.gz', encodeURIComponent('../../etc/x.tar.gz')]) {
      const res = await app.request(`/api/backups/${name}/restore`, json({}))
      expect([400, 404], name).toContain(res.status)
      if (res.status === 400) expect(await res.json() as any).toEqual({ error: 'Invalid filename' })
    }
  })

  it('404s a well-formed name that does not exist', async () => {
    const res = await app.request('/api/backups/products-2020-01-01-0000.tar.gz/restore', json({}))
    expect(res.status).toBe(404)
    expect(await res.json() as any).toEqual({ error: 'Not found' })
  })
})

describe('DELETE /api/backups/:filename', () => {
  it('removes the tarball', async () => {
    writeFixtureFile(ws, 'algolia-tile.json', [])
    const { filename } = await (await app.request('/api/backups', json({}))).json() as any

    const res = await app.request(`/api/backups/${filename}`, noBody('DELETE'))
    expect(res.status).toBe(200)
    expect(existsSync(join(ws.backups, filename))).toBe(false)
    expect(await (await app.request('/api/backups')).json() as any).toEqual([])
  })

  it('rejects an unsafe filename and 404s an absent one', async () => {
    let res = await app.request('/api/backups/..%2Fevil.tar.gz', noBody('DELETE'))
    expect([400, 404]).toContain(res.status)

    res = await app.request('/api/backups/products-2020-01-01-0000.tar.gz', noBody('DELETE'))
    expect(res.status).toBe(404)
  })
})
