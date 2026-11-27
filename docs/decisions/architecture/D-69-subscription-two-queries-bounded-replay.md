# D-69. A subscription costs two queries and a bounded replay, whatever it names

One `SUBSCRIBE` frame could name any number of channels, repeats included, for one rate-limit token
(#196). Each cost its own authorisation — three or four queries — and its own replay of up to a
page; a frame near the 64 KB cap was thousands of queries and tens of thousands of outbound frames,
ten times a second from one connection.

**Decided: bound the frame, and make its cost independent of its size.** At most
`SUBSCRIBE_MAX_CHANNELS` (100), each named once. Authorisation is one query over all of them, all or
nothing: the frame is refused if any is invisible, and nothing is subscribed first. Replay is one
query — `unnest` pairs each channel with its cursor and a lateral subquery reads each range by the
primary key — and the channels share a total of a thousand messages, a full page for one channel
and never fewer than ten each. What does not fit is continued over HTTP from the `nextCursor` D-65
added. A test counts the queries and requires one channel and thirty to cost the same.

**The visibility rule became one query for every entry point.** It had been written three times —
the nested guard, the by-id guard and the workspace-wide list — and the by-id guard swallowed every
error from the membership check into `CHANNEL_NOT_FOUND`, a database outage included, and answered
"never existed" faster than "exists elsewhere". All three now run one query builder: one round trip
whatever the outcome, and nothing caught that was not the guard's own refusal.

**Rejected: charging a rate token per channel.** The bucket's burst is twenty; a reconnect to forty
channels would be refused outright and have to be spread over seconds. The cost belongs in the query
plan, not in the client's patience.

**Rejected: one replay query per channel, run concurrently.** It bounds the latency and not the work:
a hundred queries from one frame still hold a hundred pool connections' worth of time.
