/**
 * The version of the wire contract: the models, the frames, the HTTP shapes and the error codes a
 * client built against one version may rely on.
 *
 * A browser client is served by the server it talks to, so it can never disagree with it. An installed
 * application is updated on its own schedule, and a server is upgraded on its operator's: the two will
 * meet in every combination. This number is how each side says what it speaks (`GET /api/client`, the
 * `X-Purlay-Client` header, `ARCHITECTURE.md` §7.2).
 *
 * **Bumped when a client built against the old contract would misbehave against the new server** — a
 * field removed or retyped, a meaning changed, a frame removed, an error code taking over another's job.
 * **Not bumped for an addition**: responses may gain fields, a union may gain a member the client treats
 * as unknown, a route may be added (D-58 — strict about what the server accepts, additive about what it
 * emits). A bump is a one-way door: it is a decision in `DECISIONS.md` before it is a number here
 * (`CONTRIBUTING.md` §6.8).
 */
export const CONTRACT_VERSION = 1;

/**
 * The version of the *bundle's own layout* — which files it holds and how each is written — bumped when a
 * generator reading the old layout would misread the new one. Not the contract's: a bundle of a changed
 * contract has the same layout (`apps/api/src/contract/bundle.ts`, D-192).
 */
export const CONTRACT_BUNDLE_FORMAT = 1;
