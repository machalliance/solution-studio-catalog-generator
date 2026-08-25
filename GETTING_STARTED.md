# Getting started

> **Prototype. Not production software.** This runs unauthenticated destructive routes on `/api/*`, stores everything in flat JSON files, and spends real money on model calls. Run it locally, in a container, or in a disposable sandbox — never on a public host or a shared network. See [Before you start](#before-you-start).

## Before you start

- **Don't put this on the public internet.** `/api/*` — image generation, edits, deletes, backup restore — has no authentication. Anything that can reach the port can call it.
- **Run it in a sandbox.** Docker (below) is the recommended path; a Docker Desktop sandbox, a devcontainer, a throwaway VM, or a Codespace all work. The supplied `docker-compose.yml` publishes to `127.0.0.1` only and runs with `no-new-privileges`.
- **Model calls cost money.** Image generation especially. There is no spend cap or usage tracking in the app — watch your provider dashboard.
- **Use a scoped API key.** Prefer a key you can revoke, with a spend limit set at the provider, over your main account key.

## Requirements

- Docker, or Node.js 20+ if running without it.
- An API key for at least one model provider. The default configuration uses Anthropic for text and OpenAI for images, so that means both keys — see [Models and providers](README.md#models-and-providers) for single-provider setups.

## 1. Get the code

```bash
git clone https://github.com/machalliance/solution-studio-catalog-generator.git
cd solution-studio-catalog-generator
```

## 2. Add credentials

```bash
cp .env.example .env
```

Edit `.env` and fill in the keys for the route you plan to use. For the default (`direct`) route:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Other routes (Vercel AI Gateway, OpenRouter, any OpenAI-compatible endpoint) need one key instead of two. The full variable list is in the [README](README.md#environment-variables).

`.env` is gitignored. Keep it that way.

## 3. Run it

**Docker (recommended):**

```bash
docker compose up --build
```

**Without Docker:**

```bash
npm install
npm run dev
```

Either way, open <http://localhost:3004/products>.

A fresh clone has no data. The app starts with an empty catalog — that's expected.

## 4. Create your first catalog

1. **Settings → Catalogs & categories → add a catalog.** A catalog is a top-level vertical (Clothing, Home, Outdoor) with its own categories and its own base image prompt. The base image prompt is what makes generated images look like a consistent set, so it's worth writing properly: describe the surface, lighting, and framing, not the product.
2. **Add a category or two** under that catalog.
3. **Check Settings → Models.** The defaults are `anthropic/claude-opus-5` for text and `openai/gpt-image-1` for images, on the `direct` route. Change the route here if you're using a gateway.

## 5. Add products

From the products view:

- **Add item** creates one product by hand.
- **Generate batch** takes a plain-language prompt — "12 minimalist ceramic vases, $40-120" — and produces the set: names, brands, tags, prices, categories. Review before generating images; text is cheap, images are not.

## 6. Generate images

Open a product and generate its image. Regenerate as often as you like, or use **Tweak** to edit an existing image with a short note ("darker wood background") instead of starting over.

Every generated image gets its background forced to pure `#ffffff` after the fact — models render "white" a few units off no matter how the prompt is worded.

## 7. Export

The Exports tab maps your catalog's fields onto whatever shape a target system expects.

1. Start from a built-in template (BigCommerce via Algolia, Coveo for Commerce) if one fits, or describe your target and let the AI draft a field map from a schema you paste or link.
2. **Preview it against a real product** before running it. The preview is the whole point — it's faster than debugging the target system's import errors.
3. Run it for JSON, or download a zip bundling the JSON with every referenced image.

Templates beat the AI draft flow for targets with nested or array-shaped fields. Details in [Developing exports further](README.md#developing-exports-further).

## Consuming the catalog from another service

`/catalog/*` is a separate REST surface for other services to read the catalog:

```bash
curl http://localhost:3004/catalog?category=vases&limit=10
```

Set `STUDIO_API_TOKEN` in `.env` to require `Authorization: Bearer <token>` on it. If anything outside your machine will call this, put a reverse proxy in front of `/catalog/*` and leave `/api/*` unreachable.

## Where things live

```
data/catalog/     product JSON, one file per category
data/images/      generated and uploaded images
data/exports/     saved export maps
data/backups/     tar.gz snapshots
```

All bind-mounted from the checkout under Docker, so you can read and edit them from the host, back them up, or point another local tool at them.

## Troubleshooting

**"No such imageModel" or a message about Anthropic image models** — Anthropic publishes none. Pair it with an `openai/*` image model, or switch routes.

**Schema lookup by web search refuses to run** — it needs an `anthropic/*` text model on the `direct` route; it uses Anthropic's server-side web search, which the aggregator routes don't carry. Pasting or linking a schema works everywhere.

**Tweak fails on an image** — editing depends on the model. `gpt-image-1` can edit, `dall-e-3` can't.

**Empty catalog after mounting existing data** — check `CATALOG_PATH` and `IMAGES_PATH`.

**Changes to `src/` not showing up** — they should; the container bind-mounts `src/` and runs `tsx watch`. Only a new npm dependency needs `docker compose up --build`.

## Next

- [README](README.md) — what the app does and doesn't do, architecture, the export engine, provider routing.
- [CONTRIBUTING](CONTRIBUTING.md) — running tests and sending changes.
