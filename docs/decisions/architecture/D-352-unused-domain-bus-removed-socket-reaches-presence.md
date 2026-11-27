# D-352. The unused domain bus is removed, and the socket reaches presence and frame checks through slots — amends D-250, D-272, D-283

**Decided (the owner, 2026-11-27).** The in-process domain bus (`platform/domain-bus.ts`, added under D-250 rule 4) was built
and tested and never used: no module published or subscribed on it (D-272 §3, D-283 §1), a module could not reach it (no slot
or port handed it out), and it lived in one process, so in a cluster a hint published on one node was never heard on another.
The only hint that exists, presence, already goes over the socket's `EventBus`, which reaches every node through the backplane.
Reading the doors for the same audit found the socket (`ingress/ws/socket.ts`) importing three of chat's files (its presence
announcer and its two frame projectors) and the release route (`ingress/http/releases.ts`) importing chat's release check, two
of the three exceptions `module-seams.test.ts` allowed.

**What changed.**

1. **The domain bus is deleted**, with its test and its three mutations. A hint (a cache nudge, presence, "read again") goes
   over the socket `EventBus` and nothing else; a fact that must not be lost is still an outbox delivery or a port call in the
   caller's transaction (D-283 §1, §2). D-250 rule 4's "by events first" is now: by a hint on the socket bus or a fact in the
   outbox. A new in-process bus comes back only with a module that needs one and a reason it cannot use the socket bus.
2. **Presence is a slot.** `PresenceAnnouncer` (`platform/ports/presence.ts`) is how a change of who is online is told;
   `BundledModule.announcePresence` is chat's (`presence/presence.ts`), and `Composition.announcePresence` is it while chat
   runs and `undefined` otherwise. The socket counts nobody (`offlinePresence`) where it is `undefined` or `PRESENCE` is closed,
   as before. The count, the grace and the retries (`PRESENCE_RETRIES`, D-136 §7) stay the core's in `realtime/online.ts`,
   unchanged.
3. **The checks of live frames are a slot.** `FrameProjection` (`platform/ports/channel-delivery.ts`, beside the projector
   types it makes) is `BundledModule.frameProjection`, chat's, taken from every module the build carries whether or not it runs,
   as `workspaceChannels` is, so a frame is checked the same on every node as it was before; two modules with one stop the
   build.
4. **The release check is the core's.** `latestReleaseCheck` (D-248) knows no channel, and its route is a core claim, so it
   moves from `features/chat/integrations/` to `platform/latest-release.ts`, with its test and mutations.
5. `module-seams.test.ts` allows one door to name a module, `cli/erase-content.ts`, and its cap is one.

**Rejected.**

- *Keeping the bus for a future module*: it was proved by a test and by nothing else for months, and code nobody can reach is a
  claim the documents had to keep qualifying (D-272). Writing it again is about a hundred lines.
- *A cluster-wide bus in its place* (over the backplane): there is no consumer to design it for.
- *A `Port<T>` in `Composition.ports` for presence*: those are for a module's capability another module `uses`, handed per
  workspace; presence is asked by the core's socket once per node, as `pushNotices` is.
- *Moving only the presence announcer*: the socket would still import chat for the projectors, and the exception would stay.

**Cost of reversing.** Low: the bus is in the history (`6debca3e`), and the slots are two fields of `BundledModule` and
`Composition` and two lines of chat's module.
