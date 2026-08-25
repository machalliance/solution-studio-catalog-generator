import { describe, it, expect, afterAll } from 'vitest'
import { createWorkspace, destroyWorkspace, item } from '../helpers/workspace.ts'

const ws = createWorkspace()
const {
  setNestedValue, getNestedValue, resolveSourceValue, resolveFileUrl,
  transformValue, applyExportMap, extractPaths, EXPORT_TEMPLATES,
} = await import('../../src/products/api.ts')

afterAll(() => destroyWorkspace(ws))

const field = (o: Partial<any> = {}) => ({
  source: 'name', target: 'name', transform: 'passthrough', include: true, ...o,
})

describe('setNestedValue', () => {
  it('writes a plain key', () => {
    const out: any = {}
    setNestedValue(out, 'name', 'Jacket')
    expect(out).toEqual({ name: 'Jacket' })
  })

  it('builds intermediate objects for a dotted path', () => {
    const out: any = {}
    setNestedValue(out, 'categories.lvl0', ['Apparel'])
    setNestedValue(out, 'prices.USD', 34.65)
    setNestedValue(out, 'prices.EUR', 30)
    expect(out).toEqual({ categories: { lvl0: ['Apparel'] }, prices: { USD: 34.65, EUR: 30 } })
  })

  it('replaces a non-object intermediate rather than throwing', () => {
    const out: any = { prices: 'nope' }
    setNestedValue(out, 'prices.USD', 1)
    expect(out).toEqual({ prices: { USD: 1 } })
  })

  it('replaces an array intermediate — an array is not a usable namespace here', () => {
    const out: any = { prices: [1, 2] }
    setNestedValue(out, 'prices.USD', 1)
    expect(out).toEqual({ prices: { USD: 1 } })
  })

  // The field targets come off the wire (a saved map, or the raw fields array POSTed to
  // /exports/preview), so a target naming a prototype key would otherwise land on
  // Object.prototype and be visible on every object in the process.
  it('refuses to write through __proto__, constructor or prototype', () => {
    const out: any = {}
    setNestedValue(out, '__proto__.polluted', 'yes')
    setNestedValue(out, 'constructor.prototype.polluted', 'yes')
    setNestedValue(out, 'a.prototype.polluted', 'yes')
    setNestedValue(out, '__proto__', 'yes')
    expect(out).toEqual({})
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
  })

  it('still allows a legitimate key that merely contains a reserved word', () => {
    const out: any = {}
    setNestedValue(out, 'constructor_name', 'x')
    setNestedValue(out, 'meta.prototype_id', 'y')
    expect(out).toEqual({ constructor_name: 'x', meta: { prototype_id: 'y' } })
  })
})

describe('getNestedValue', () => {
  const raw = { name: 'Jacket', images: ['a.jpg', 'b.jpg'], meta: { colour: { hex: '#fff' } } }
  it('reads plain and dotted paths', () => {
    expect(getNestedValue(raw, 'name')).toBe('Jacket')
    expect(getNestedValue(raw, 'meta.colour.hex')).toBe('#fff')
  })
  it('indexes into arrays by number', () => {
    expect(getNestedValue(raw, 'images.0')).toBe('a.jpg')
    expect(getNestedValue(raw, 'images.1')).toBe('b.jpg')
  })
  it('returns undefined for a missing path instead of throwing', () => {
    expect(getNestedValue(raw, 'nope')).toBeUndefined()
    expect(getNestedValue(raw, 'meta.nope.deeper')).toBeUndefined()
    expect(getNestedValue(null, 'a.b')).toBeUndefined()
  })
})

