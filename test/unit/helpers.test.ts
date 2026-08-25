import { describe, it, expect, afterAll } from 'vitest'
import { createWorkspace, destroyWorkspace, item } from '../helpers/workspace.ts'

const ws = createWorkspace()
const {
  slugify, parseTagList, parsePrice, autoPrompt, enrich,
  safeFilename, sanitizeId, safeMapId, toStoredSchema,
} = await import('../../src/products/api.ts')

afterAll(() => destroyWorkspace(ws))

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Merino Wool Overshirt')).toBe('merino-wool-overshirt')
  })
  it('collapses runs of punctuation into a single hyphen', () => {
    expect(slugify('Vanity — 36" (White)')).toBe('vanity-36-white')
  })
  it('trims leading and trailing hyphens', () => {
    expect(slugify('  !Hello!  ')).toBe('hello')
  })
  it('leaves an existing slug untouched', () => {
    expect(slugify('brushed-nickel-faucet')).toBe('brushed-nickel-faucet')
  })
  it('returns empty string when nothing survives — callers 400 on this', () => {
    expect(slugify('!!!')).toBe('')
    expect(slugify('日本語')).toBe('')
  })
})

describe('parseTagList', () => {
  it('passes an array through unchanged', () => {
    expect(parseTagList(['slim', 'wool'])).toEqual(['slim', 'wool'])
  })
  it('splits a comma-separated string and trims each entry', () => {
    expect(parseTagList(' slim , wool ,linen ')).toEqual(['slim', 'wool', 'linen'])
  })
  it('drops empty segments', () => {
    expect(parseTagList('slim,,wool,')).toEqual(['slim', 'wool'])
  })
  it('treats absent/blank input as no tags', () => {
    expect(parseTagList(undefined)).toEqual([])
    expect(parseTagList(null)).toEqual([])
    expect(parseTagList('')).toEqual([])
    expect(parseTagList('   ')).toEqual([])
  })
})

describe('parsePrice', () => {
  it('treats absent values as 0', () => {
    expect(parsePrice(undefined)).toBe(0)
    expect(parsePrice(null)).toBe(0)
    expect(parsePrice('')).toBe(0)
  })
  it('accepts numbers and numeric strings', () => {
    expect(parsePrice(42)).toBe(42)
    expect(parsePrice('12.50')).toBe(12.5)
    expect(parsePrice(0)).toBe(0)
  })
  it('returns null for non-numeric input so callers can 400 instead of storing NaN', () => {
    expect(parsePrice('free')).toBeNull()
    expect(parsePrice({})).toBeNull()
    expect(parsePrice(NaN)).toBeNull()
  })
  it('rejects negative and non-finite values', () => {
    expect(parsePrice(-1)).toBeNull()
    expect(parsePrice('-0.01')).toBeNull()
    expect(parsePrice(Infinity)).toBeNull()
  })
})

describe('sanitizeId / safeMapId', () => {
  it('strips traversal out of an id destined for a filename', () => {
    expect(sanitizeId('../../etc/passwd')).toBe('etcpasswd')
    expect(safeMapId('../../src/products/sites')).toBe('srcproductssites')
  })
  it('keeps alphanumerics, hyphen and underscore', () => {
    expect(sanitizeId('abc-123_XYZ')).toBe('abc-123_XYZ')
    expect(safeMapId('algolia-bigcommerce-v2-9f3a')).toBe('algolia-bigcommerce-v2-9f3a')
  })
  it('collapses to empty when nothing legitimate remains — callers 400 on this', () => {
    expect(sanitizeId('../..')).toBe('')
    expect(safeMapId('/////')).toBe('')
    expect(safeMapId(undefined as any)).toBe('')
  })
  it('drops path separators, dots and null bytes', () => {
    expect(sanitizeId('a/b\\c.d\0e')).toBe('abcde')
  })
})

describe('safeFilename', () => {
  it('accepts the snapshot names this app generates', () => {
    expect(safeFilename('products-2026-08-24-1642.tar.gz')).toBe(true)
  })
  it('rejects traversal and absolute paths', () => {
    expect(safeFilename('../products.tar.gz')).toBe(false)
    expect(safeFilename('/etc/products.tar.gz')).toBe(false)
    expect(safeFilename('a/b.tar.gz')).toBe(false)
  })
  it('rejects anything that is not a lowercase .tar.gz', () => {
    expect(safeFilename('Products.tar.gz')).toBe(false)
    expect(safeFilename('products.tgz')).toBe(false)
    expect(safeFilename('products.tar.gz.sh')).toBe(false)
    expect(safeFilename('.tar.gz')).toBe(false)
  })
})

