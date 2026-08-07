# ── Stage 1: Build ─────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

# Install build dependencies for pgvector client (optional, pg npm driver
# bundles its own; this is belt-and-suspenders)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────
FROM alpine:3.20 AS runtime

# Install Node.js 20 + npm from Alpine repos (far smaller than the official
# node:20-alpine image, which ships a full musl build tarball)
RUN apk add --no-cache nodejs npm ca-certificates

# Create non-root user
RUN addgroup -S -g 1001 appgroup \
    && adduser -S -u 1001 -G appgroup -h /home/appuser appuser

WORKDIR /app

# Copy build artifacts + production deps
COPY --from=build /app/dist/ dist/
COPY --from=build /app/package.json /app/package-lock.json ./

# Install build tools for native modules (e.g. bcrypt), install prod deps,
# then remove build tools to keep the image lean.
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev \
    && apk del python3 make g++ \
    && npm cache clean --force

# Switch to non-root user
USER appuser

EXPOSE 8080

# Uses Alpine's bundled wget for health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/server.js"]
