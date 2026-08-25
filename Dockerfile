# One multi-stage build, three targets — `runtime` (the default), `test`, and `e2e`.
# Build a specific one with `--target`, or let compose pick it (see the `target:` keys in
# docker-compose.yml and docker-compose.test.yml).
#
# Stages are independent: nothing is COPYed from `test` into `runtime`, so devDependencies
# and the test tree cannot reach the shipped image even though they share a file. Keep it
# that way — a `COPY --from=test` here would quietly undo it.

# ── deps ──────────────────────────────────────────────────────────────────────
# Full install, shared by both test targets. Split out so editing src/ doesn't re-run npm.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── test ──────────────────────────────────────────────────────────────────────
# The vitest suite, and the app server the browser specs are driven against.
#
# node_modules is built inside the image rather than bind-mounted, which is also what makes
# this the reliable way to run the suite: sharp ships platform-specific binaries, and a host
# node_modules from a different OS/arch won't load here.
#
# Deliberately no extra tooling: /api/backups shells out to tar, and the point is to
# exercise it against the same busybox tar the runtime image has (which does accept the
# -czf/-xzf plus --no-same-owner/--no-same-permissions this app passes).
FROM deps AS test
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
# Drop to the base image's unprivileged user. /app is chowned first because npm ci and the
# COPYs above run as root, and both consumers of this target write inside it: vitest caches
# under node_modules, and the app-e2e service writes its throwaway data directory.
RUN chown -R node:node /app
USER node
CMD ["npx", "vitest", "run"]

# ── e2e ───────────────────────────────────────────────────────────────────────
# Browser specs. Debian rather than the Alpine base the app uses, because that is what
# Playwright supports and ships browser builds for — the app itself is exercised over HTTP,
# so the OS underneath the browser is not part of what's being tested. That different base
# is why this stage installs its own dependencies instead of building on `deps`.
FROM node:26-bookworm-slim AS e2e
WORKDIR /app
COPY package*.json ./
RUN npm ci
# Installs the Chromium build matching the @playwright/test version npm just resolved, plus
# its system libraries. Browsers land in a shared path rather than root's ~/.cache so the
# unprivileged user below can still find them; --with-deps needs apt, hence root here.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright
COPY tsconfig.json playwright.config.ts ./
COPY src ./src
COPY test ./test
# Playwright writes test-results/ and, under CI, playwright-report/ into /app, so it has to
# own that. Chromium itself is unaffected: Playwright runs it with its sandbox disabled.
RUN chown -R node:node /app
USER node
CMD ["npx", "playwright", "test"]

# ── runtime ───────────────────────────────────────────────────────────────────
# Last, so a plain `docker build .` with no --target produces the shipping image.
FROM node:26-alpine AS runtime
WORKDIR /app
COPY package*.json ./
# --omit=dev keeps typescript and the @types packages out of the runtime image.
# tsx is NOT dev-only here — it's the entrypoint (see CMD), so it lives in
# "dependencies" and survives the prune.
RUN npm ci --omit=dev
COPY src ./src
# data/ is written at runtime (backups, exports, the image manifest), so it has to
# exist and be owned by the unprivileged user before we drop root.
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3004
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:3004/health || exit 1
CMD ["node_modules/.bin/tsx", "watch", "src/server.ts"]
