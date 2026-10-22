-- 0052_setup_channels_tried
--
-- Which ways for other people to sign in the setup connected **after a try that worked** (D-179 §4.5,
-- Ruling R47): the finish is refused until one of them is, and a GitHub app or a relay that is merely
-- in the settings — seeded from the environment, say — was never tried.
--
--   * `github_tried_at`: when a GitHub app GitHub's token endpoint accepted was saved by the setup.
--   * `email_tried_at`: when a relay that took the administrator's test letter was saved by the setup.
--
-- Both are facts about what was saved, not about a claim: a claim taken over keeps them, as it keeps
-- the steps. Written only by `modules/setup/setup.ts` (`recordChannelTried`), in the transaction that
-- records the step. No data moves.

ALTER TABLE setup_state ADD COLUMN github_tried_at TIMESTAMPTZ;
ALTER TABLE setup_state ADD COLUMN email_tried_at TIMESTAMPTZ;
