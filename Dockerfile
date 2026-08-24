FROM node:26-alpine
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
