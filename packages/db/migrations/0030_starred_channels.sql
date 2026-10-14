-- 0030_starred_channels
--
-- A person's starred channels (#489, D-132): kept in a section of their own above the rest. The
-- person's own, as their read position and their notification level are, so on their membership
-- row: when they starred it, NULL while they have not.
--
-- A nullable column with no default: a change of the catalogue only, whatever the table holds, so
-- one transaction, as 0026.

ALTER TABLE channel_members ADD COLUMN starred_at TIMESTAMPTZ;
