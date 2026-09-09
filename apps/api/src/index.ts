/**
 * `apps/api` — Bun + ElysiaJS, one process.
 *
 * Layering is `ingress → modules → platform` and is enforced by lint, not by
 * convention: a module importing from `ingress` fails the build.
 * (ARCHITECTURE.md §4)
 */
export {};
