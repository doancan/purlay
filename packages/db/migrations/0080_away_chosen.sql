-- 0080_away_chosen
--
-- Away by choice (D-257, amending D-136 §1): `users.away_chosen` records that the person chose to appear
-- away. While it is true they are told to their co-members as away whatever they do, and a second tab or a
-- reconnect does not turn them active; only choosing to appear active again does. Being idle for five
-- minutes also tells a person as away, but that is never stored: it is read from the page's own words.
-- FALSE for everyone who exists now, so nothing changes for anybody until they choose.

ALTER TABLE users ADD COLUMN away_chosen BOOLEAN NOT NULL DEFAULT false;
