import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createWorkspace, destroyWorkspace } from '../helpers/workspace.ts'

// api.ts resolves the hostname itself and checks every returned address — that's the
// part that stops a name deliberately pointing at a private IP. Stubbing the resolver is
// the only way to exercise it without depending on real DNS.
const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))

const ws = createWorkspace()
const { isPrivateAddress, assertPublicUrl } = await import('../../src/products/api.ts')

beforeEach(() => lookup.mockClear())
afterAll(() => destroyWorkspace(ws))

// Captures a rejection's message directly. Used in place of .rejects.toThrow for the one
// case whose failure originates in an *upstream* rejected promise (the resolver's), which
// the matcher's own bookkeeping reports as an unhandled rejection and fails the test over
// — even though assertPublicUrl does catch it and rethrow its own message.
async function messageFrom(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return 'DID NOT REJECT' } catch (e: any) { return e.message }
}

describe('isPrivateAddress — IPv4', () => {
  it.each([
    ['10.0.0.1', 'RFC1918 /8'],
    ['10.255.255.255', 'RFC1918 /8 upper'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback, non-canonical'],
    ['0.0.0.0', 'this host'],
    ['172.16.0.1', 'RFC1918 /12 lower'],
    ['172.31.255.254', 'RFC1918 /12 upper'],
    ['192.168.1.1', 'RFC1918 /16'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT lower'],
    ['100.127.255.255', 'carrier-grade NAT upper'],
  ])('rejects %s (%s)', ip => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['172.15.0.1'],   // just below the /12
    ['172.32.0.1'],   // just above the /12
    ['192.167.1.1'],
    ['169.253.0.1'],
    ['100.63.255.255'],
    ['100.128.0.1'],
    ['11.0.0.1'],
  ])('allows public %s', ip => {
    expect(isPrivateAddress(ip)).toBe(false)
  })
})

describe('isPrivateAddress — IPv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local fc'],
    ['fd12:3456::1', 'unique-local fd'],
    ['fe80::1', 'link-local'],
    ['FE80::1', 'link-local, uppercase'],
    ['[::1]', 'bracketed loopback'],
    ['::ffff:127.0.0.1', 'v4-mapped loopback'],
    ['::ffff:169.254.169.254', 'v4-mapped metadata'],
  ])('rejects %s (%s)', ip => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  it.each([
    ['2606:4700:4700::1111'],
    ['2001:4860:4860::8888'],
    ['::ffff:8.8.8.8'],
  ])('allows public %s', ip => {
    expect(isPrivateAddress(ip)).toBe(false)
  })

  // dns.lookup() only ever hands back the dotted form of a v4-mapped address, so the
  // hex spelling has no legitimate route in — refuse it rather than fail open.
  it.each([
    ['::ffff:7f00:1'],
    ['::ffff:a9fe:a9fe'],
    ['::ffff:garbage'],
  ])('refuses the unparseable v4-mapped form %s', ip => {
    expect(isPrivateAddress(ip)).toBe(true)
  })
})

describe('assertPublicUrl', () => {
  it('rejects a malformed URL', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow('Invalid URL')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('rejects non-http(s) schemes before touching DNS', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/plain,hi']) {
      await expect(assertPublicUrl(url)).rejects.toThrow('Only http(s) URLs are supported')
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it('accepts a hostname that resolves entirely to public addresses', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const u = await assertPublicUrl('https://example.com/docs')
    expect(u.hostname).toBe('example.com')
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true })
  })

  it('rejects a hostname that resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    await expect(assertPublicUrl('https://metadata.evil.test/latest'))
      .rejects.toThrow('Refusing to fetch a private/internal address')
  })

  it('rejects when only one of several answers is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(assertPublicUrl('https://split.evil.test/'))
      .rejects.toThrow('Refusing to fetch a private/internal address')
  })

  it('rejects a literal private IP in the URL', async () => {
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow('Refusing to fetch a private/internal address')
  })

  it('rejects a hostname that will not resolve', async () => {
    // Deliberately a thenable rather than a real rejected Promise. vitest records every
    // value a spy returns and tracks its settlement, and a genuinely-rejected promise
    // handed back that way gets reported as an unhandled rejection — failing the test
    // even though assertPublicUrl catches it. A thenable exposes the one method the code
    // under test calls (.catch) without entering that machinery.
    lookup.mockReturnValue({
      catch: (onRejected: (e: Error) => never) => onRejected(new Error('ENOTFOUND')),
    })
    expect(await messageFrom(() => assertPublicUrl('https://nope.invalid/')))
      .toBe('Could not resolve host')
  })

  it('rejects a hostname that resolves to nothing', async () => {
    lookup.mockResolvedValue([])
    await expect(assertPublicUrl('https://empty.test/')).rejects.toThrow('Could not resolve host')
  })
})