describe('resolveSourceValue', () => {
  it('reads a real catalog field', () => {
    expect(resolveSourceValue({ brand: 'Acme' }, 'brand')).toBe('Acme')
  })
  it('emits a fixed literal for the <compute:literal:X> virtual source', () => {
    expect(resolveSourceValue({}, '<compute:literal:Product>')).toBe('Product')
  })
  it('supports an empty literal', () => {
    expect(resolveSourceValue({}, '<compute:literal:>')).toBe('')
  })
  it('does not treat an unrelated angle-bracket source as a literal', () => {
    expect(resolveSourceValue({ '<x>': 1 }, '<x>')).toBe(1)
  })
})

describe('resolveFileUrl', () => {
  const withImage = { objectID: 'jacket-001', category: 'jacket', images: ['/images/jacket-001.jpg'] }

  it('returns null when the item has no picture — nothing honest to build from', () => {
    expect(resolveFileUrl({ images: [] }, 'https://cdn.example')).toBeNull()
    expect(resolveFileUrl({}, 'https://cdn.example')).toBeNull()
    expect(resolveFileUrl({ images: [123] }, undefined)).toBeNull()
  })

  it('returns the bare filename when no base is configured', () => {
    expect(resolveFileUrl(withImage, undefined)).toBe('jacket-001.jpg')
    expect(resolveFileUrl(withImage, '')).toBe('jacket-001.jpg')
  })

  it('joins base and filename, collapsing trailing slashes', () => {
    expect(resolveFileUrl(withImage, 'https://cdn.example/img')).toBe('https://cdn.example/img/jacket-001.jpg')
    expect(resolveFileUrl(withImage, 'https://cdn.example/img///')).toBe('https://cdn.example/img/jacket-001.jpg')
  })

  it('accepts a relative base — that doubles as the in-zip path', () => {
    expect(resolveFileUrl(withImage, 'assets/products')).toBe('assets/products/jacket-001.jpg')
  })

  it('substitutes <field> and {field} tokens from the item', () => {
    expect(resolveFileUrl(withImage, 'https://store.com/p/<objectID>/'))
      .toBe('https://store.com/p/jacket-001/jacket-001.jpg')
    expect(resolveFileUrl(withImage, 'https://store.com/{category}/{objectID}'))
      .toBe('https://store.com/jacket/jacket-001/jacket-001.jpg')
  })

  it('substitutes an unknown token with nothing rather than leaving it literal', () => {
    expect(resolveFileUrl(withImage, 'https://store.com/<nope>/x')).toBe('https://store.com//x/jacket-001.jpg')
  })

  it('takes the filename off a full external URL', () => {
    expect(resolveFileUrl({ images: ['https://old.cdn/deep/path/pic.png'] }, 'https://new.cdn'))
      .toBe('https://new.cdn/pic.png')
  })

  it('accepts images as a bare string', () => {
    expect(resolveFileUrl({ images: '/images/x.jpg' }, undefined)).toBe('x.jpg')
  })
})

describe('transformValue', () => {
  it('passes values through untouched by default', () => {
    expect(transformValue(['a', 'b'], 'passthrough')).toEqual(['a', 'b'])
    expect(transformValue(42, 'passthrough')).toBe(42)
  })
  it('takes the first array element for "first", nulling an empty array', () => {
    expect(transformValue(['a', 'b'], 'first')).toBe('a')
    expect(transformValue([], 'first')).toBeNull()
    expect(transformValue('a', 'first')).toBe('a')
  })
  it('joins an array for "join" and leaves a non-array alone', () => {
    expect(transformValue(['a', 'b'], 'join')).toBe('a, b')
    expect(transformValue('a', 'join')).toBe('a')
    expect(transformValue(undefined, 'join')).toBeUndefined()
  })
})

