# D-192. A client that is not the browser's own is generated from a bundle the server publishes with each release — builds on D-186, D-190

**Context.** The macOS application (D-186) lives in its own repository and cannot import `@purlay/types`. What it
has to agree with the server on is not a few shapes: the schemas, the routes, the limits, the error codes and the
status each is answered with, how a message id is made, what a message's markdown comes to, the colours. Copying
them by hand makes a second home for each, which `CONTRIBUTING.md` §6.1 forbids and which goes stale without a
sound; a client that is wrong about a rule the server enforces fails in front of a person.

**Decided.** `bun run contract:bundle` assembles, from the places that own each fact and from nowhere else, a
directory of plain files, and every GitHub Release carries it as `purlay-contract-<tag>.tar.gz` with its
`sha256`:

1. **`contract.json`** — every named schema of `@purlay/types` as JSON Schema, a schema met inside another written
   as `{"$ref": "<name>"}`; the endpoint table (D-190's `ENDPOINTS`) with each route's query, body and successful
   responses by name; an allowlist of the constants a client must know; every error `code` with its HTTP status;
   the socket's close codes. **The keywords a schema may use are a fixed vocabulary** (`SUPPORTED_KEYWORDS`): one
   outside it fails the server's build, because the alternative is a generator that quietly ignores a rule.
2. **`fixtures/`** — message-id vectors (what is made at known instants, what is refused, the plausibility
   window) and the markdown corpus with the tree the server's engine reads from each case. A second
   implementation passes the corpus or records each divergence; the corpus says that an address is the WHATWG
   parser's spelling, which is not always the typed one.
3. **`tokens.json`, `pairs.json`, `docs/`** — the visual values and which colours must be readable against which;
   `UX.md`, `API.md`, `ARCHITECTURE.md` and `DECISIONS.md` at this version.
4. **`MANIFEST.json`** — server version, contract version, the bundle's own layout version
   (`CONTRACT_BUNDLE_FORMAT`) and the digest of every file. The client pins the digest of the manifest and refuses
   a file that does not match it.

The output is **deterministic**: sorted, with no clock and no randomness, so two builds of one commit are one
bundle. `contract:bundle --check DIR` is exact in both directions. The release script builds the bundle **before**
the release exists, so a bundle that cannot be built, or comes out empty, leaves no release behind.

**Rejected.**

- *An OpenAPI document.* One more description of the contract to keep equal to the schemas it would be written
  from; what the generator needs is the schemas, which already are the contract.
- *Publishing `@purlay/types` as a package.* The client is Swift; a TypeScript package is of use to nothing it does.
- *The client reading the server's docs by hand.* That is the copy this replaces.
- *Fetching the contract from the running server.* A client built against a server that is not the one it will talk
  to is the failure D-190's minimum is there to refuse; a bundle is pinned at the version it was built for.

**Accepted.** A change to a schema's vocabulary is a change to the generator first, deliberately. The bundle is a
megabyte and a half, most of it the documents.

**Reverses if** the application is ever built in this repository, or a second non-browser client appears whose
generator wants a different shape: then the bundle is revisited, not copied.
