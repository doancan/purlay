# syntax=docker/dockerfile:1
#
# The API image (#248, D-87).
#
# Two stages. The first has a shell and a package manager and installs the
# production dependencies; the second is distroless — the Bun runtime and our
# files, with no shell, no package manager and no coreutils for an attacker (or a
# curious operator) to reach for. Nothing is built: Bun runs the TypeScript the
# repository contains, which is also what the tests run, so there is no second
# artefact that could differ from the one that was tested.
#
# Both bases are pinned by digest. A tag is a pointer its owner can move
# (D-86); Dependabot's docker ecosystem proposes the next digest.
#   oven/bun:1.4.2-slim       sha256:cb3bbbb0...
#   oven/bun:1.4.2-distroless sha256:1a0c31c7...
# The tag is kept beside the digest so a reader (and the bot) can see what it is.

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS dependencies
WORKDIR /app

# The manifests alone first: this layer, and the install below it, are rebuilt only
# when a dependency changes, not on every edit to a source file. Every workspace's
# manifest is needed for the frozen lockfile to validate.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/tokens/package.json packages/tokens/package.json
COPY packages/types/package.json packages/types/package.json

# Production dependencies of the API and the packages it uses; no dev tooling, no
# React. `--frozen-lockfile` refuses to resolve anything the lockfile does not name.
RUN bun install --frozen-lockfile --production --filter @purlay/api

FROM oven/bun:1.4.2-distroless@sha256:1a0c31c7c5f9d193aedf60fe1cebdeb76ac8f6e29f24be8dd8cbd6df72df26ec AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=dependencies /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=dependencies /app/packages/types/node_modules ./packages/types/node_modules
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/src ./apps/api/src
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/src ./packages/db/src
COPY packages/db/migrations ./packages/db/migrations
COPY packages/types/package.json ./packages/types/package.json
COPY packages/types/src ./packages/types/src

# Not root, and not a name: distroless has no /etc/passwd entry to resolve, so the
# user is a number. Nothing in the image is owned by it — everything is root-owned
# and read-only to this user, which is what a read-only root filesystem needs.
USER 65532:65532

EXPOSE 3001

# Readiness, not liveness: a process that is up but whose database is down or whose
# migrations are pending should be reported as not healthy, and the same endpoint
# answers 503 while it drains (D-72). There is no curl in this image; the Bun
# runtime makes the request. `start-period` covers a first start that runs the
# migrations before the listener opens.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3001}/health/ready`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The entrypoint is `bun`; this is its argument. The process is PID 1 and handles
# SIGTERM itself (lifecycle.ts), so there is no init wrapper.
CMD ["apps/api/src/index.ts"]
