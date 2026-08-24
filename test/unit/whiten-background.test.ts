import { describe, it, expect, afterAll } from 'vitest'
import { createWorkspace, destroyWorkspace } from '../helpers/workspace.ts'
import sharp from 'sharp'

const ws = createWorkspace()
const { whitenBackground } = await import('../../src/products/api.ts')

afterAll(() => destroyWorkspace(ws))

// Builds a raw RGB image from a per-pixel function, then encodes it as PNG.
async function makeImage(
  width: number, height: number,
  px: (x: number, y: number) => [number, number, number],
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y)
      const i = (y * width + x) * 3
      data[i] = r; data[i + 1] = g; data[i + 2] = b
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

interface Decoded { width: number; height: number; at(x: number, y: number): [number, number, number] }

async function decode(buf: Buffer): Promise<Decoded> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  return {
    width, height,
    at(x, y) {
      const i = (y * width + x) * channels
      return [data[i], data[i + 1], data[i + 2]]
    },
  }
}

// A centred square of `colour` on a background of `bg`.
const square = (bg: [number, number, number], fg: [number, number, number], size: number, box: number) =>
  (x: number, y: number): [number, number, number] => {
    const lo = (size - box) / 2, hi = lo + box
    return x >= lo && x < hi && y >= lo && y < hi ? fg : bg
  }

describe('whitenBackground', () => {
  it('snaps an almost-white background to exactly #ffffff', async () => {
    const src = await makeImage(32, 32, square([254, 253, 254], [20, 20, 20], 32, 8))
    const out = await decode(await whitenBackground(src))

    expect(out.at(0, 0)).toEqual([255, 255, 255])
    expect(out.at(31, 31)).toEqual([255, 255, 255])
    expect(out.at(2, 16)).toEqual([255, 255, 255])
  })

  it("leaves the product's own pixels untouched", async () => {
    const src = await makeImage(32, 32, square([254, 254, 254], [20, 30, 40], 32, 8))
    const out = await decode(await whitenBackground(src))
    expect(out.at(16, 16)).toEqual([20, 30, 40])
  })

  it('does not leak into a light-grey product that a global threshold would swallow', async () => {
    // 235 is well within "looks white-ish" but 20 units from the 254 background — a
    // global near-white threshold would erase it; the local-step check stops at the edge.
    const src = await makeImage(32, 32, square([254, 254, 254], [235, 235, 235], 32, 10))
    const out = await decode(await whitenBackground(src))
    expect(out.at(16, 16)).toEqual([235, 235, 235])
    expect(out.at(0, 0)).toEqual([255, 255, 255])
  })

  it('follows a soft lighting gradient across the whole frame', async () => {
    // Each column is one unit darker than the last — inside LOCAL_STEP, and the whole
    // range stays inside ABSOLUTE_THRESHOLD, so the fill should reach the far side.
    const src = await makeImage(12, 12, (x, y) => {
      const box = x >= 4 && x < 8 && y >= 4 && y < 8
      const v = 255 - x
      return box ? [10, 10, 10] : [v, v, v]
    })
    const out = await decode(await whitenBackground(src))
    expect(out.at(0, 0)).toEqual([255, 255, 255])
    expect(out.at(11, 0)).toEqual([255, 255, 255])
    expect(out.at(5, 5)).toEqual([10, 10, 10])
  })

  it('stops at the absolute bound even when every step is small', async () => {
    // A 4-per-column ramp is within LOCAL_STEP, but past ~3 columns it exceeds
    // ABSOLUTE_THRESHOLD (12 from pure white) and must stop being treated as background.
    const src = await makeImage(16, 4, x => {
      const v = 255 - x * 4
      return [v, v, v]
    })
    const out = await decode(await whitenBackground(src))
    expect(out.at(0, 0)).toEqual([255, 255, 255])   // 255 — in
    expect(out.at(3, 0)).toEqual([255, 255, 255])   // 243, exactly 12 off — still in
    expect(out.at(4, 0)).toEqual([239, 239, 239])   // 239, 16 off — out, untouched
    expect(out.at(15, 0)).toEqual([195, 195, 195])
  })

  it('leaves a background that is already pure white unchanged', async () => {
    const src = await makeImage(16, 16, square([255, 255, 255], [0, 0, 0], 16, 4))
    const out = await decode(await whitenBackground(src))
    expect(out.at(0, 0)).toEqual([255, 255, 255])
    expect(out.at(8, 8)).toEqual([0, 0, 0])
  })

  it('does not touch a dark region enclosed by the product — the fill only seeds from the border', async () => {
    // A white pocket in the middle of a dark blob is unreachable from the edges, so it
    // must survive rather than being whitened along with the real background.
    const src = await makeImage(24, 24, (x, y) => {
      const inBlob = x >= 6 && x < 18 && y >= 6 && y < 18
      const inPocket = x >= 10 && x < 14 && y >= 10 && y < 14
      if (inPocket) return [254, 254, 254]
      if (inBlob) return [30, 30, 30]
      return [253, 253, 253]
    })
    const out = await decode(await whitenBackground(src))
    expect(out.at(0, 0)).toEqual([255, 255, 255])
    expect(out.at(12, 12)).toEqual([254, 254, 254])
  })

  it('returns PNG bytes, not JPEG — the hard fill edge would ring under JPEG', async () => {
    const src = await makeImage(16, 16, square([254, 254, 254], [0, 0, 0], 16, 4))
    const out = await whitenBackground(src)
    expect(out.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect((await sharp(out).metadata()).format).toBe('png')
  })

  it('preserves the image dimensions', async () => {
    const src = await makeImage(20, 12, () => [254, 254, 254])
    const out = await decode(await whitenBackground(src))
    expect([out.width, out.height]).toEqual([20, 12])
  })

  it('accepts an image that already carries an alpha channel', async () => {
    const src = await sharp({
      create: { width: 12, height: 12, channels: 4, background: { r: 254, g: 254, b: 254, alpha: 1 } },
    }).png().toBuffer()
    const out = await decode(await whitenBackground(src))
    expect(out.at(0, 0)).toEqual([255, 255, 255])
  })
})
