-- 0068_sign_in_policy
--
-- The server's sign-in policy (D-239), two settings of the server's own beside who may sign up (0049):
--
--   * `require_two_factor`: an account that signs in with a password must turn on two-step verification
--     (D-236) before anything else answers it. FALSE, as every server was until now.
--   * `password_sign_in`: whether an address and a password sign in at all. TRUE, as every server was until
--     now. The application turns it off only while GitHub or single sign-on is connected, and refuses to
--     disconnect the last of them while it is off; the break-glass `bun run admin:reset-password` turns it on
--     again. Not a check here: a provider whose secret a rotated key cannot open is a column set but a way in
--     gone (D-179 §6), which only the application can tell — and the recovery statement `CONFIG.md` gives for
--     that case would be refused by such a check.
--
-- Rollback: `ALTER TABLE server_settings DROP COLUMN require_two_factor, DROP COLUMN password_sign_in` in a new
-- migration, after the code that reads them is gone — every server then lets a password in, alone.
--
-- The table holds one row, so this runs inside the migrator's transaction: a column with a constant default is
-- a catalogue change.

ALTER TABLE server_settings ADD COLUMN require_two_factor BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE server_settings ADD COLUMN password_sign_in BOOLEAN NOT NULL DEFAULT TRUE;
