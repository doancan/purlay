# D-50. The client stays a single-page application, with a prerendered shell

Making load speed a first-class constraint reopens the question D-20 settled: React + Vite as a
single-page application, or server rendering.

**Decided: it stays an SPA, and the shell is prerendered to static HTML at build time.**

**Why not server rendering.** This is chat: people leave it open all day. A cold load happens once;
interaction latency happens thousands of times, and the product's central promise is an
interaction one — *keystroke → your own message painted, under one frame, never awaiting the
network* (D-17). Server rendering does not improve that and it fights the model the whole client is
built on: the Zustand optimistic buffer, ACK reconciliation and reconnect replay (D-18) all assume
the client owns this state, and a hydration boundary is where that assumption breaks.

**What the prerendered shell buys.** The application frame — sidebar, channel header, message-list
skeleton — is real HTML in the initial response, so the first paint is immediate and the JavaScript
fills it rather than creating it. Most of what server rendering would have bought for a
logged-in-all-day product, at none of the architectural cost.

**Cold load is met by shipping less, not by rendering elsewhere:** route-level code splitting,
lazily loaded highlighter grammars (D-36), one locale catalogue (D-41), and the budget in D-49
that fails the build when any of that slips.

**Trigger to revisit:** if the cold-load budget cannot be met with code splitting and a prerendered
shell, server rendering returns to the table — with a measurement behind it. Switching now would
trade a proven interaction model for an unmeasured fear.
