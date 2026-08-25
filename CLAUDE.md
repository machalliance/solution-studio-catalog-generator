# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # tsx watch src/server.ts → http://localhost:3004
npm start              # same, no watch
npm run typecheck      # tsc --noEmit (no build step exists; tsx runs TS directly)
npm test               # vitest run  (test/**/*.test.ts, excludes test/e2e)
npm run test:watch
npm run test:e2e       # playwright; starts its own throwaway server on :3010

npx vitest run test/unit/ssrf.test.ts            # single file
npx vitest run -t 'rejects v4-mapped loopback'   # single test by name
npx playwright test test/e2e/ui.spec.ts --headed

docker compose up --build                                  # the app, port 127.0.0.1:3004
npm run test:docker        # vitest inside the container image
npm run test:e2e:docker    # playwright against a containerized app (docker-compose.test.yml)

docker build --target test .   # one multi-stage Dockerfile: runtime (default), test, e2e
```

E2E specs can be pointed at an already-running instance instead of starting one:
`BASE_URL=http://localhost:3004 npx playwright test`.

## Architecture

Three files carry essentially the whole app:

- `src/server.ts` — bootstrap, `/images/:filename`, auth + CSRF middleware, `app.onError`. Exports `app` for tests.
- `src/products/api.ts` (~2k lines) — every backend route, all data access, both AI providers, the export engine. Split into two Hono routers: `imageGenRoutes` (mounted at `/api`) and `catalogRoutes` (mounted at `/catalog`).
- `src/products/ui.html` (~3.4k lines) — the entire frontend, plain HTML/CSS/JS inline, no framework or bundler, served via `readFileSync` per request. Nothing here is importable, which is why UI coverage is Playwright-only.

The code comments in `api.ts` are dense and treated as the authoritative design record — read them before changing behavior, and keep them current.

### Two API surfaces with different threat models

- `/api/*` — the UI's own backend. Unauthenticated by design (the UI has no token to send); protected by loopback-only publishing plus a same-origin check (`requireSameOrigin` in `server.ts`) because `c.req.json()` parses any Content-Type and would otherwise be CSRF-able. Several routes are destructive or trigger billed API calls.
- `/catalog/*` — for other services consuming the catalog as a backend. Gated by `STUDIO_API_TOKEN` bearer auth when the var is set.

The UI has no access the `/catalog` API doesn't also expose — keep it that way.

### Data layer: flat JSON, synchronous, no cache

Products live in Algolia-shaped fixtures (`{ hits: [...] }`), one file per category under `CATALOG_PATH`. All I/O is synchronous `readFileSync`/`writeFileSync`, re-read on every request. Introducing a live external catalog source would mean converting most of `api.ts` to async — the `loadFixture`/`saveFixture` comments explain why this was deliberate.

**Fixture naming is the subtlest rule in the codebase.** Category names are unique per-site, not globally. A name owned by 0 or 1 sites uses the legacy flat `algolia-<category>.json`; only when 2+ sites share a name does it become `algolia-<site>-<category>.json`. `fixtureFilename()` recomputes this from the *current* sharer count on every call, so adding/removing a category or site must migrate (add-category route) or de-migrate (`demigrateIfNoLongerColliding`) the file on disk, or the owner's data is orphaned.

Path config, all read once at module scope: `APP_ROOT` (default paths + backup tar base), `CATALOG_PATH`, `IMAGES_PATH`, `CONFIG_PATH`, `SITES_PATH`. Nothing sets these in normal operation except Docker and the tests.

### AI providers

Every model call goes through the Vercel AI SDK (`generateText` / `generateImage`), from `api.ts` only — never import a provider package anywhere else. Two entry points: `callText()` for all text, `callImageModel()` / `callImageEdit()` for images. Nothing in the codebase hardcodes a provider hostname.

Which models and which route are **config** (`config.json`, editable at runtime from Settings); endpoints and API keys are **env**. That split is a security boundary, not a style choice — `/api/config` is unauthenticated, so a base URL settable through it would let anyone reaching the port redirect billed calls and collect the key. `provider` is validated against the closed `PROVIDER_ROUTES` set and model IDs against `MODEL_ID` on every write.

Model IDs are `<provider>/<name>` everywhere. `resolveModel()` strips the prefix on the `direct` route (vendors want the bare name) and passes the qualified ID through on `gateway` / `openrouter` / `compatible`. Adding a route means adding one `PROVIDER_ROUTES` entry — `/api/settings`, the validator, and the UI dropdown are generic over it.

