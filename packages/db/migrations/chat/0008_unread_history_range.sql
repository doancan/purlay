-- chat/0008_unread_history_range
-- An explicit historical rewind is a UUID range in addition to the join's time
-- floor (D-282). Moving a null feed position forward to an older message would
-- otherwise read a newly delivered message whose client's UUID sorts earlier.
-- Kept as a boundary, not a foreign key: retention may remove the message it names.
ALTER TABLE channel_members ADD COLUMN unread_history_from UUID;
