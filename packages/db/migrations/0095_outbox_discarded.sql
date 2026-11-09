-- A fact an administrator gave up on, kept for the audit (D-288 §12): `discarded` is a state a row ends in, like `dead`, with the
-- time it ended in `finished_at` and the administrator's words on the server's trail (`server.fact_discarded`, `note`). Only the
-- constraint widens; no row changes, and a node that predates it never reads such a row (it claims `pending` and sweeps by the
-- states it knows), so the widening is safe while a roll is under way. Added NOT VALID and validated in the next statement.
--
-- Rollback: requeue or delete the discarded rows, then `ALTER TABLE outbox DROP CONSTRAINT outbox_state` and add the old one.
ALTER TABLE outbox DROP CONSTRAINT outbox_state;
ALTER TABLE outbox ADD CONSTRAINT outbox_state CHECK (state IN ('pending', 'delivered', 'dead', 'skipped', 'discarded')) NOT VALID;
ALTER TABLE outbox VALIDATE CONSTRAINT outbox_state;
