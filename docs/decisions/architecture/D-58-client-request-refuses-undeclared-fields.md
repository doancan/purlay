# D-58. What the client sends refuses what it did not declare

Measured, not assumed (`docs/spikes/elysia.md`): a request body carrying an undeclared property
returns **200**, and the property is silently dropped. TypeBox does not set
`additionalProperties: false` and the server framework does not add it.

That is the silent-swallow class this project refuses everywhere else. A client sending
`roleOverride: "owner"` is told it worked.

**So every shape the client sends is closed**, through one helper in `packages/types` rather than
per call site — including nested payloads, which is where a shallow rule would miss it. The set of
shapes is **derived rather than listed**: the socket frames come out of `ClientFrame` itself, which
by definition is everything a client may send, so a new frame cannot escape by not being added to
a list.

**Responses are deliberately left open.** Adding a field to something we produce must not break a
client that has not been rebuilt. The asymmetry is the point: strict about what we accept, additive
about what we emit.

**Rejected: tolerating unknown fields.** The usual argument is a third-party client on an older or
newer version. There is no third-party client, so the tolerance would buy nothing and cost a silent failure
mode. (D-51 once added: one client ships with the server. D-186 ends that for macOS: the app is updated on its
own schedule, which is why *responses* are additive and the app ignores fields it does not know — this rule
is about what the server accepts, and is unchanged.)
