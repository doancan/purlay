# Spike — fetching an external image without becoming an SSRF endpoint

**2026-10-12.** Bun 1.4.2, macOS arm64, run in a scratch directory with the network available.
Nothing in the repository was modified. For #110.

`ARCHITECTURE.md` §8.1 leaves external images as links "until the proxy exists". A proxy that fetches
whatever address a message contains is a server-side request forgery endpoint pointed at the internal
network; the defence #110 names — resolve first, refuse anything outside public unicast, then connect
to *that* address — is only as good as the client's ability to connect to the address it was told,
while still checking the certificate of the name it was asked for. A DNS answer checked in one step
and resolved again in the next is the classic rebinding gap. So the question: **can Bun connect to
an address we chose, for a name, with TLS verified against the name?**

## Verdict

| Question | Result |
|---|---|
| `fetch` with a custom resolver | **No** — Bun's `fetch` has no `lookup` option; it resolves the name itself |
| `node:https` `request` with a `lookup` option | **Honoured**, with Node's current contract: called with `{ all: true }`, answered with `[{ address, family }]` |
| The address connected to is `lookup`'s | **Yes** — a name that resolves nowhere, answered `127.0.0.1`, reached a local server |
| TLS still names the host (SNI) and checks its certificate | **Yes** — the real address: `200 image/png`; the name pinned to another site's address: handshake refused |
| A refusal inside `lookup` stops the request before any connection | **Yes** |
| **A kept-alive connection bypasses `lookup` entirely** | **Yes — the trap.** Through the default agent, the second and third requests to the same host reused the first one's socket: a different address and a refusal were both ignored, `200` both times. With `agent: false` each request resolves through `lookup` again |

## What had to be loosened

**Nothing**, and nothing was tried that would need it: no `rejectUnauthorized: false`, no custom
`checkServerIdentity`, no `NODE_TLS_REJECT_UNAUTHORIZED`. The certificate check is the platform's own.

## Commands and output

Step 1 — is `lookup` honoured, and is its address the one connected to (`step1.ts`: `http.get` to
`nowhere.invalid` on a local server's port, `lookup` answering `127.0.0.1`):

```
$ bun step1.ts
[["nowhere.invalid",{"hints":1024,"all":true}]] → host header: nowhere.invalid:52351
```

Step 2 — TLS through `lookup` (`step2.ts`: `https.get` to `avatars.githubusercontent.com`; 2a with the
real address, 2b with the name pinned to `example.com`'s address, 2c with `lookup` refusing):

```
$ bun step2.ts                      # default agent
2a. real address via lookup: 200 image/png
2b. pinned to example.com's address: 200 image/png       ← the first socket, reused
2c. refused in lookup: 200 image/png                    ← the first socket, reused

$ bun step2.ts                      # agent: false on every request
2a. real address via lookup: 200 image/png
2b. pinned to example.com's address: error: error:10000410:SSL routines:OPENSSL_internal:SSLV3_ALERT_HANDSHAKE_FAILURE
2c. refused in lookup: error: refused: private address
```

## What this decides for #110

- The proxy fetches with `node:https` / `node:http` `request`, never `fetch`, with a `lookup` that
  resolves every address, refuses the request if **any** is outside public unicast (loopback, private,
  link-local, CGNAT, multicast, reserved, documentation, IPv6 ULA and link-local, IPv4-mapped forms of
  all of them), and answers only the checked addresses — so what was checked is what is connected to.
- **`agent: false` on every request**, held by a test: a reused socket would skip the check.
- No redirect is followed (a `3xx` is no image), a byte cap and a wall-clock timeout bound it, no
  cookie or credential is sent, and what comes back is decoded and re-encoded (`images.ts`) before it is
  served, so a reader is never handed the origin's bytes or headers.
- What the spike did not measure: behaviour on Linux (the deployment), and IPv6 to a dual-stack host.
  Both belong in the implementation's integration test against a local server, which needs no network.
