-- 0017_channel_message_notifications
--
-- A membership at `notification_level = 'all'` is told of every message in the channel by somebody
-- else (D-107). Those notifications need a kind of their own: the inbox says why a person was told,
-- and "somebody wrote in a channel you follow closely" is not a mention, a direct message or an
-- answer in a thread. It is the weakest reason — a mention of the same person on the same message
-- is still the one row they get.
--
-- Adding an enum value takes a lock on the type only for the statement and rewrites no table.

ALTER TYPE notification_type ADD VALUE 'channel_message';
