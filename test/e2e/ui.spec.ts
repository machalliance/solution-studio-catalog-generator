import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// These run against a live server with a real (throwaway) catalog, in declaration order
// against shared state: the first spec builds the catalog the later ones navigate.
test.describe.configure({ mode: 'serial' })

const SITE_LABEL = 'E2E Home'
const SITE_ID = 'e2e-home'
const CATEGORY = 'tile'

// Toasts stack and linger, so several can be on screen at once — always match the one
// this assertion is about rather than "the toast".
function toast(page: Page, text: string | RegExp) {
  return page.locator('.toast').filter({ hasText: text }).first()
}

// The UI boots asynchronously (config, sites and items are all fetched before the first
// render), so wait for the site selector to be populated rather than for load alone.
async function openApp(page: Page) {
  await page.goto('/')
  await expect(page.locator('#currentSiteSelect option')).not.toHaveCount(0)
}

// A reload lands on the landing view, which keeps #mainLayout (and so the sidebar)
// hidden until the Products tab is opened — every navigation to the grid goes through
// selecting the catalog and the tab first.
async function openCategory(page: Page, siteId = SITE_ID, category = CATEGORY) {
  await page.selectOption('#currentSiteSelect', siteId)
  await page.click('#tab-products')
  await page.click(`#cat-${siteId}--${category}`)
  await expect(page.locator('.grid-header h2')).toHaveText(category)
}

async function deleteAllItems(request: APIRequestContext) {
  const groups = await (await request.get('/api/items')).json() as any
  const ids = groups.flatMap((g: any) => g.items.map((i: any) => i.objectID))
  if (ids.length) await request.delete('/api/items', { data: { objectIDs: ids } })
}

// The specs run against whatever instance BASE_URL points at — a throwaway container or
// one that's been up all afternoon — so they clear their own fixture first rather than
// assuming an empty catalog.
test.beforeAll(async ({ request }) => {
  await deleteAllItems(request)
  const sites = await (await request.get('/api/sites')).json() as any
  if (sites.some((s: any) => s.id === SITE_ID)) {
    for (const cat of sites.find((s: any) => s.id === SITE_ID).categories) {
      await request.delete(`/api/sites/${SITE_ID}/categories/${cat}`)
    }
    await request.delete(`/api/sites/${SITE_ID}`)
  }
})

test('serves the app shell', async ({ page }) => {
  await openApp(page)
  await expect(page).toHaveTitle(/Product Catalog Generator/i)
  await expect(page.locator('.nav-logo')).toHaveText('Product Catalog Generator')
  await expect(page.locator('#tab-products')).toBeVisible()
  await expect(page.locator('#tab-exports')).toBeVisible()
  await expect(page.locator('#tab-snapshots')).toBeVisible()
})

test('reports no unexpected console errors on boot', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await openApp(page)
  await page.waitForTimeout(500)
  expect(errors).toEqual([])
})

test('creates a catalog and a category from Settings', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-settings')

  await page.fill('#sNewSiteName', SITE_LABEL)
  await page.click('button:has-text("Add catalog")')
  await expect(toast(page, `Catalog "${SITE_LABEL}" added`)).toBeVisible()

  // the new catalog shows up in the settings list and in the nav switcher
  await expect(page.locator('#sitesSettingsList')).toContainText(SITE_LABEL)
  await expect(page.locator(`#currentSiteSelect option[value="${SITE_ID}"]`)).toHaveCount(1)

  await page.fill(`#sNewCat-${SITE_ID}`, CATEGORY)
  await page.press(`#sNewCat-${SITE_ID}`, 'Enter')
  await expect(toast(page, `Category "${CATEGORY}" added`)).toBeVisible()
  await expect(page.locator('#sitesSettingsList')).toContainText(CATEGORY)
})

test('shows the new category in the sidebar with a zero count', async ({ page }) => {
  await openApp(page)
  await page.selectOption('#currentSiteSelect', SITE_ID)
  await page.click('#tab-products')

  const catBtn = page.locator(`#cat-${SITE_ID}--${CATEGORY}`)
  await expect(catBtn).toBeVisible()
  await expect(catBtn).toContainText(CATEGORY)
  await expect(catBtn.locator('.cat-count')).toHaveText('0/0')

  await catBtn.click()
  await expect(page.locator('.grid-header h2')).toHaveText(CATEGORY)
  await expect(page.locator('.grid-sub')).toHaveText('0 / 0 images generated')
  await expect(page.locator('#grid .item-card')).toHaveCount(0)
})