The app is meant to run against a **single** provider, and every route supports that — except `direct` with Anthropic alone, since Anthropic publishes no image models. `resolveModel()` turns the SDK's "No such imageModel" into a message naming that, because the operator's fix is a different route or an `openai/*` image model and the raw error points at neither. Note the OpenAI provider's text calls go to the **Responses** API (`/v1/responses`); the aggregators speak chat completions — the test stub has a builder for each.

Two deliberate non-portabilities, both documented at their call sites: `lookupSchemaWithWebSearch()` requires an `anthropic/*` model on the `direct` route (it uses Anthropic's server-side web search, which the aggregators don't carry) and refuses loudly rather than making a call that silently searches nothing; and image editing depends on the model, so a generation-only model fails with the provider's own message instead of being swapped out.

Provider errors reach the UI through `providerErrorMessage()`, which unwraps the SDK's `RetryError` and pulls the vendor's own message out of the raw response body — without it a 529 surfaces as "Failed after 3 attempts…" instead of "overloaded".

Generated images are always run through `whitenBackground()` — a tolerant flood-fill from the edges that forces a genuinely pure `#ffffff` background. It is local-delta based (`LOCAL_STEP`) rather than a global threshold specifically so it doesn't bleed into white or light-colored products.

Any route that fetches a user-supplied URL (`/exports/schema-from-url`) must go through `fetchPublicUrl` → `assertPublicUrl` → `isPrivateAddress`. Redirects are followed manually so every hop is re-checked; DNS is resolved and every returned address inspected. Don't replace this with a plain `fetch`.

### Export engine

`applyExportMap()` is deterministic — no LLM at export time. Fields are `{ source, target, transform, include }`; `target` supports dotted nesting and `prefix[].subkey` array grouping; `source` may be a virtual `<compute:uuid|timestamp|empty|literal:X>` (validated against a whitelist). `setNestedValue` guards `__proto__`/`constructor`/`prototype`.

Built-in templates live in the `EXPORT_TEMPLATES` array; appending an object there is the only change needed to add one — the list endpoint and UI are generic over it. Templates exist for targets whose real shape the AI draft flow gets wrong (see `applyKnownFieldOverrides` and BigCommerce `custom_fields`); verify field names against real docs before adding one.

## Testing

**Write the test before the code, and don't rewrite a test to make it pass.** When a test fails, the default assumption is that the code is wrong. Changing the test is a real option — but only for a reason you can name in a sentence, and the reason goes in a comment next to the change:

- The wire format changed but the requirement didn't (e.g. the AI SDK sends Anthropic's `system` as a block array rather than a bare string). Update the envelope the assertion unwraps; leave what it asserts alone.
- The behavior genuinely changed and the change is intended. Then the test should assert the *new* contract explicitly, not quietly lose the old guarantee — see `rejects a url-only response instead of writing a partial image` in `test/api/llm.test.ts`, which kept the "fail loudly, write nothing" requirement after the URL-following capability went away.

Never weaken an assertion, delete a case, or loosen a matcher just to get to green. A test that fails for a reason you can't explain is the test doing its job.

`api.ts` and `server.ts` resolve their data paths **once, at module scope**. Every test file therefore calls `createWorkspace()` (from `test/helpers/workspace.ts`) at top level to set the env vars, *then* dynamically `import()`s the module under test. Vitest runs `pool: 'forks'` with `isolate: true` so each file owns its process — a static import or a shared workspace will cross-contaminate.

Routes are driven in-process via Hono's `app.request()`, not over a port (`SKIP_LISTEN=1`). Because that builds a Request with no Host header, the helpers (`json()`, `noBody()`) inject matching `Host`/`Origin` to satisfy the same-origin middleware; the middleware tests override them deliberately.

All outbound network calls go through global `fetch`, stubbed per-test by `installFetchStub()` (`test/helpers/fetch-stub.ts`) with per-URL-pattern handlers and call recording. The AI SDK resolves global `fetch` per call, which is what lets the stub intercept model calls even though the module under test was imported first. Its response builders produce **complete** vendor envelopes on purpose — the SDK validates responses against the vendor's schema, so a partial stub fails as "Invalid JSON response" before the handler ever runs. Handlers match in registration order, so a broad pattern registered first shadows a narrower one registered later.

`sentSystem()` / `sentMessage()` unwrap Anthropic's block form when asserting on what was sent. `api.ts` internals are re-exported at the bottom of the file under a "Test surface" block for direct unit testing.

