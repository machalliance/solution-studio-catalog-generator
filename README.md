# Product Catalog Generator

A local tool for spinning up realistic demo product catalogs — AI-generated product data, AI-generated (or hand-linked) images, and configurable export maps to push that data into the shape a real target system expects (BigCommerce, Coveo, Algolia, or anything else you can describe).

It's built for people building demos and integrations, not for running a real storefront. There's no checkout, no real inventory, no customer accounts — just a fast way to get believable product data, with images, into whatever shape a downstream system needs to see.

---

## What it does

- **Generates product data** — single items by hand, or a batch of items from a natural-language prompt ("12 minimalist ceramic vases, $40–120") via Claude.
- **Generates product images** — via OpenAI (`gpt-image-1`, `gpt-image-2`, `dall-e-3`, or `dall-e-2`, configurable in Settings), using a base image prompt per catalog plus a per-product description. An existing image can also be edited in place ("Tweak") rather than regenerated from scratch. Every generated image is post-processed to force a genuinely pure `#ffffff` background — the model consistently renders "white" a few units off no matter how the prompt is worded, so this is pixel correction (a tolerant flood-fill from the image edges), not prompt engineering. See the `whitenBackground()` implementation notes in `api.ts` for how it avoids bleeding into white/light-colored products.
- **Organizes products into catalogs and categories** — a "catalog" (called a *site* internally) is a top-level vertical like Clothing or Home, each with its own categories and its own base image prompt. The same category name can exist independently in two different catalogs.
- **Builds export field maps** — define how your catalog's fields map onto a target system's schema (dotted paths, array grouping, transforms, computed fields), preview the result against a real product, then run or download it as JSON + a zip of the referenced images.
- **Exposes a read-only (+ limited write) REST API** for other services to consume the catalog directly, separate from the local web UI.

## What it doesn't do

- **It's not a real commerce backend.** No checkout, no payments, no real inventory tracking, no customer accounts.
- **No database.** Products are flat JSON files on disk (Algolia-style `hits` arrays), one file per category. Fine for demo-scale catalogs; not built for anything approaching production scale.
- **No live external catalog source.** You can't point this app at another live system and have it transparently read/write through that connection — the whole data layer is synchronous local-file I/O, and wiring in a genuinely external source would mean converting most of `api.ts` to async. See the code comments in `api.ts` under `loadFixture`/`saveFixture` for the specifics of why, and the smaller "one-time import" alternative that was scoped but not built.
- **No authentication on the local UI's own API.** `/api/*` (everything the web UI itself calls — image generation, edits, deletes, backup restore) is unauthenticated by design, since this is meant to run locally for one person. Don't expose that port to anything but `localhost` without adding auth. The separate `/catalog/*` surface (for other services to consume) *is* token-gated — see **Auth** below.
- **No automated tests.** Verification in this project has been manual/curl-based throughout its development.
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

Either way, you'll need at minimum an `ANTHROPIC_API_KEY` (product copy, prompts) and an `OPENAI_API_KEY` (image generation) in `.env`. See **Environment variables** below for the full list.

> **Catalog data lives outside this repo by default.** `docker-compose.yml` bind-mounts `../greeter/catalog/fixtures` and `../greeter/catalog/images` — the Greeter project owns this content, not part of this checkout — so a bare `git clone` of just this repo starts with an empty catalog (the app runs fine, there's just nothing in it yet). Either check out `greeter` alongside this repo, or point `CATALOG_PATH`/`IMAGES_PATH` at wherever you'd rather keep product data, then add your first catalog/category from Settings.

> Editing `src/products/api.ts` or `ui.html` takes effect immediately under Docker (bind-mounted, `tsx watch`). Editing JSON under `data/exports/` or `data/catalog/` also takes effect on the next request — nothing is cached. The one thing that needs a full `docker compose up --build` is adding a new npm dependency to `package.json`.

---

## How it's put together

- **Backend:** [Hono](https://hono.dev/) on `@hono/node-server`, all routes in `src/products/api.ts`. No ORM, no build step for the server — just TypeScript run through `tsx`.
- **Frontend:** a single file, `src/products/ui.html` — plain HTML/CSS/JS, no framework, no bundler. Served via `readFileSync` on every request.
- **Data:** flat JSON files under `data/catalog/` (product fixtures, Algolia `hits` shape) and `data/images/` (generated/uploaded images), both bind-mountable so they can be shared with other local tools.
- **AI providers:** Claude for text (product copy, image prompts, export-map drafting), OpenAI for images. Both are called only from `api.ts` — never import either SDK anywhere else.

**Headless and API-first by construction, not just by description:** the web UI (`ui.html`) and the `/catalog` REST API are separate, independent consumers of the same catalog data — the UI has no access the API doesn't also expose. That's proven in practice, not just in principle: Greeter, a separate project, is a second real frontend that consumes this catalog purely through `/catalog`, with no dependency on this project's own UI at all.

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

## Auth

- **`/catalog/*`** — read-only-by-default REST API for other services to consume the catalog (`GET /catalog?category=&site=&style=&limit=&offset=`, `GET /catalog/:objectID`), plus a small authenticated write surface for image management (`POST /:objectID/generate`, `DELETE /:objectID/image`). Gated by `STUDIO_API_TOKEN` if set — send `Authorization: Bearer <token>`.
- **`/api/*`** — everything the local web UI itself uses. No auth. Local/single-user by design; several routes are destructive (delete, backup restore) or trigger billed API calls. Don't expose this beyond `localhost`.

---

## Environment variables

```
ANTHROPIC_API_KEY=      # required — product copy, prompts, export-map drafting
LLM_CLAUDE_CHAT=        # e.g. claude-sonnet-4-6
LLM_CLAUDE_FAST=        # e.g. claude-haiku-4-5-20251001

OPENAI_API_KEY=         # required for image generation
LLM_OPENAI_CHAT=        # e.g. gpt-4o
LLM_OPENAI_FAST=        # e.g. gpt-4o-mini

PORT=3004
CATALOG_PATH=           # product JSON fixtures — defaults to /app/data/catalog in Docker
IMAGES_PATH=            # generated/uploaded images — defaults to /app/data/images in Docker
STUDIO_API_TOKEN=       # bearer token for the /catalog/* API — omit to leave it open
```

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