test('adds a product through the New Item flow', async ({ page }) => {
  await openApp(page)
  await openCategory(page)

  await page.click('button:has-text("New Item")')
  await page.selectOption('#siCat', CATEGORY)
  await page.fill('#siName', 'Zellige Square — Sea Glass')
  await page.fill('#siTags', 'zellige, matte, handmade')
  await page.fill('#siBrand', 'Clé')
  await page.fill('#siPrice', '24.50')
  await page.click('#siCreateBtn')

  // The create step fires the AI describe/query calls, which fail with no API key
  // configured. That is expected here — the pending card must still appear and save.
  const pendingCard = page.locator('#creatorCards .creator-card')
  await expect(pendingCard).toHaveCount(1)
  await expect(pendingCard.locator('input[id$="-name"]')).toHaveValue('Zellige Square — Sea Glass')
  await expect(pendingCard.locator('input[id$="-brand"]')).toHaveValue('Clé')
  await expect(pendingCard.locator('.creator-card-cat')).toHaveText(CATEGORY)

  await page.click('#creatorActionBar .btn-solid')

  await expect(page.locator('#creatorPanel')).not.toBeVisible()
  const card = page.locator('.item-card', { hasText: 'Zellige Square' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('tile-001')
  await expect(card.locator('.badge-missing')).toContainText('no image')
  await expect(page.locator(`#cat-${SITE_ID}--${CATEGORY} .cat-count`)).toHaveText('0/1')
})

test('edits an item in the detail panel and persists it across a reload', async ({ page }) => {
  await openApp(page)
  await openCategory(page)
  await page.click('.item-card')

  await expect(page.locator('#detailPanel')).toHaveClass(/open/)
  await expect(page.locator('#nameInput')).toHaveValue(/Zellige Square/)

  await page.fill('#nameInput', 'Zellige Square — Renamed')
  await page.fill('#brandInput', 'Renamed Brand')
  await page.fill('#priceInput', '31')
  await page.press('#nameInput', 'Enter')
  await expect(page.locator('#metaSaveMsg')).toBeVisible()

  await page.reload()
  await expect(page.locator('#currentSiteSelect option')).not.toHaveCount(0)
  await openCategory(page)
  await expect(page.locator('.item-card')).toContainText('Zellige Square — Renamed')

  await page.click('.item-card')
  await expect(page.locator('#brandInput')).toHaveValue('Renamed Brand')
  await expect(page.locator('#priceInput')).toHaveValue('31')
})

test('surfaces a failed AI call as an error rather than failing silently', async ({ page }) => {
  await openApp(page)
  await openCategory(page)
  await page.click('.item-card')

  // No ANTHROPIC_API_KEY is configured for the e2e server, so this must fail visibly
  // rather than leaving the button spinning or doing nothing at all.
  await page.locator('button:has-text("✨")').first().click()
  await expect(toast(page, /not set|error/i)).toBeVisible()
})

// The Models panel is the only place the provider route is selectable, and the only UI
// coverage of it — api.ts is unit-tested, ui.html is not importable.
test('shows the provider routes and the keys each one needs', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-settings')

  // Every route api.ts knows about is offered, and the key status follows the selection
  // rather than being a fixed OpenAI/Anthropic pair.
  const provider = page.locator('#sProvider')
  await expect(provider.locator('option')).toHaveCount(4)
  await expect(provider).toHaveValue('direct')
  await expect(page.locator('#sRouteKeys')).toContainText('ANTHROPIC_API_KEY')

  await provider.selectOption('openrouter')
  await expect(page.locator('#sRouteKeys')).toContainText('OPENROUTER_API_KEY')
  await expect(page.locator('#sRouteKeys')).not.toContainText('ANTHROPIC_API_KEY')

  // The e2e server runs with no keys set, so this must read as missing, not configured.
  await expect(page.locator('#sRouteKeys')).toContainText('missing')

  // An unqualified model ID is rejected by the server and the reason is shown, rather
  // than being saved and failing later on a billed call.
  await provider.selectOption('direct')
  await page.fill('#sImageModel', 'gpt-image-1')
  await page.click('#sSaveModels')
  await expect(page.locator('#sModelErr')).toContainText('<provider>/<name>')

  await page.fill('#sImageModel', 'openai/gpt-image-1')
  await page.click('#sSaveModels')
  await expect(page.locator('#sModelMsg')).toBeVisible()
})

test('instantiates an export template and previews the mapping', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-exports')
  await expect(page.locator('#exportsView')).toBeVisible()

  // Scoped to the exports pane: the (hidden) landing view also has a "+ New item" button.
  await page.click('.exports-sidebar-hdr button:has-text("+ New")')

  // The built-in templates are offered without any AI call
  const template = page.locator('#exportEditorArea >> text=Start from a template')
  await expect(template).toBeVisible()
  // The innermost div holding both the template name and its own Use button — filtering
  // on the text alone also matches the wrapper divs and the bare title div.
  const row = page.locator('#exportEditorArea div')
    .filter({ hasText: 'Algolia Search with BigCommerce Integration' })
    .filter({ has: page.locator('button:has-text("Use")') })
    .last()
  await row.locator('button:has-text("Use")').click()

  // The editor opens on the instantiated map. Each row's target is a form control, so
  // read its value rather than the pane's text.
  await expect(page.locator('#exportEditorArea [id^="tsel-"]').first()).toBeVisible()
  // The callback runs in the browser; this project's tsconfig has no DOM lib (it is a
  // Node service), so the element is narrowed structurally rather than to an HTML type.
  const targets = await page.locator('#exportEditorArea [id^="tsel-"]')
    .evaluateAll(els => els.map(e => (e as unknown as { value: string }).value))

  expect(targets).toContain('custom_fields[].text')
  expect(targets).toContain('categories.lvl0')
  expect(targets).toContain('objectID')
  expect(targets).toContain('image_url')
  // the template maps several source fields onto the one custom_fields target
  expect(targets.filter(t => t === 'custom_fields[].text').length).toBeGreaterThan(1)

  await expect(page.locator('#exportMapList')).toContainText('Algolia Search with BigCommerce')
  await expect(page.locator('#emName')).toHaveValue('Algolia Search with BigCommerce Integration')
})

test('creates and lists a snapshot', async ({ page }) => {
  await openApp(page)
  await page.click('#tab-snapshots')
  await expect(page.locator('#backupsView')).toBeVisible()

  await page.click('#createSnapshotBtn')
  await expect(page.locator('#backupList')).toContainText(/products-\d{4}-\d{2}-\d{2}/, { timeout: 15_000 })
  await expect(page.locator('#backupList')).toContainText(/Restore/i)
})

test('the UI is reachable over the published port from outside the container', async ({ request }) => {
  // The app binds every interface; docker-compose is what narrows exposure to the host's
  // loopback. If this fails, the UI is unreachable from a browser on the host.
  const res = await request.get('/')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toMatch(/text\/html/)
  expect(await res.text()).toContain('Product Catalog Generator')
})
