# D-268. What the person's own topic would have said is read again when the socket opens, the first time too — builds on D-85, D-124, D-128, D-136; amends D-194

**Context.** A frame on the person's own topic (`WORKSPACE_UPDATED`, `DEEP_WORK_UPDATED`, `SAVED_UPDATED`,
`NOTIFICATIONS_UPDATED`, `PRESENCE`) goes only to a socket that is open. A page reads the person, the members, the
inbox and who is online *before* its socket is, so what changed between a read and the socket's opening is in no
frame and in no read: a Deep Work started on another device while the page loaded stayed unseen until a reload. A
*re*connect already read these again (`resync`); the first open was left out as "the page loading", though the gap
is the same.

**Decision.**
1. **Every open reads again what the topic would have said**, the first included: the person (`me`, its
   memberships and Deep Work), the workspaces' members, and the inbox and saved lists **where they are cached** —
   `readUserTopicAgain` in the engine. Nothing is read that holds no data, and a read on its way is read once more
   when it lands (`readAgain`). Once per open: no timer, nothing per render.
2. **Who is online is not read before the socket has opened.** Its frames are heard from the open, so a snapshot
   asked for after it has no gap and costs no second read; one asked for before it has one. A page whose socket
   never opens draws no dots, as one that has lost it does.
3. **There is no cheaper question.** No route answers "has anything of mine changed since": the API has no
   version of the person to ask for, and adding one is a route, a counter on every write and a contract for the
   saving of one small read.

**Rejected.** *A `since` or version read*: see 3. *Reading presence again after opening, as well*: the snapshot
waits for the socket instead, which is the same correctness for no read. *Periodic reads*: a clock where a cause
exists. *Skipping what was read within some milliseconds of the open*: a read that finished a moment before the
handshake is exactly the one a change in the gap falls behind, and the page cannot tell its own fast load from a
slow one; the cost below did not ask for it. *Leaving the first open out*: the bug.

**Cost.** Two small reads per page load, whichever screen it opens on: `me` and the members, once more after the
socket has opened. Measured on a cold load in Chromium against a seeded workspace of 263 messages, eight loads each
of the workspace's root, a channel and Saved, before and after: 19, 21 and 13 requests became 21, 23 and 15, in every
run; the two added ones answer in about 6 ms each (`responseStart` less `requestStart`, same machine), and the
snapshot of who is online is still one. The inbox and the saved list cost a read each only where a screen holds them
when the socket opens (the inbox's panel and the Saved screen load after it, so a cold load pays nothing for them).
The channels' lists are read again by the subscription's answer (#1043), which a person in no channel never gets: a
channel added to their list in the gap waits for the next change. **Cost of reversing:** one call in `engine.ts` and
one condition in `presence-reader.tsx`.
