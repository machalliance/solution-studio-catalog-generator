import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

// Automated accessibility coverage for the UI. axe catches the mechanical failures — an
// input with no accessible name, insufficient contrast, a control that isn't reachable —
// which is most of what regresses when markup is edited by hand in a 3.4k-line file with
// no component layer to enforce anything.
//
// It is a floor, not a ceiling: axe cannot tell whether a live region actually announces
// at a useful moment, or whether focus lands somewhere sensible after a view swaps. Those
// are asserted directly further down.

test.describe.configure({ mode: 'serial' })

// A catalog of its own, with a category name no other spec uses. Sharing a category name
// across two sites is what triggers the fixture-collision rename in api.ts, which would
// make this file's setup reach into what the functional specs see on the same server.
const SITE_LABEL = 'A11y Audit'
const SITE_ID = 'a11y-audit'
const CATEGORY = 'a11ytile'

// WCAG 2.1 A and AA — the level this project is held to. The `best-practice` tag is left
// out on purpose: it mixes in advisory rules that aren't conformance failures, and a
// failing build should mean a real barrier.
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(WCAG)
}

// Reports every violation with the specific nodes, so a failure names the element to fix
// rather than just a count.
function format(violations: any[]): string {
  return violations.map(v =>
    `\n[${v.impact}] ${v.id} — ${v.help}\n  ${v.helpUrl}\n` +
    v.nodes.map((n: any) => `  → ${n.target.join(' ')}\n    ${n.failureSummary?.replace(/\n/g, '\n    ')}`).join('\n'),
  ).join('\n')
}

async function expectNoViolations(page: Page, label: string) {
  const results = await scan(page).analyze()
  expect(results.violations, `${label}:${format(results.violations)}`).toEqual([])
}

async function openApp(page: Page) {
  await page.goto('/')
  await expect(page.locator('#currentSiteSelect option')).not.toHaveCount(0)
}

test.beforeAll(async ({ request }) => {
  const sites = await (await request.get('/api/sites')).json() as any
  if (!sites.some((s: any) => s.id === SITE_ID)) {
    await request.post('/api/sites', { data: { label: SITE_LABEL } })
    await request.post(`/api/sites/${SITE_ID}/categories`, { data: { name: CATEGORY } })
  }
  await request.post('/api/items', {
    data: { site: SITE_ID, category: CATEGORY, name: 'Zellige Tile', price: '42', tags: 'matte' },
  })
})

// The specs share one server, so this file has to leave the catalog as it found it —
// a leftover site shows up in the nav switcher every later spec reads.
test.afterAll(async ({ request }) => {
  const groups = await (await request.get('/api/items')).json() as any
  const ids = groups
    .filter((g: any) => g.skin === SITE_ID)
    .flatMap((g: any) => g.items.map((i: any) => i.objectID))
  if (ids.length) await request.delete('/api/items', { data: { objectIDs: ids } })
  await request.delete(`/api/sites/${SITE_ID}/categories/${CATEGORY}`)
  await request.delete(`/api/sites/${SITE_ID}`)
})

test('landing view has no WCAG A/AA violations', async ({ page }) => {
  await openApp(page)
  await expectNoViolations(page, 'landing')
})

test('product grid and detail panel have no WCAG A/AA violations', async ({ page }) => {
  await openApp(page)
  await page.selectOption('#currentSiteSelect', SITE_ID)
  await page.click('#tab-products')
  await page.click(`#cat-${SITE_ID}--${CATEGORY}`)
  await expectNoViolations(page, 'product grid')

  await page.click('.item-card')
  await expectNoViolations(page, 'item detail')
})

test('settings has no WCAG A/AA violations', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-settings')
  await expect(page.locator('#sProvider option')).not.toHaveCount(0)
  await expectNoViolations(page, 'settings')
})

test('exports has no WCAG A/AA violations', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-exports')
  await expect(page.locator('#exportsView')).toBeVisible()
  await expectNoViolations(page, 'exports')
})

// ── Beyond what axe can check ─────────────────────────────────────────────────

// Every form control needs a programmatic name. axe covers this, but naming the Models
// panel explicitly means a regression here points straight at the control rather than
// arriving as one entry in a page-wide scan.
test('every control in the Models panel has an accessible name', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-settings')
  for (const id of ['#sProvider', '#sTextModel', '#sTextModelFast', '#sImageModel']) {
    await expect(page.locator(id)).toHaveAccessibleName(/\S/)
  }
  await expect(page.locator('#sSaveModels')).toHaveAccessibleName(/save/i)
})

// Save feedback is rendered by unhiding an element. Without a live region a screen reader
// user gets no indication the save happened or was rejected — the visual "Saved" flash is
// the only signal, and it is gone in two seconds.
test('save feedback is announced, not just shown', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-settings')

  const err = page.locator('#sModelErr')
  await expect(err).toHaveAttribute('role', 'alert')

  const msg = page.locator('#sModelMsg')
  await expect(msg).toHaveAttribute('role', 'status')

  // and the error path actually populates it
  await page.fill('#sImageModel', 'gpt-image-1')
  await page.click('#sSaveModels')
  await expect(err).toBeVisible()
  await expect(err).toContainText('<provider>/<name>')

  await page.fill('#sImageModel', 'openai/gpt-image-1')
  await page.click('#sSaveModels')
  await expect(msg).toBeVisible()
})

// Key status is conveyed with a colour and a tick/cross glyph. Colour alone fails 1.4.1,
// and a bare glyph gives a screen reader nothing useful — there has to be text.
test('API key status is readable without colour', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-settings')
  const keys = page.locator('#sRouteKeys')
  await expect(keys).toContainText(/configured|missing/i)
})

// A keyboard user must be able to reach the primary navigation without a pointer.
test('the tab bar is reachable and operable by keyboard', async ({ page }) => {
  await openApp(page)
  const settingsTab = page.locator('#tab-settings')
  await settingsTab.focus()
  await expect(settingsTab).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#sProvider')).toBeVisible()
})
