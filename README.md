# Product Catalog Generator

A local tool for spinning up realistic demo product catalogs — AI-generated product data, AI-generated (or hand-linked) images, and configurable export maps to push that data into the shape a real target system expects (BigCommerce, Coveo, Algolia, or anything else you can describe).

It's built for people building demos and integrations, not for running a real storefront. There's no checkout, no real inventory, no customer accounts — just a fast way to get believable product data, with images, into whatever shape a downstream system needs to see.

---

## What it does

- **Generates product data** — single items by hand, or a batch of items from a natural-language prompt ("12 minimalist ceramic vases, $40–120") via whichever text model is configured.
- **Generates product images** — via the configured image model (`openai/gpt-image-1` by default; set in Settings, and reachable directly or through a gateway — see **Models and providers**), using a base image prompt per catalog plus a per-product description. An existing image can also be edited in place ("Tweak") rather than regenerated from scratch. Every generated image is post-processed to force a genuinely pure `#ffffff` background — the model consistently renders "white" a few units off no matter how the prompt is worded, so this is pixel correction (a tolerant flood-fill from the image edges), not prompt engineering. See the `whitenBackground()` implementation notes in `api.ts` for how it avoids bleeding into white/light-colored products.
- **Organizes products into catalogs and categories** — a "catalog" (called a *site* internally) is a top-level vertical like Clothing or Home, each with its own categories and its own base image prompt. The same category name can exist independently in two different catalogs.
- **Builds export field maps** — define how your catalog's fields map onto a target system's schema (dotted paths, array grouping, transforms, computed fields), preview the result against a real product, then run or download it as JSON + a zip of the referenced images.
- **Exposes a read-only (+ limited write) REST API** for other services to consume the catalog directly, separate from the local web UI.

## What it doesn't do

- **It's not a real commerce backend.** No checkout, no payments, no real inventory tracking, no customer accounts.
- **No database.** Products are flat JSON files on disk (Algolia-style `hits` arrays), one file per category. Fine for demo-scale catalogs; not built for anything approaching production scale.
- **No live external catalog source.** You can't point this app at another live system and have it transparently read/write through that connection — the whole data layer is synchronous local-file I/O, and wiring in a genuinely external source would mean converting most of `api.ts` to async. See the code comments in `api.ts` under `loadFixture`/`saveFixture` for the specifics of why, and the smaller "one-time import" alternative that was scoped but not built.
- **No authentication on the local UI's own API.** `/api/*` (everything the web UI itself calls — image generation, edits, deletes, backup restore) is unauthenticated by design, since this is meant to run locally for one person. Don't expose that port to anything but `localhost` without adding auth. The separate `/catalog/*` surface (for other services to consume) *is* token-gated — see **Auth** below.
- **No end-to-end guarantee of what the AI produces.** There is an automated test suite (`npm test`, plus Playwright specs under `test/e2e`), but it stubs every outbound model call — it checks what the app does with a response, not the quality of the response itself.
- **Image generation costs real money** (OpenAI billing) and there's no built-in spend tracking — keep an eye on your OpenAI usage dashboard.

---

## Quick start

**Docker (recommended):**
```bash
docker-compose up --build
# → http://localhost:3004/products
```

**Local dev (hot-reload, no Docker):**
```bash
npm install
npm run dev
# tsx watch src/server.ts → http://localhost:3004/products
```

Either way you'll need credentials in `.env`. Out of the box the app talks to Anthropic and OpenAI directly, so that means an `ANTHROPIC_API_KEY` (product copy, prompts) and an `OPENAI_API_KEY` (image generation) — but you can point it at Vercel AI Gateway, OpenRouter, or any OpenAI-compatible proxy instead and set that service's key alone. See **Models and providers** and **Environment variables** below.

> **A fresh clone starts with an empty catalog.** `docker-compose.yml` bind-mounts `./data/catalog` and `./data/images` from this checkout, which don't exist until the first run — the app comes up fine, there's just nothing in it yet. Add your first catalog and category from Settings, or point `CATALOG_PATH`/`IMAGES_PATH` at product data you already have.

> Editing `src/products/api.ts` or `ui.html` takes effect immediately under Docker (bind-mounted, `tsx watch`). Editing JSON under `data/exports/` or `data/catalog/` also takes effect on the next request — nothing is cached. The one thing that needs a full `docker compose up --build` is adding a new npm dependency to `package.json`.

---

## How it's put together

