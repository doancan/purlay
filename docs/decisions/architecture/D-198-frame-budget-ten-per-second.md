# D-198. The frame budget is ten a second with a burst of sixty, decided from a measurement — closes O-4, amends D-66, D-81, D-84

**Context.** D-66's limiter was written with a working value, ten frames a second and a burst of twenty per
connection, and O-4 held the decision open until a week of a team's use could say whether any legitimate person
met it. Nothing now waits for a team (the phase no longer ends on one), so the number is decided from what a page
sends. `bun run measure:frames` (`apps/api/src/realtime/frame-profiles.ts`) runs each profile through the limiter
the server runs — the connection's bucket, and the user's write bucket a send is also charged to — and reports
the frames, the most in any second, the most at one instant and what was refused. What each profile assumes of
the client is pinned against the real engine and connection in `apps/web/src/realtime/frame-profiles.test.ts`.

**Measured** (the client says typing at most once per `TYPING_TTL_MS / 2` per channel, ACTIVE once a minute, a
ping per idle spell; a channel switch is no frame, because a page is subscribed to every channel its person is in):

| Profile | Frames | Peak per second | At one instant | Refused at 10 / 20 | Refused at 10 / 60 |
|---|---|---|---|---|---|
| Fastest typing (17 keys a second), 5 min | 117 | 3 | 3 | 0 | 0 |
| A short message every second, 5 min | 617 | 4 | 3 | 0 | 0 |
| A paste, sent | 2 | 2 | 1 | 0 | 0 |
| Four channels a second, a key in each | 240 | 4 | 1 | 0 | 0 |
| Eight channels a second, a key in each | 480 | 8 | 1 | 0 | 0 |
| Outbox of 20 sent on reconnect | 22 | 22 | 22 | 2 | 0 |
| **Full outbox (50) sent on reconnect** | 52 | 52 | 52 | **32** | 0 |
| Resubscribe 100 / 1,000 channels | 1 / 10 | 1 / 10 | 1 | 0 | 0 |
| Resubscribe 3,500 channels, 50 ms round trip | 35 | 20 | 1 | 0 | 0 |
| Resubscribe 3,500 channels, 20 ms round trip | 36 | 25 | 1 | 1 | 0 |
| Resubscribe 3,500 channels, 5 ms round trip | 37 | 22 | 1 | 2 | 0 |
| A flood of 500 at once | 500 | 500 | 500 | 480 | 440 |

Another tab is another connection with its own bucket, so several tabs change no row; the write bucket is the
user's, and a send it refuses is shown in the same table.

**Decision.**
1. **Ten frames a second, a burst of sixty** — per connection, and the same for a user's writes (D-81). The
   sustained rate is unchanged: no profile a person produces passes eight a second, and those that approach it are
   a key in a new channel every 125 ms. What was wrong was the burst: after a long disconnect the client sends
   every unsent message in one instant (`OUTBOX_MAX_MESSAGES`, fifty) beside the subscription and its upkeep —
   fifty-two frames, of which twenty were taken and thirty-two refused as `RATE_LIMITED`, which the client shows as
   a failed send. Sixty keeps eight frames over the worst profile.
2. **`FRAME_QUEUE_MAX` is sixty-four**, still above the burst (D-84): a connection inside its budget never meets
   it. A test holds the relation and a mutation tries it.
3. **The profiles stay as a test.** Every legitimate profile must pass with no refusal, a flood must still be
   refused, and the budget D-66 shipped with must still fail the full outbox — so a change to the outbox size, the
   typing interval or the subscription's chunk that outgrows the budget fails there, not in a person's session.
   `report:frames` stays as the check in use.

**Rejected.**
- *Keeping ten and twenty.* It refuses a person coming back from a gap with more than eighteen unsent messages, and
  the close for a full queue follows.
- *Pacing the client's resend instead.* Waiting for each answer, as subscriptions do (D-82), still sends faster than
  ten a second, and a `RATE_LIMITED` for a send is a failed message, not a retry; the right change is to the
  number, which the client is deliberately not told (D-82).
- *A higher sustained rate.* Nothing measured needs it, and it is the figure that bounds a flood that goes on.
- *A burst of one hundred.* More room than the outbox needs; it is also the size of the flood a connection may
  start with, and of the queue held behind it.

**Accepted.** A burst of sixty is a flood's first sixty frames instead of twenty, then ten a second; at most 64
frames of up to 64 KB wait per connection, which is a bound only a hostile client reaches (frames are a few hundred
bytes). Tabs that each hold the same stored outbox send each message once per tab: the id is the same, so the
server keeps one, and a refusal for the user's write bucket there is shown as a failed copy the other tab's
delivery has already answered.

**Reverses if** `report:frames` over a real stretch of use shows a legitimate refusal, or a peak above the burst
at the 99th percentile; or `OUTBOX_MAX_MESSAGES` is raised past the margin the test holds.
