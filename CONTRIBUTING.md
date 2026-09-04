# Contributing

This is a prototype for building demos and reference implementations, not production software. Contributions are welcome on that basis — keep changes small, keep the tests honest.

## Setup

See [Getting started](GETTING_STARTED.md) for install, credentials, and first run.

## Commands

```bash
npm run typecheck   # tsc --noEmit (there is no build step; tsx runs TS directly)
npm test            # vitest run
npm run test:watch
npm run test:e2e    # playwright; starts its own server on :3010
```

Single test file or single test:

```bash
npx vitest run test/unit/ssrf.test.ts
npx vitest run -t 'rejects v4-mapped loopback'
npx playwright test test/e2e/ui.spec.ts --headed
```

In a container:

```bash
npm run test:docker
npm run test:e2e:docker
```

Run `npm run typecheck` and `npm test` before opening a PR. E2E is slower — run it when you've touched `ui.html` or a route it drives.

CI runs all three on every pull request (`.github/workflows/ci.yml`), plus the typecheck and unit suite again on Node 20.19 — the floor in `engines`. Running them locally first just means you find out sooner.

## Where the code is

Three files carry nearly the whole app:

- `src/server.ts` — bootstrap, image serving, auth and CSRF middleware.
- `src/products/api.ts` — every backend route, all data access, both AI entry points, the export engine.
- `src/products/ui.html` — the entire frontend, inline HTML/CSS/JS, no framework or bundler.

The comments in `api.ts` are the design record for this project. They explain why things are the way they are — the fixture-naming rules, the config/env security boundary, the synchronous I/O choice. Read them before changing behavior, and update them in the same commit when behavior changes. A change that leaves a comment describing the old behavior is incomplete.

`CLAUDE.md` is the condensed version of the same material.

## Testing rules

**Write the test before the code, and don't rewrite a test to make it pass.** When a test fails, the default assumption is that the code is wrong.

Changing a test is legitimate, but only for a reason you can state in one sentence, and that sentence goes in a comment next to the change:

- **The wire format changed but the requirement didn't.** Update the envelope the assertion unwraps; leave what it asserts alone.
- **The behavior genuinely changed and the change is intended.** The test then asserts the *new* contract explicitly — it doesn't quietly drop the old guarantee.

Never weaken an assertion, delete a case, or loosen a matcher to get to green. A test failing for a reason you can't explain is the test doing its job.

## Test conventions

- `api.ts` and `server.ts` resolve their data paths once at module scope. Every test file calls `createWorkspace()` (`test/helpers/workspace.ts`) at top level, then dynamically `import()`s the module under test. A static import cross-contaminates.
- Routes are driven in-process through Hono's `app.request()`, not over a port. The `json()` / `noBody()` helpers inject matching `Host` and `Origin` to satisfy the same-origin middleware.
- Outbound calls go through global `fetch`, stubbed by `installFetchStub()` (`test/helpers/fetch-stub.ts`). Its response builders produce complete vendor envelopes on purpose — the AI SDK validates responses against the vendor schema, so a partial stub fails before your handler runs. Handlers match in registration order.
- `writeConfig()` / `clearConfig()` seed `config.json`, which is how a test picks the provider route. It survives the per-test reset, so a test depending on default config must clear it first.
- Internals are re-exported at the bottom of `api.ts` under a "Test surface" block for direct unit testing.
- `test/e2e` belongs to Playwright and is excluded from vitest.

## Things that will get a PR sent back

- A new provider package imported outside `api.ts`. Every model call goes through the Vercel AI SDK from `api.ts` — `callText()` for text, `callImageModel()` / `callImageEdit()` for images.
- A base URL or endpoint made settable through `/api/config`. That route is unauthenticated; models and routes are config, endpoints and keys are env, and that split is a security boundary.
- A plain `fetch` on a user-supplied URL. Those go through `fetchPublicUrl` → `assertPublicUrl` → `isPrivateAddress`, with every redirect hop re-checked.
- Giving the UI access the `/catalog` API doesn't also expose.
- `devDependencies` reaching the runtime Docker stage. The stages are independent by design.

## Adding common things

- **An export template** — append an object to `EXPORT_TEMPLATES` in `api.ts`. The list endpoint and the UI are generic over the array; nothing else changes. Verify field names against the target's real docs, not general knowledge.
- **A provider route** — add one entry to `PROVIDER_ROUTES`. The settings endpoint, validator, and UI dropdown are generic over it.

## Style

Match the surrounding code. No emoji in code or commit messages.

## Pull requests

Branch off `main`, keep the change scoped to one thing, and say in the description what behavior changed and how you verified it. Note explicitly if you changed an existing test and why.

## Security

Don't open a public issue for a vulnerability. Report it privately through GitHub's security advisories on the repository.

## License

Contributions are licensed under the [MIT License](LICENSE).
