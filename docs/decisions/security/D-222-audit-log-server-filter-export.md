# D-222. The audit log is narrowed on the server and taken away as a file; each entry is also a log line — builds on D-26

**Decided (the owner, 2026-10-31).** The Audit log page was a newest-first list with nothing to narrow it
and no way to take it away; an owner answering "who removed that member in March" scrolled.

- **Filters**: who acted (`actorId`), one action of `AUDIT_ACTIONS` (`action`), and a window, `from`
  inclusive and `to` exclusive (`AuditQuery`, `GET …/audit`). Applied by the server inside the keyset:
  `nextCursor` pages within the filter, never over pages a client happens to hold (as D-153). **The window
  is instants, and only instants**: the client turns the days a person picked in their own zone into the
  instants those days begin (the last day's end is the next day's start), the address keeps the days, and
  the server compares UTC instants and nothing else. An instant is a range of ids, since an entry's id is
  made from the instant that is its `created_at` — so a window stays on `idx_audit_log_workspace` however
  long the trail. A window that is empty or backwards, or a moment the calendar does not have (`02-31`,
  `24:00`, which `Date.parse` would roll forward), is `400 VALIDATION_FAILED` on its field.
- **The filter lives in the page's address** (`?actor=&action=&from=&to=`), so a reload, Back and a
  shared link come back to it; only its own vocabulary is read back.
- **Download** (`GET …/audit/export?format=csv|ndjson` and the same filter): every entry the filter keeps,
  as an attachment, **streamed** five hundred rows a query by keyset, each page read only when the reader
  has taken the last — no upper bound on rows, one page of memory, no connection held between pages.
  What is written while it is read is not in it. The first page is read before the answer, so a database
  that fails at once is `500 INTERNAL`; one that fails later cuts the download off (a browser shows a
  failed download), logged by where — never a file that ends as if whole.
- **Who**: whoever reads the trail — an owner or an admin (§7.4), one rule (`requireTrailReader`) for both
  routes. **The download is on the trail** as `audit.exported`, with the format and the filter, written
  before the first byte: an export cut off was still an export; a refused one is refused before it is
  recorded.
- **CSV that a spreadsheet cannot run**: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage
  return is prefixed with `'`; cells are quoted as RFC 4180 says; UTF-8 with a byte-order mark, so `ğüşİ`
  open as themselves; CRLF. The columns are the NDJSON line's keys (`AuditExportLine`,
  `AUDIT_EXPORT_COLUMNS`), so the two files cannot say different things; the actor is named there as well
  as by id, since a file is read away from the people list.
- **Every entry of either trail is also one line of the process's structured log** (`audit entry
  recorded`): the trail, the entry, the action, who acted, the workspace, the target and the related ids
  of its metadata, and when — ids and fixed words only, never a name, an address or what anybody wrote,
  so the log stays free of personal data (`ARCHITECTURE.md` §10). Written as the row is, inside its
  transaction: a line whose request then failed is a row rolled back, and the request id joins them.
  Each process that opens the database hands its logger over as it starts; a test holds that each does,
  or says why not (the break-glass password command, whose output is one line by contract, and the
  demo's two).

**Considered and rejected.** Filtering in the browser over the pages loaded (it answers about what was
loaded, not about the trail). Filtering on `created_at` (a second index for what the id already orders).
Taking the reader's zone on the server (a second time-zone authority; the page already formats in the
reader's own). A cap on the rows a download holds (a trail longer than the cap would be cut where nobody
can see; streaming bounds memory instead). Building the file in the background like a workspace export
(D-140: a trail is small and its own owner's, and a queue is a moving part for what one request does).
Copying the metadata into the log line (it holds workspace and channel names), and writing the line after
commit (no hook for it exists; the request id already joins a line to its outcome). D-26's rejection of a
trail kept only in logs stands: the row is the record, the line a copy for watching.

**Cost of reversing.** The two query shapes fall back to `OlderPageQuery` (a client sending a filter
would be refused); the export route, its module and the `audit.exported` action (rows of it stay, said by
their name); `lines.ts` and the calls that hand it a logger; the page's filter card and its strings.