`writeConfig()` / `clearConfig()` seed `config.json`, which is how a test picks the provider route. Note it survives the per-test reset in every file's `beforeEach` — a test that depends on default config must clear it first.

`test/e2e` belongs to Playwright and is excluded from vitest. The E2E server runs with empty API keys on purpose — one spec asserts a missing key surfaces as a visible error.

### Accessibility

Audited with [`ezufelt/keyboard-a11y-tester`](https://github.com/ezufelt/keyboard-a11y-tester) — a keyboard-only + screen-reader persona driver, not a rule scanner. It is not a repo dependency; clone it and point it at a running instance:

```bash
node scripts/runner.mjs --url http://localhost:3004          # unattended crawl, both viewports
node scripts/runner.mjs serve --url http://localhost:3004 --goal "..."   # interactive, one keystroke at a time
```

Read its findings with judgment — the unattended crawl only visits the start page, so "live region never announced" means *not reached*, not *broken*. Confirm interactively before changing anything, and confirm a fix the same way.

Coverage: every view and every overlay — landing, product grid, item detail, the lightbox, both creator modes, exports (list, editor, new-map form, field-mapping table, category filter), snapshots, settings, toasts and the tweak/compare panel. Both viewports.

Conventions this audit established, all of which a rule scanner passes straight over:

- **Anything clickable must be a real control.** A `<span onclick>` or an `<a>` with no `href` is not focusable and has no role — it is mouse-only, and that is a 2.1.1 blocker. Use `<button type="button">` and reset the UA styling.
- **Text content beats `title` in the accessible-name calculation.** An icon button reading `⚙` or `×` announces as its glyph no matter what `title` says. Put the name in `aria-label` and mark the glyph `aria-hidden="true"`. Watch for repeated controls in a list — eight buttons all named "×" is a real barrier.
- **A live region announces on content change, not on becoming visible.** Toggling `display` or opacity on text that is already in the DOM announces nothing. Write the text when the event happens (`flashMsg()` does this) and start the region empty.
- **Swapping a view must move focus.** `setTab()` calls `_focusView()` to focus the revealed container, which is why each one carries `role="region"` and an `aria-label` — focusing a nameless `<div>` announces nothing.
- **A `placeholder` is not a label.** It satisfies a name check and then disappears as soon as someone types.
- **Anything that replaces what fills the screen must move focus into it.** `setTab()`, `selectCategory()`, `selectItem()` and `showCreator()` all call `_focusView()`, and every target carries a role and an `aria-label` — focusing a nameless `<div>` announces nothing. Without this, focus stays on a control that was just hidden and the browser drops it to `<body>`.
- **Only one real modal exists** (the lightbox) and it carries the full contract: `role="dialog"` + `aria-modal` + a name, focus moved in on open, Tab contained, Escape to close, focus restored to the trigger. Anything new that overlays the page owes the same.
- **Repeated rows need per-row names.** The export mapping table had a transform select, an include checkbox and a target select per row, all either unnamed or identically named, so it read as "combobox, combobox, checkbox" over and over. Each control names its source field.
- **Watch for raw quotes in generated attributes.** `aria-label="Remove "tile""` silently truncates to `Remove `. A previous fix here shipped exactly that bug and the next tester run caught it.

Known and accepted: WCAG 2.4.13 Focus Appearance (AAA) is not fully met — the bar here is AA. Focus rings on the dark nav were raised from ~1.8:1 to ~11:1; what remains is a few small controls and the skip link.

None of this is enforced by a test. The functional Playwright specs assert some of it incidentally (`toHaveAccessibleName` on the Models panel), but re-run the tester after touching `ui.html`.

## Notes

- One multi-stage `Dockerfile` with three targets — `runtime` (default, and what ships), `test` (Alpine, full deps; backs both the `unit` and `app-e2e` services) and `e2e` (Debian, because that's what Playwright ships browsers for). Compose selects them with `target:`. Stages are independent, so devDependencies can't reach the runtime image — don't add a `COPY --from=test` into it.
- Editing `src/**` takes effect immediately under Docker (bind-mounted + `tsx watch`); only a new npm dependency needs `docker compose up --build`.
- `docker-compose.yml` bind-mounts all four data directories from `./data/`, which a fresh clone doesn't have yet — the app starts with an empty catalog. Point `CATALOG_PATH`/`IMAGES_PATH` elsewhere to use existing product data.