- **Backend:** [Hono](https://hono.dev/) on `@hono/node-server`, all routes in `src/products/api.ts`. No ORM, no build step for the server — just TypeScript run through `tsx`.
- **Frontend:** a single file, `src/products/ui.html` — plain HTML/CSS/JS, no framework, no bundler. Served via `readFileSync` on every request.
- **Data:** flat JSON files under `data/catalog/` (product fixtures, Algolia `hits` shape) and `data/images/` (generated/uploaded images), both bind-mountable so they can be shared with other local tools.
- **AI providers:** all model calls go through the [Vercel AI SDK](https://ai-sdk.dev/) from `api.ts` — never import a provider anywhere else. Text (product copy, image prompts, export-map drafting) and images are configured independently; see **Models and providers** below.

**Headless and API-first by construction:** the web UI (`ui.html`) and the `/catalog` REST API are separate, independent consumers of the same catalog data — the UI has no access the API doesn't also expose. Keeping that true is what lets another service use this catalog as a backend without depending on this project's own frontend.

For the full architectural detail — how sites/categories are scoped, the fixture-naming/collision rules, the export engine's field-transform semantics, the auth model, known gotchas — read the code comments in `src/products/api.ts`, which are kept dense and up to date with every change; this README is the higher-level tour.

---

## Using it

1. **Pick or create a catalog** (Settings → Catalogs & categories, or the nav dropdown once you have more than one). A catalog is a top-level vertical — Clothing, Home, whatever you're demoing — with its own categories and its own base image prompt.
2. **Add products** — single item, or describe a batch in plain language and let Claude generate the set (name, brand, tags, price, category) before you generate images for them.
3. **Generate images** from the product's detail panel — regenerate anytime, or edit one in place with a short note ("Tweak") instead of starting over.
4. **Build an export map** (Exports tab) — either start from a hand-verified template (BigCommerce via Algolia, Coveo for Commerce) or describe your target and let Claude draft a field map from a schema you paste in or link to. Preview it against a real product before running it.
5. **Run or download** — JSON only, or a zip bundling the JSON with every referenced product image, laid out so the whole thing is self-consistent if moved as a unit.

---

## Developing exports further

This is the part of the app built to be extended. The engine (`applyExportMap` in `api.ts`) is deterministic — not LLM-driven at export time — so once a map is built, running it is fast and predictable.

**Field shape:**
```ts
{ source: string; target: string; transform: 'passthrough' | 'first' | 'join' | 'image-url' | 'site-url'; include: boolean }
```
- `source` — a field name from the catalog item (`name`, `price`, `images`, …), or a virtual computed source (below).
- `target` — the destination field, dot-notation for nesting (`categories.lvl0`), or `prefix[].subkey` to group multiple source fields into one array of objects (e.g. BigCommerce's `custom_fields[].text` — see the shape note below).
- `transform` — `passthrough` (as-is), `first` (first element of an array), `join` (array → comma-joined string), or the two URL-builders below.

**`image-url` / `site-url` transforms** never fabricate a value. No base URL configured → just the product's image filename. Base configured → `base + filename`. Base containing `<field>` or `{field}` tokens (e.g. `https://store.com/prods/<objectID>/`) → that field's real value substituted in first. No image at all on the product → `null`.

**Virtual computed sources** (usable as `source`, resolved server-side, validated so nothing else can slip through):
- `<compute:uuid>` — new UUID per record
- `<compute:timestamp>` — current ISO timestamp
- `<compute:empty>` — null/empty (hidden from the field-mapping table's row list, still counted)
- `<compute:literal:X>` — the fixed string `X` on every record — for a required constant a schema demands (e.g. Coveo's `objecttype: "Product"`), never for real data that should come from the catalog.

**Adding a built-in template:** append an object to `EXPORT_TEMPLATES` in `api.ts` — `{ key, name, description, fields, targetSchema }`. The templates list endpoint and the UI's "start from a template" section are already generic over that array; no other code changes needed. Templates exist for integrations whose real shape the AI schema-lookup/draft/refine flow can't reliably reconstruct on its own — verify field names against real docs (or a live account) before adding one, not just the AI's general knowledge. See the `applyKnownFieldOverrides()` comment in `api.ts` for a concrete example of why this matters — BigCommerce's `custom_fields`:
```json
{ "id": 1, "product_id": 123, "name": "Style", "text": "smart-casual" }
```
The content field is `text`, not `value`; `id`/`product_id` are auto-assigned by BigCommerce and should never be mapped to.

**Prefer a template over the AI draft/refine flow** whenever the target has array fields mixing shared and per-entry sub-keys (the grouping engine only supports one subkey pattern per array), or deeply nested + dotted targets together. The AI flow works well for flat/simple targets but has repeatedly proven unreliable for that kind of structure.

**Ad-hoc site/category scoping:** `POST /exports/:id/run` and `/:id/download` take an optional `{ site, categories }` body, applied at run time — not saved on the map, so one map stays reusable across catalogs. Omit it entirely and you get everything (unchanged behavior for any external caller hitting these directly); pass `categories: []` explicitly and you get nothing — that distinction is deliberate.

---

## Models and providers

Every model call goes through the Vercel AI SDK, so which models you use and how you reach them are separate choices. Both live in Settings → Models.

**Model IDs are always `provider/name`** — `anthropic/claude-opus-5`, `openai/gpt-image-1`. Three are configured independently:

| Setting | Used for |
| --- | --- |
| Text model | Batch item generation, export-map drafting, schema lookup |
| Fast text model | Short, high-volume calls — image prompts, one-line descriptions |
| Image model | Product image generation, and the "Tweak" edit |

**The route** — how those models are reached — is one of:

| Route | Reaches | Needs |
| --- | --- | --- |
| `direct` | OpenAI and Anthropic themselves | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` |
| `gateway` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` |
| `compatible` | Any OpenAI-compatible endpoint — a proxy, LiteLLM, an internal gateway | `LLM_BASE_URL` (required), `LLM_API_KEY` |

On `direct` the `provider/` prefix picks the vendor and is stripped before the call; on every other route the qualified ID is passed through as-is, which is the form those services already expect. Adding a route means adding one entry to `PROVIDER_ROUTES` in `api.ts` — the settings endpoint, the validator, and the UI dropdown are all generic over it.

**One provider is enough** — `gateway`, `openrouter`, and `compatible` each cover text and images on a single key, and so does `direct` with OpenAI alone. The one exception is Anthropic: it publishes no image models, so `anthropic/*` can serve every text call in this app and no image call. Anthropic-only means either pairing it with an `openai/*` image model (the default configuration, which is why the quick start asks for both keys) or moving to one of the other routes. Selecting an Anthropic image model says exactly that rather than reporting a missing model.

**Endpoints and keys are environment-only, deliberately.** `/api/*` is unauthenticated by design (see **Auth**), so anything settable through it is settable by anyone who can reach the port. A model ID is inert; a base URL is not — pointing it at another host would redirect billed calls and hand over the API key with them. So `config.json` holds a route *name* validated against a closed set, and the URL it resolves to lives in `.env`.

**Two things don't travel across routes:**

- **Schema lookup by web search** (Exports → describe your target) uses Anthropic's server-side web search, which the aggregator routes don't carry. It requires an `anthropic/*` text model on the `direct` route and says so plainly otherwise. Pasting or linking a schema works on every route.
- **Image editing** ("Tweak") depends on the model, not the route — `gpt-image-1` can edit, `dall-e-3` is generation-only. A model that can't edit fails with the provider's own message rather than being silently swapped.

## Auth

- **`/catalog/*`** — read-only-by-default REST API for other services to consume the catalog (`GET /catalog?category=&site=&style=&limit=&offset=`, `GET /catalog/:objectID`), plus a small authenticated write surface for image management (`POST /:objectID/generate`, `DELETE /:objectID/image`). Gated by `STUDIO_API_TOKEN` if set — send `Authorization: Bearer <token>`.
- **`/api/*`** — everything the local web UI itself uses. No auth. Local/single-user by design; several routes are destructive (delete, backup restore) or trigger billed API calls. Don't expose this beyond `localhost`.

---

## Environment variables

**Which models get used, and how they're reached, are not environment variables** — they live in `config.json` and are edited from Settings → Models at runtime. The environment holds only credentials and endpoints. See **Models and providers** above for why the split falls there.

```
# Route: direct (the default) — straight at the vendors
ANTHROPIC_API_KEY=      # required for anthropic/* models
OPENAI_API_KEY=         # required for openai/* models

# Route: gateway / openrouter / compatible — set whichever you selected
AI_GATEWAY_API_KEY=
OPENROUTER_API_KEY=
LLM_BASE_URL=           # required by the "compatible" route — no default
LLM_API_KEY=

# Optional per-route endpoint overrides (a mirror, a regional endpoint, a proxy)
OPENAI_BASE_URL=
ANTHROPIC_BASE_URL=
AI_GATEWAY_BASE_URL=
OPENROUTER_BASE_URL=

PORT=3004
CATALOG_PATH=           # product JSON fixtures — defaults to /app/data/catalog in Docker
IMAGES_PATH=            # generated/uploaded images — defaults to /app/data/images in Docker
STUDIO_API_TOKEN=       # bearer token for the /catalog/* API — omit to leave it open
```

Upgrading from a pre-provider checkout: `LLM_CLAUDE_CHAT` and `LLM_CLAUDE_FAST` are gone — set the text models in Settings instead. An existing `config.json` carrying a bare `model` (e.g. `"gpt-image-1"`) is read forward automatically as `openai/gpt-image-1`, so a running install keeps the image model it had.

---

## Project layout

```
src/products/
  api.ts        # all backend routes (Hono)
  ui.html       # the entire frontend — single file, no build step
  sites.json    # catalog/category definitions (created on first use)
  config.json   # app settings (created on first use)
src/server.ts   # server bootstrap, static/image serving, auth middleware
data/
  catalog/      # product JSON fixtures, one file per category
  images/       # generated/uploaded product images
  exports/      # saved export map definitions, one file per map
  backups/      # tar.gz snapshots of catalog + images
```
