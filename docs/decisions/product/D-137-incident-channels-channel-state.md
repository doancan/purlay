# D-137. Incident channels: an incident is a state of a channel — #487

*Amended by D-300: restricted guest history and the shared channel write mutex.*

**Context.** D-125 §2 put incident channels in Phase 2, from the Superdesign screen `incident-channel.html`:
a channel flagged as an incident shows severity, status (investigating → mitigating → resolved),
responders, a timeline of its changes, a runbook link and a postmortem draft. Nothing said what an
incident is, who may declare one, what a retry or a race does, or who is told. The owner delegated these
choices; they are recorded here.

**Decision.**
1. **An incident is a state of a channel, not a kind of channel.** A public or private channel may
   have one; a direct message or a group has none (`404`, as starring one). At most one is open in a
   channel at a time (`idx_incidents_one_open`); a resolved one stays, and declaring again opens
   another, which is the one shown. The channel keeps its name — the usual way is a channel made for
   it (`#inc-…`), then declared.
2. **Anyone in the channel declares, moves and resolves it.** In an incident speed is worth more than
   ceremony, and every change is on the incident's own timeline with who and when, so it is not an
   administrative action of the audit trail (D-26). Somebody who can see a public channel without being
   in it reads its incident and is refused a change (`403`, as renaming it, D-123 §1). An archived
   channel is gone for everyone (D-123 §2), its incident with it.
3. **What it holds:** a severity, 1 to 4, SEV1 the worst; a status, `investigating` or `mitigating`
   either way round, then `resolved` once and for good, with its instant (`INCIDENT_RESOLVED` after);
   responders, members of the channel, at most fifty, brought in and taken off by anyone in it —
   kept, and still changed, after it is resolved, since who worked on it is part of what is written up;
   nobody outside the channel can be brought in (`404 USER_NOT_FOUND`, one answer for every kind of
   outsider), and somebody who leaves it afterwards stays on the list — a record of who responded, as a
   message stays its author's, never a change made silently under everybody else; a runbook link,
   `https:` only, with a host, at most 2048 characters, changed and cleared while open and after; a
   postmortem draft, markdown, as long as a message may be, written while open and after. The
   postmortem has no author — several people write it — so erasing a person's content (D-27 §2) does
   not reach it, as it does not reach a channel's topic.
4. **Its timeline** is append-only: declared, status, severity — and, as they ship, responders and the
   runbook and postmortem saved — each with who and when, newest first, keyset on a UUIDv7 that is after
   the newest whatever the clock says. The postmortem's words are not copied into it; that it changed is.
5. **A retry and a race have one answer each.** A declaration carries the client's UUIDv7 (D-33): the
   same id, in this channel, at the severity it was declared at, answers the incident it made, `200`,
   and tells nobody — however late it comes, after the incident moved or was resolved and another
   declared; the id used in any other way — another channel's, perhaps another workspace's, or this
   one's at another severity — is `409 INCIDENT_ID_CONFLICT`, naming nothing. A retry racing its first
   attempt waits for it and is answered the same. Two declarations racing with
   different ids: the index lets one in, the other is `409 INCIDENT_OPEN`. Status, severity and
   responders change without a version, the last change winning, each on the timeline; asking for what
   is already there changes nothing and tells nobody. Only the postmortem — prose two people may be
   writing — is saved against the version it was edited from.
6. **Quiet** (D-12): declaring, adding a responder, resolving — none notifies anybody, in the app or by
   push. People in an incident are told by writing in its channel, by `@username`.
7. **Told as a reason to read again:** `INCIDENT_UPDATED` on the channel's topic, after the commit,
   with nothing but the channel in it; a client reads the incident again, and every list of channels
   holding that one, whose mark it is. The channel list carries the open incident's severity and status
   (`Channel.incident`), one join on the open index.
8. **Shown** as a banner under the channel's header — severity, status, since when, the responders,
   and what opens its panel — and in that panel: status and severity, responders, the runbook, the
   postmortem with its preview, the timeline. A channel's details declare one; the sidebar marks a
   channel whose incident is open with its severity. Built in steps, each working end to end: the
   incident and its timeline; the web; responders; the runbook and postmortem.

**Rejected.** *An incident channel type* — a type cannot be undone, and a channel outlives its incident.
*Each change posted in the feed as an event* — a second kind of authorless message (D-134 §6), its
migration and its contract, to say what the banner and the timeline already say. *Declaring for owners
and admins only* — the person who sees the fire first is rarely an admin. *A version on every change* —
somebody's status change refused because somebody else was writing the postmortem is the refusal an
incident cannot afford. *Notifying responders* — D-12. *A workspace's list of incidents* — not asked for;
the table holds what one would need.

**Cost of reversing:** the incident tables (`0035`, and those after it), the routes and the frame; no
other table changes, and no message carries an incident.
