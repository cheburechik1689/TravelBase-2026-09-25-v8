FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && cp node_modules/@electric-sql/pglite/dist/*.wasm \
      node_modules/@electric-sql/pglite/dist/*.data \
      node_modules/@electric-sql/pglite/dist/*.tar.gz \
      .vercel/output/functions/__server.func/_libs/ 2>/dev/null || true

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8080
# Boot straight into the built Nitro/Vite preview. PORT is honored when the
# platform injects it; otherwise the live-preview contract is 0.0.0.0:8080.
CMD ["sh", "-c", "echo '[boot] node:' $(node -v); echo '[boot] files:' $(ls .vercel/output/functions/__server.func/index.mjs) && exec npx vite preview --host 0.0.0.0 --port ${PORT:-8080}"]
