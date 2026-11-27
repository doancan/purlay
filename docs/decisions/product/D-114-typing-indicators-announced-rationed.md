# D-114. Typing indicators: announced by the client, rationed by the server, forgotten by both

`PRD.md` §4.1 puts typing indicators in the MVP, ephemeral and in memory (D-7); nothing of them
existed (#411). Served by #411 and the typing half of #60; decided in the owner's standing
instruction to decide and proceed, and open to their reversal.

**Decided:**
1. **A `TYPING` client frame names a channel; the room hears a `TYPING` server frame** naming the
   channel, the person and `ttlMs` — how long the announcement holds from when it arrives
   (`TYPING_TTL_MS`, six seconds, in `@purlay/types`). The sender is answered with nothing unless
   it is refused: an announcement is not a request.
2. **Authorised on every frame**, with the guard the send uses: a channel the sender cannot see is
   `CHANNEL_NOT_FOUND`, and neither its room nor the registry hears of it. A subscription is not
   used as the proof — `SUBSCRIBE` subscribes before it authorises (D-83, D-85), so for a moment a
   subscription exists that was never allowed — and an announcement held for it in that moment is
   dropped with the refusal, as every frame about a channel is (#412).
3. **The server rations, whatever the client does.** `PresenceRegistry.startTyping` lets an
   announcement reach the room when the person was not typing there, or once the last one is half
   spent; anything in between reaches nobody. A listener's window is renewed before it runs out, and
   a client announcing on every key costs the room one frame per three seconds. A message sent over
   the socket ends the window (`stopTyping`), so the next keystroke is news at once.
4. **Nothing says "stopped".** A listener forgets a person when the announcement runs out or their
   message arrives — so a closed tab, a lost connection or a restart clears itself, and there is no
   frame to lose.
5. **The registry's interface grows with its features** (`ARCHITECTURE.md` §6.1), as the frame union
   does (§5.2): the typing half now; online presence when it is built.

**Rejected:**
- *`typingIn` replayed on `SUBSCRIBE`.* A late subscriber hears the next announcement within half a
  window; a read that exists for those three seconds is an interface and a frame nobody needs yet.
- *A "stopped typing" frame.* It is the frame most likely to be lost — sent as a tab closes — and a
  lost one leaves a person typing forever; expiry cannot be lost.
- *Rationing only in the client.* The room's cost would then be whatever the most talkative client
  chose.

**Accepted, stated:** a message sent over HTTP does not end the sender's window on the server, so
their next keystroke within three seconds is not announced; listeners have already cleared them on
`MESSAGE_CREATED`. On two nodes each lets one announcement through for a person typing on both — a
frame too many, never a wrong answer (D-25). `PRD.md` §4.1 lists presence in Phase 1 and `UX.md` §2
in Phase 2: this decides typing only, and the owner decides where presence belongs.
*Since decided: Phase 2 (D-120).*
