# D-225. A channel may keep its history longer than its workspace, never shorter — amends D-27 §1, D-139

**Decided (the owner, 2026-10-31).** Retention stays the workspace's window (D-27 §1), and a channel may
keep its own history **longer** — a window past the workspace's, or forever — **never shorter**. So no
setting here can cause more deletion than the workspace's window alone already would, and the tenet's
default (D-2) is untouched: a workspace that keeps everything keeps everything in every channel.

- **Stored as a floor, in two columns** (migration 0063): `channels.min_retention_days` — at least this
  many whole days, `NULL` for none of its own — and `channels.retain_forever`. `channels_retention_sane`
  holds the workspace's own floor of 30, never both at once, and neither on a direct message (which
  nobody configures, D-123). `NULL`/`false`, every channel before this, is "as the workspace".
- **What is kept is the longer of the two windows, computed by the purge on every batch**, never a stored
  "effective" number: the candidate reads join each message's channel and leave out a channel kept
  forever and what is inside a channel's floor, beside the workspace's `created_at < cutoff`. A workspace
  window lengthened past a channel's floor afterwards wins; one shortened leaves the channel's; one set to
  forever is not read at all. Days are 86,400 seconds, as `DAY_MS` counts the workspace's, so a clock
  change does not move the edge. I-10 says this now.
- **Only an owner sets it**, `PUT /api/channels/:channelId/retention` (`{ keepsAtLeast: null | "forever"
  | days }`), and reads it — the rule the workspace's window has (D-139 §4): keeping a team's history past
  the policy is the policy owner's call, and an admin who could not shorten it does not lengthen it
  either. A floor shorter than the workspace keeps now, or any number while it keeps everything, is
  `409 RETENTION_TOO_SHORT`, checked under the workspace row's `KEY SHARE` lock so its window cannot move
  between the check and the commit. The same setting again is answered as set and writes nothing — even
  after the workspace moved past it, so a retry of a change that succeeded succeeds (D-33). Every change is
  on the trail as `channel.retention_changed`, `from`/`to` as `workspace`, `forever` or days, named to a
  reader only when they can see the channel (#691). No frame: only an owner reads it.
- **The workspace's setting counts the channels that keep longer** (`channelsKeptLonger`), archived and
  private ones included, and Data & retention says so. A count, never which: listing them would return
  channels to an owner who may not see them (D-34).
- **Archived channels keep their setting**, and the purge still applies it; the export carries both
  columns (D-140); content erasure (D-139 §7) is untouched — it tombstones whatever is kept.
- **Concurrency and failure.** The setter shares no lock with the purge (the purge never locks a channel
  row), so a change is answered at once and is the rule from the purge's next batch: a batch that already
  read the old rule finishes by it, as if the change had come a moment later — and the only change that
  could make that batch delete what the new rule keeps is a lengthening, whose worst case is the night it
  was about to purge anyway. A batch that fails writes nothing; the trail says `incomplete`, and the next
  run finishes by the same rule.
- **Measured, no index added.** On 1,000,000 messages (10 workspaces of 20 channels, one kept forever and
  one with a year's floor each), the roots' candidate read stays a range of `idx_messages_workspace_age`
  with each row's channel found by its primary key: 1.5 ms for a batch with nothing kept ahead of it, and
  21 ms with 9,082 kept rows older than the window ahead of it. **The dimension that grows** is the number
  of messages older than the workspace's window that a channel keeps, times the batches in a night: a read
  walks past them on each batch, linearly (about 2 s a batch at a million). A cursor carried from batch to
  batch is the fix when a night's `job_runs` duration says so; not before.

**Considered and rejected.** A sentinel for forever (`0` or `-1` days — a number meaning its opposite); one
enum column with the days beside it (three states where two columns and a check do); storing the effective
window (it would be wrong the moment the workspace's changed); shorter channel windows (the owner's rule:
nothing here may delete more); an admin's call (D-139 §4 keeps the window an owner's); listing the channels
that keep longer on the workspace's page (a workspace-wide read of channels the owner may not see); a frame
on change (nobody but an owner reads it); a per-channel purge loop (one pass per channel is a query per
channel; the join keeps it one read per batch).

**Cost of reversing.** A migration dropping the two columns, the join in the purge's two candidate reads,
the module and its two routes, the count, the section in channel details, its strings and the code. Undone,
the next night purges every channel by the workspace's window: a channel set to keep longer loses what is
past it, so reversing is a decision about data, not a cleanup.
