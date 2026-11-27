# D-34. Channel visibility is a second branded context, not a discipline

`WorkspaceContext` (`ARCHITECTURE.md` §7.3) makes the tenant filter structural, and D-21 argues
why: a rule that must hold on every endpoint forever will erode if it depends on remembering.
Authorization in this product has **two** axes, and only one of them got the treatment.

The second axis is channel visibility — private channels and DMs — and it was left to call
sites. Two endpoints specified today leak because of it:

- `GET /api/workspaces/:workspaceId/search` is scoped by `workspace_id` alone, so any member can
  search inside private channels and other people's DMs.
- `GET /api/workspaces/:workspaceId/unresolved` is worse: the open-questions view is the
  product's flagship screen and, as specified, it lists every workspace member's private
  discussions.

This is not a cross-tenant leak, but it matches D-21's test for severity exactly — silent,
unbounded, and impossible to un-leak.

**Decided: a second branded type, produced only by a guard.**

```typescript
/** Cannot be constructed by callers. Produced only by the channel guard,
 *  and only after verifying this user can see this channel. */
export interface ChannelContext {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly userId: string;
  readonly __brand: unique symbol;
}
```

Channel-scoped repository methods take a `ChannelContext` and apply the filter internally, so a
query that has not passed the guard does not compile — the same mechanism as §7.3, on the axis
that was missing it.

**Workspace-wide reads take a visible-channel set.** Search and the open-questions view ask the
guard for the channel ids this user can see and narrow with `channel_id = ANY($1)`. This is also
faster: it turns a workspace-wide trigram scan into a scan confined to a handful of channels.

**A third mandatory test class**, alongside the cross-tenant 404 of D-21: **intra-workspace
visibility** — a member of the workspace who is not in the channel gets 404, for every
channel-scoped endpoint and for both workspace-wide reads.

**Rejected — filtering at each call site.** That is the model D-21 already rejected in writing,
and it would be rejected here for the same reason, one axis over.

**Rejected — restricting search to public channels.** It closes the leak by removing the
feature; searching your own DMs is a normal thing to want.

**Accepted cost:** the visible-channel set grows with the workspace. At D-25's build target it is
tens of ids and inlines comfortably. Past a few hundred channels per member it becomes a
subquery instead of a parameter — a change of shape, not of design.
