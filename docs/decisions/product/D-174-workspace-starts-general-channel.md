# D-174. A workspace starts with one channel, `general`, its creator in it — amends D-123 §5

**Context.** Making a workspace made the workspace and its owner's membership and nothing else
(`modules/workspaces/workspaces.ts`). The person who had just made it landed on *Pick a channel* with
nothing to pick, and the first person they invited before making one passed a welcome step that
offered nothing (D-132 §5) and landed on the same empty screen. The first five minutes of the product
were two empty states. Slack- and Linear-class products start a workspace with a place to talk.
Decided under the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **A new workspace starts with one public channel named `general`**, its creator in it
   (`DEFAULT_CHANNEL_NAME`, `packages/types`). Made in the transaction that makes the workspace, by the
   same `createChannel` a person's **New channel** runs, through the membership guard the creator has
   just passed: a workspace never exists without it, and it is a channel like any other from its first
   moment.
2. **On the trail as every channel made is**: `channel.created` by the creator (D-26), the first entry
   of every workspace's audit log.
3. **Named, not described.** A name is what the whole workspace finds a channel by (D-123 §1), and
   `general` is the one teams already know from every other chat product, Turkish-speaking ones
   included. **No topic:** the server would have to write it in one language, and the second person
   may read another. An owner who wants `genel` renames it.
4. **Nothing marks it afterwards.** No column, no flag: it is renamed, left and archived by D-123's rules,
   and a workspace whose people archive it is a workspace with no channel, as any other can become.
   D-123 §5's *there is no default channel* now reads: there is a first channel, and nothing protects it.
5. **An invitation still joins nothing** (D-115). The welcome step offers `general` with the rest of the
   public channels by D-132 §5's rules — silent, it is offered and not picked. Joining a channel is the
   person's choice; the step is where they make it.
6. **The creator lands in it.** The form goes to `/w/<slug>`, which opens the first channel the person
   is in (`workspace-home.tsx`): now `general`, never the welcome step, which is the invited person's.

**Rejected.**

- *A default channel joined by every invitation, Slack's `#general`.* It needs the channel marked (a
  column, and a rule for what happens when it is archived or renamed) and overrides D-115's choice that
  joining is the person's. The welcome step already puts it one tick away.
- *The name in the creator's language.* Two people in one workspace may not share one; a name is an
  identifier, not a sentence.
- *Making it in the client after the workspace is made.* Two requests, and a workspace with no channel
  whenever the second fails — the empty state this removes.
- *A welcome message posted in it.* Words nobody wrote, under somebody's name or a system's, in a
  product whose history is what people said.

**Cost of reversing:** one call in `createWorkspace`, the constant, their tests and the mutation entry;
the integration tests that stand on an API-made workspace name their own channel and would still pass.
No migration: channels already made stay.
