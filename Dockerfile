FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY src ./src
EXPOSE 3004
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:3004/health || exit 1
CMD ["node_modules/.bin/tsx", "watch", "src/server.ts"]
