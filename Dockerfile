# syntax=docker/dockerfile:1
#
# The API image (#248, D-87), and the built client it serves from the one origin (D-61).
#
# Three stages. The first has a shell and a package manager and installs the
# production dependencies; the second builds the client; the last is distroless —
# the Bun runtime and our files, with no shell, no package manager and no coreutils
# for an attacker (or a curious operator) to reach for. The API is not built: Bun
# runs the TypeScript the repository contains, which is also what the tests run, so
# there is no second artefact that could differ from the one that was tested. The
# client is built, because a browser runs a bundle; only its output, `dist`, reaches
# the final stage — no React toolchain, no source.
#
# Both bases are pinned by digest. A tag is a pointer its owner can move
# (D-86); Dependabot's docker ecosystem proposes the next digest.
#   oven/bun:1.4.3-slim       sha256:14a223fa...
#   oven/bun:1.4.3-distroless sha256:1aaa5150...
# The tag is kept beside the digest so a reader (and the bot) can see what it is.

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS dependencies
WORKDIR /app

# The manifests alone first: this layer, and the install below it, are rebuilt only
# when a dependency changes, not on every edit to a source file. Every workspace's
# manifest is needed for the frozen lockfile to validate.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY packages/tokens/package.json packages/tokens/package.json
COPY packages/types/package.json packages/types/package.json

# Production dependencies of the API and the packages it uses; no dev tooling, no
# React. `--frozen-lockfile` refuses to resolve anything the lockfile does not name.
RUN bun install --frozen-lockfile --production --filter @purlay/api

# The client: the same lockfile, every manifest (the install validates them all), and
# the sources the bundle is made of. Development dependencies are needed here and
# nowhere after.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS client
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY packages/tokens/package.json packages/tokens/package.json
COPY packages/types/package.json packages/types/package.json
RUN bun install --frozen-lockfile --filter @purlay/web
COPY packages/config ./packages/config
# The bundler follows the client's project references, so each referenced project's
# configuration is needed beside its sources.
COPY packages/markdown/tsconfig.json ./packages/markdown/tsconfig.json
COPY packages/markdown/src ./packages/markdown/src
COPY packages/tokens/src ./packages/tokens/src
COPY packages/types/tsconfig.json ./packages/types/tsconfig.json
COPY packages/types/src ./packages/types/src
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json ./apps/web/
COPY apps/web/public ./apps/web/public
COPY apps/web/src ./apps/web/src
# The push worker (#539, D-126) is an entry of its own, built beside the client.
COPY apps/web/worker ./apps/web/worker
RUN bun run --cwd apps/web build

FROM oven/bun:1.4.3-distroless@sha256:1aaa515018b0b37d95dbdebd55d1b7f37ad258a6289ba63e4bc3b9c9e3038697 AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    CLIENT_DIST=/app/apps/web/dist

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=dependencies /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=dependencies /app/packages/markdown/node_modules ./packages/markdown/node_modules
COPY --from=dependencies /app/packages/types/node_modules ./packages/types/node_modules
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/src ./apps/api/src
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/src ./packages/db/src
COPY packages/db/migrations ./packages/db/migrations
COPY packages/markdown/package.json ./packages/markdown/package.json
COPY packages/markdown/src ./packages/markdown/src
COPY packages/types/package.json ./packages/types/package.json
COPY packages/types/src ./packages/types/src
COPY --from=client /app/apps/web/dist ./apps/web/dist

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
