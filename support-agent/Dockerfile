FROM node:22-alpine
WORKDIR /app
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
COPY evals ./evals
RUN npm ci && npm run build && npm prune --omit=dev \
  && rm -rf /usr/local/lib/node_modules/npm \
        /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm \
        /usr/local/bin/npx \
        /usr/local/bin/corepack \
  && mkdir -p /app/state && chown -R app:app /app
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "dist/main.js", "health"]
CMD ["node", "dist/main.js", "run"]