describe('autoPrompt', () => {
  it('appends a gender phrase derived from fit', () => {
    expect(autoPrompt(item({ name: 'Oxford Shirt', fit: 'mens', tags: [] }) as any))
      .toBe('Oxford Shirt for men')
    expect(autoPrompt(item({ name: 'Wrap Dress', fit: 'womens', tags: [] }) as any))
      .toBe('Wrap Dress for women')
  })
  it('says nothing about gender for unisex', () => {
    expect(autoPrompt(item({ name: 'Tote', fit: 'unisex', tags: [] }) as any)).toBe('Tote')
  })
  it('appends up to three tags, skipping the vague ones', () => {
    const prompt = autoPrompt(item({
      name: 'Jacket', fit: 'unisex',
      tags: ['premium', 'classic', 'bomber', 'wool', 'quilted', 'olive'],
    }) as any)
    // premium/classic are in SKIP_TAGS; the next three survive
    expect(prompt).toBe('Jacket, bomber, wool, quilted')
  })
  it('tolerates a missing tags array', () => {
    expect(autoPrompt({ name: 'Mirror', fit: 'unisex' } as any)).toBe('Mirror')
  })
})

describe('enrich', () => {
  const manifest = new Set(['gen-001'])

  it('reports no image when images is empty', () => {
    const e = enrich(item({ objectID: 'x-001', images: [] }) as any, manifest)
    expect(e).toMatchObject({ hasImage: false, isAIGenerated: false, isExternalImage: false, imageUrl: '' })
  })

  it('claims AI-generated only when the filename matches our convention AND the manifest agrees', () => {
    const generated = enrich(item({ objectID: 'gen-001', images: ['/images/gen-001.jpg'] }) as any, manifest)
    expect(generated).toMatchObject({ hasImage: true, isAIGenerated: true, isExternalImage: false })

    // Right filename, but never recorded in the manifest — a leftover local file.
    const unrecorded = enrich(item({ objectID: 'gen-002', images: ['/images/gen-002.jpg'] }) as any, manifest)
    expect(unrecorded).toMatchObject({ hasImage: true, isAIGenerated: false, isExternalImage: false })

    // In the manifest, but images[0] was hand-edited to point elsewhere.
    const repointed = enrich(item({ objectID: 'gen-001', images: ['https://cdn.example/x.jpg'] }) as any, manifest)
    expect(repointed).toMatchObject({ hasImage: true, isAIGenerated: false, isExternalImage: true })
  })

  it('accepts a bare filename as matching our own convention', () => {
    const e = enrich(item({ objectID: 'gen-001', images: ['gen-001.jpg'] }) as any, manifest)
    expect(e.isAIGenerated).toBe(true)
  })

  it('does not treat a filename that merely ends with ours as ours', () => {
    const e = enrich(item({ objectID: 'gen-001', images: ['not-gen-001.jpg'] }) as any, manifest)
    expect(e).toMatchObject({ isAIGenerated: false, isExternalImage: true })
  })

  it('tolerates images being a bare string rather than an array', () => {
    const e = enrich({ ...item(), objectID: 'gen-001', images: '/images/gen-001.jpg' } as any, manifest)
    expect(e).toMatchObject({ hasImage: true, isAIGenerated: true })
  })

  it('synthesizes an imagePrompt when the item has none, and flags which it is', () => {
    const auto = enrich(item({ name: 'Tote', fit: 'unisex', tags: [], imagePrompt: undefined }) as any, manifest)
    expect(auto).toMatchObject({ hasCustomPrompt: false, imagePrompt: 'Tote' })

    const custom = enrich(item({ imagePrompt: 'a very specific tote' }) as any, manifest)
    expect(custom).toMatchObject({ hasCustomPrompt: true, imagePrompt: 'a very specific tote' })
  })
})

describe('toStoredSchema', () => {
  it('keeps only the persistable source fields', () => {
    const stored = toStoredSchema({
      systemName: 'Algolia', raw: '{}', referenceUrl: 'https://x',
      hasStandardSchema: false, schemaNote: 'note', referenceTitle: 'T',
      rawPaste: 'pasted', systemVersion: 'v2',
      // derived — must not be persisted
      fields: ['a', 'b'], sample: { a: 1 }, tree: {},
    })
    expect(Object.keys(stored!).sort()).toEqual([
      'hasStandardSchema', 'raw', 'rawPaste', 'referenceTitle',
      'referenceUrl', 'schemaNote', 'systemName', 'systemVersion',
    ])
  })
  it('keeps hasStandardSchema:false rather than dropping it as falsy', () => {
    expect(toStoredSchema({ hasStandardSchema: false })).toEqual({ hasStandardSchema: false })
  })
  it('returns undefined for nothing worth storing', () => {
    expect(toStoredSchema(null)).toBeUndefined()
    expect(toStoredSchema({})).toBeUndefined()
    expect(toStoredSchema({ fields: ['a'] })).toBeUndefined()
  })
})