describe('applyExportMap', () => {
  const raw = item({
    objectID: 'jacket-001', name: 'Bomber', brand: 'Acme', price: 199,
    category: 'jacket', tags: ['bomber', 'wool'], images: ['/images/jacket-001.jpg'],
  })

  it('skips excluded fields and fields with no target', () => {
    const [out] = applyExportMap({ fields: [
      field({ source: 'name', target: 'name' }),
      field({ source: 'brand', target: 'brand_name', include: false }),
      field({ source: 'price', target: '' }),
    ] } as any, [raw])
    expect(out).toEqual({ name: 'Bomber' })
  })

  it('builds real nested objects from dotted targets', () => {
    const [out] = applyExportMap({ fields: [
      field({ source: 'category', target: 'categories.lvl0' }),
      field({ source: 'price', target: 'prices.USD' }),
    ] } as any, [raw])
    expect(out).toEqual({ categories: { lvl0: 'jacket' }, prices: { USD: 199 } })
  })

  it('groups a shared prefix[].subkey target into one array, naming each entry after its source', () => {
    const [out] = applyExportMap({ fields: [
      field({ source: 'style', target: 'custom_fields[].text' }),
      field({ source: 'fit', target: 'custom_fields[].text' }),
      field({ source: 'tags', target: 'custom_fields[].text', transform: 'join' }),
    ] } as any, [raw])
    expect(out).toEqual({
      custom_fields: [
        { name: 'style', text: 'smart-casual' },
        { name: 'fit', text: 'unisex' },
        { name: 'tags', text: 'bomber, wool' },
      ],
    })
  })

  it('groups by source when the same prefix has multiple subkeys', () => {
    const [out] = applyExportMap({ fields: [
      field({ source: 'name', target: 'variants[].sku' }),
      field({ source: 'name', target: 'variants[].label' }),
      field({ source: 'price', target: 'variants[].sku' }),
    ] } as any, [raw])
    expect(out).toEqual({
      variants: [{ sku: 'Bomber', label: 'Bomber' }, { sku: 199 }],
    })
  })

  it('drives site-url and image-url off their own separate bases', () => {
    const [out] = applyExportMap({
      fields: [
        field({ source: 'images', target: 'url', transform: 'site-url' }),
        field({ source: 'images', target: 'image_url', transform: 'image-url' }),
      ],
      siteBaseUrl: 'https://store.example/p',
      imageExportBase: 'https://cdn.example/i',
    } as any, [raw])
    expect(out).toEqual({
      url: 'https://store.example/p/jacket-001.jpg',
      image_url: 'https://cdn.example/i/jacket-001.jpg',
    })
  })

  it('emits null for a url field when the item has no picture', () => {
    const [out] = applyExportMap({
      fields: [field({ source: 'images', target: 'image_url', transform: 'image-url' })],
      imageExportBase: 'https://cdn.example',
    } as any, [item({ images: [] })])
    expect(out).toEqual({ image_url: null })
  })

  it('maps every item in the input, preserving order', () => {
    const out = applyExportMap(
      { fields: [field({ source: 'objectID', target: 'id' })] } as any,
      [item({ objectID: 'a' }), item({ objectID: 'b' })],
    )
    expect(out).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('ignores a prototype-polluting target', () => {
    const out = applyExportMap(
      { fields: [field({ source: 'name', target: '__proto__.polluted' })] } as any,
      [raw],
    )
    expect(out).toEqual([{}])
    expect(({} as any).polluted).toBeUndefined()
  })

  // The prefix[].subkey branch never reaches setNestedValue, so it needs the same guard:
  // out['__proto__'] = [...] hits Object.prototype's setter and replaces the record's
  // prototype rather than writing a field.
  it('ignores a prototype-polluting array-group prefix or subkey', () => {
    for (const target of ['__proto__[].text', 'constructor[].text', 'custom[].__proto__']) {
      const out = applyExportMap(
        { fields: [field({ source: 'name', target })] } as any,
        [raw],
      )
      expect(out, target).toEqual([{}])
      expect(Object.getPrototypeOf(out[0]), target).toBe(Object.prototype)
    }
  })

  // A legitimate array group still works — the guard checks the prefix, not the pattern.
  it('still emits an ordinary array group', () => {
    const out = applyExportMap(
      { fields: [field({ source: 'name', target: 'custom_fields[].text' })] } as any,
      [raw],
    )
    expect(out).toEqual([{ custom_fields: [{ name: 'name', text: raw.name }] }])
  })
})

describe('extractPaths', () => {
  it('flattens nested objects to dotted paths', () => {
    expect(extractPaths({ objectID: '1', prices: { USD: 1, EUR: 2 } }).sort())
      .toEqual(['objectID', 'prices.EUR', 'prices.USD'])
  })
  it('describes an array of objects via its first object member', () => {
    expect(extractPaths({ variants: [{ id: 1, sku: 'a' }] }).sort())
      .toEqual(['variants[].id', 'variants[].sku'])
  })
  it('marks an array of scalars, and an empty array, as a leaf array', () => {
    expect(extractPaths({ tags: ['a', 'b'], ids: [] }).sort()).toEqual(['ids[]', 'tags[]'])
  })
  it('returns nothing for an empty object', () => {
    expect(extractPaths({})).toEqual([])
    expect(extractPaths(null)).toEqual([])
  })
})

// The built-in templates exist precisely because the AI draft/refine flow drifted on
// these shapes, so their field lists are the contract — assert the pieces that broke
// before (custom_fields[].text, the nested price/category targets, objectID→sku).
describe('EXPORT_TEMPLATES', () => {
  it('ships the two hand-verified templates with unique keys', () => {
    expect(EXPORT_TEMPLATES.map(t => t.key)).toEqual(['algolia-bigcommerce-v2', 'coveo-commerce-v1'])
  })

  it('produces the documented BigCommerce shape when applied', () => {
    const tpl = EXPORT_TEMPLATES.find(t => t.key === 'algolia-bigcommerce-v2')!
    const [out] = applyExportMap(
      { fields: tpl.fields, imageExportBase: 'https://cdn.example' } as any,
      [item({ objectID: 'jacket-001', name: 'Bomber', category: 'jacket', price: 199, images: ['/images/jacket-001.jpg'] })],
    )
    expect(out).toMatchObject({
      objectID: 'jacket-001',
      sku: 'jacket-001',
      name: 'Bomber',
      categories: { lvl0: 'jacket' },
      default_price: 199,
      prices: { USD: 199 },
      in_stock: true,
      image_url: 'https://cdn.example/jacket-001.jpg',
    })
    // url is include:false in the template — it must not appear at all
    expect('url' in out).toBe(false)
    expect(out.custom_fields.map((f: any) => f.name))
      .toEqual(['style', 'fit', 'finish', 'colourFamily', 'colourHex', 'tags'])
    expect(out.custom_fields.every((f: any) => 'text' in f)).toBe(true)
  })

  it('produces the ec_-prefixed Coveo shape, including the literal objecttype', () => {
    const tpl = EXPORT_TEMPLATES.find(t => t.key === 'coveo-commerce-v1')!
    const [out] = applyExportMap({ fields: tpl.fields } as any, [
      item({ objectID: 'tile-004', name: 'Zellige', price: 12, tags: ['matte'], images: ['/images/tile-004.jpg'] }),
    ])
    expect(out).toMatchObject({
      documentId: 'tile-004',
      objecttype: 'Product',
      ec_product_id: 'tile-004',
      ec_variant_id: 'tile-004',
      ec_item_group_id: 'tile-004',
      ec_name: 'Zellige',
      ec_price: 12,
      ec_images: ['/images/tile-004.jpg'],
      tags: ['matte'],
    })
    // Coveo is array-native — tags must not have been joined into a string
    expect(Array.isArray(out.tags)).toBe(true)
  })

  it('never maps a template field to a prototype key', () => {
    for (const tpl of EXPORT_TEMPLATES) {
      for (const f of tpl.fields) {
        expect(f.target.split('.').some(k => ['__proto__', 'constructor', 'prototype'].includes(k))).toBe(false)
      }
    }
  })
})
