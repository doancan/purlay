# Spike — Web Push encryption and VAPID with Bun's WebCrypto, no dependency

**2026-10-13.** Bun 1.4.2, macOS arm64, run in a scratch directory. Nothing in the repository was
modified. For #78.

A push to a browser is an HTTP `POST` to the endpoint its push service gave it, with the payload
encrypted for that browser (RFC 8291, `aes128gcm`) and the request signed by the application server's
key (RFC 8292, VAPID: a JWT signed with ES256). The `web-push` package does both on Node's `crypto`.
`CONTRIBUTING.md` §1.12 prefers a platform API to a dependency, so the question: **does Bun's
`crypto.subtle` do every step, in the formats the RFCs need?**

## Verdict

| Question | Result |
|---|---|
| ECDH P-256 `deriveBits` with a JWK private key and a raw 65-byte public point | **Yes** |
| HKDF-SHA-256 `deriveBits` of 32, 16 and 12 bytes | **Yes** |
| AES-128-GCM `encrypt` with a 12-byte nonce | **Yes** |
| The whole of RFC 8291 Appendix A — same keys, salt and auth secret — gives the RFC's body byte for byte | **Yes** (`MATCH true`) |
| ECDSA P-256 / SHA-256 `sign` returns the 64-byte `r‖s` JWS wants (not DER) | **Yes** (`SIG 64`), and `verify` with the raw public point accepts it |
| `generateKey` gives a raw public point of 65 bytes and a JWK `d` of 43 base64url characters | **Yes** |

## What had to be loosened

Nothing. No dependency, no polyfill, no flag.

## Commands and output

```
$ bun run spike.ts
MATCH true
SIG 64 true
GEN raw pub 65 43
$ bun --version
1.4.2
```

The script is the RFC's Appendix A inputs run through `importKey` (JWK private, raw public),
`deriveBits` (ECDH, then HKDF for the IKM, the content-encryption key and the nonce), a padded record
(`plaintext ‖ 0x02`), `encrypt` (AES-GCM), and the header `salt ‖ rs(4096) ‖ idlen ‖ keyid`.

## What it does not show

Delivery through a real push service (FCM, Mozilla, Apple) — that needs a browser subscription and
the network; the shapes above are what those services accept, and the browser test registers a real
subscription in Chromium.
