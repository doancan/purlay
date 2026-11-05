-- purlay: no-transaction
-- chat/0005_message_attachments_contract
--
-- RELEASE ORDER: merge and ship this only in a release AFTER the one that contains 0079 and chat/0001.
--
-- The contract half of moving an attachment's link to its message into chat (D-250, `MODULES.md` §10, steps
-- 8 and 10): `attachments.message_id` and `attachments.channel_id` go, with the keys, the check and the indexes
-- that name them. The core's table is left holding a stored object, its uploader, its workspace and whether a
-- module has claimed it (`claimed_at`), and the last foreign key from the core to chat's tables is gone.
--
-- Why it is in chat's set and not the core's: the sets are applied core first, then each module's. A core file
-- that drops the columns would run BEFORE `chat/0001`, whose backfill reads them, on every database that has not
-- run that file yet — a new install, a server that was off the module for a release — and fail there. In chat's
-- set it runs after `chat/0001` always, and a server that does not run chat keeps the columns, inert and
-- unwritten, until it does (the rows of a set that is off stay inert, D-250).
--
-- Expand, then contract. The columns were kept for one release so that the code before it, which reads and
-- writes them, found what it reads. That release has been published, nothing reads the columns, and since then
-- nothing writes them. What was in them is in `message_attachments` (backfilled by `chat/0001`, written with
-- every send since), and `claimed_at` says it is sent (0079).
--
-- A database that did not run the expand release — one that went from an older release straight to this one —
-- has columns the link table was backfilled from, but nothing wrote the table since. Dropping the columns there
-- would lose a link without a trace, so the first statement refuses: it fails loudly, with the count, if an
-- attachment names a message and the link table does not carry it the same way, or if it names a message and is
-- not claimed (the sweep would take it for an upload nobody sent). Nothing has been changed when it fails; the
-- fix is to run the release with 0079 first, and this file runs again from its top.
--
-- Rollback is the restore of the backup taken before the deploy (D-86): the release before this one refuses a
-- database that holds a migration it has no file for, as it does for every migration, and what is dropped here
-- is not put back by any statement that would know which message a file was sent with. The link table holds the
-- same facts, so nothing is lost by the drop itself.
--
-- Written outside the migrator's transaction (D-86) so that a wait for a lock gives up after ten seconds
-- instead of queueing the writers of `messages` and `attachments` behind it: dropping the keys needs a lock on
-- both tables. The indexes are dropped CONCURRENTLY, before the columns. Every statement can run again: what
-- it drops is dropped if there, and the check does not look at columns that are already gone.

SET lock_timeout = '10s';

DO $$
DECLARE
    unsafe bigint;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'attachments' AND column_name = 'message_id'
    ) THEN
        EXECUTE $check$
            SELECT count(*) FROM attachments a
            WHERE a.message_id IS NOT NULL
              AND (a.claimed_at IS NULL
                   OR NOT EXISTS (
                       SELECT 1 FROM message_attachments l
                       WHERE l.attachment_id = a.id
                         AND l.message_id = a.message_id
                         AND l.channel_id IS NOT DISTINCT FROM a.channel_id))
        $check$ INTO unsafe;
        IF unsafe > 0 THEN
            RAISE EXCEPTION
                'chat/0005 refused: % attachment(s) name a message that message_attachments does not carry (or are not claimed); run the release that contains 0079 first, so that the link is written, and this migration again',
                unsafe;
        END IF;
    END IF;
END
$$;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_message_workspace_fkey;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_message_channel_fkey;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_channel_iff_message;

DROP INDEX CONCURRENTLY IF EXISTS idx_attachments_message;
DROP INDEX CONCURRENTLY IF EXISTS idx_attachments_channel;
DROP INDEX CONCURRENTLY IF EXISTS idx_attachments_unattached;

ALTER TABLE attachments DROP COLUMN IF EXISTS channel_id;
ALTER TABLE attachments DROP COLUMN IF EXISTS message_id;

RESET lock_timeout;
